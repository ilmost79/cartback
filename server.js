// Cartback - abandoned checkout recovery via Vapi
// Complete file with OAuth callback handler

import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
const DELAY_MIN = parseInt(process.env.ABANDON_DELAY_MINUTES || '2');
const DELAY_MS = DELAY_MIN * 60 * 1000;
const MODE = (process.env.MODE || 'test').toLowerCase();
const ALLOWED_PHONES = (process.env.ALLOWED_PHONES || '')
  .split(',').map(p => p.trim()).filter(Boolean);
const STATS_SECRET = process.env.STATS_SECRET || '';

const checkouts = new Map();
const callIdToCheckout = new Map();
const CHECKOUTS_MAX = 500;

function trimCheckouts() {
  if (checkouts.size <= CHECKOUTS_MAX) return;
  const oldest = Array.from(checkouts.entries())
    .sort((a, b) => a[1].abandonedAt - b[1].abandonedAt)[0];
  if (oldest) {
    if (oldest[1].vapiCallId) callIdToCheckout.delete(oldest[1].vapiCallId);
    checkouts.delete(oldest[0]);
  }
}

function addEvent(rec, kind, detail) {
  if (!detail) detail = '';
  rec.events.push({ time: Date.now(), kind: kind, detail: detail });
  console.log('[' + rec.id.slice(-12) + '] ' + kind + (detail ? ' - ' + detail : ''));
}

function normalizePhone(p) {
  if (!p) return null;
  const cleaned = String(p).replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+') && cleaned.length >= 10) return '+' + cleaned;
  return cleaned || null;
}

function extractPhone(checkout) {
  const phoneRaw = checkout.phone
    || (checkout.customer && checkout.customer.phone)
    || (checkout.shipping_address && checkout.shipping_address.phone)
    || (checkout.billing_address && checkout.billing_address.phone)
    || (checkout.customer && checkout.customer.default_address && checkout.customer.default_address.phone);
  return normalizePhone(phoneRaw);
}

function summarizeCart(checkout) {
  const lineItems = checkout.line_items || [];
  const items = lineItems.map(function(i) { return { qty: i.quantity, title: i.title }; });
  const itemsText = items.map(function(i) { return i.qty + 'x ' + i.title; }).join(', ') || 'items';
  const total = parseFloat(checkout.total_price || checkout.subtotal_price || '0');
  const currency = checkout.currency || 'USD';
  return { items: items, itemsText: itemsText, total: total, currency: currency };
}

async function fetchCheckoutFromShopify(token) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) return null;
  try {
    const url = 'https://' + SHOPIFY_STORE_DOMAIN + '/admin/api/2025-01/checkouts/' + token + '.json';
    const r = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
    });
    if (!r.ok) {
      console.warn('Shopify API ' + r.status + ' for checkout ' + token.slice(-12));
      return null;
    }
    const data = await r.json();
    return data.checkout || null;
  } catch (err) {
    console.warn('Shopify API fetch failed: ' + err.message);
    return null;
  }
}

app.use('/webhooks/checkouts', express.raw({ type: 'application/json' }));
app.use('/webhooks/orders', express.raw({ type: 'application/json' }));

function verifyShopify(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !SHOPIFY_API_SECRET) return false;
  const computed = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(req.body).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed));
  } catch (e) {
    return false;
  }
}

function parseBody(req) {
  return JSON.parse(req.body.toString('utf8'));
}

// OAuth callback handler
app.get('/auth/callback', async function(req, res) {
  const code = req.query.code;
  const shop = req.query.shop;
  if (!code || !shop) {
    return res.send('<h1>Missing parameters</h1><p>Need code and shop query parameters.</p>');
  }
  if (!SHOPIFY_CLIENT_ID) {
    return res.send('<h1>Setup needed</h1><p>Set SHOPIFY_CLIENT_ID env var in Render.</p>');
  }
  if (!SHOPIFY_API_SECRET) {
    return res.send('<h1>Setup needed</h1><p>Set SHOPIFY_API_SECRET env var in Render.</p>');
  }
  try {
    const r = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_API_SECRET,
        code: code,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return res.send('<h1>OAuth exchange failed</h1><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
    console.log('OAuth complete for ' + shop);
    res.send('<html><body style="font-family: sans-serif; max-width: 700px; margin: 3rem auto; padding: 0 1rem;"><h1>Installation complete!</h1><p>Store: <code>' + shop + '</code></p><h2>Your Admin API Access Token:</h2><p style="background: #f5f5f3; padding: 1rem; border-radius: 6px; word-break: break-all; font-family: monospace; font-size: 14px;">' + data.access_token + '</p><p><strong>Copy this token now - it wont be shown again.</strong></p><ol><li>Copy the token</li><li>Render dashboard cartback Environment</li><li>Update SHOPIFY_ADMIN_TOKEN with this value</li><li>Save Changes</li></ol></body></html>');
  } catch (err) {
    res.status(500).send('<h1>Error</h1><p>' + err.message + '</p>');
  }
});

// Test endpoint
app.get('/test-call/:secret', function(req, res) {
  if (!STATS_SECRET || req.params.secret !== STATS_SECRET) return res.status(404).send('not found');
  const phone = ALLOWED_PHONES[0];
  if (!phone) return res.send('No phone in ALLOWED_PHONES');
  const id = 'test-' + Date.now();
  const rec = {
    id: id,
    abandonedAt: Date.now(),
    customer: { name: 'Test Customer', email: '', phone: phone },
    cart: { items: [], itemsText: '1x Test Product', total: 149.99, currency: 'USD' },
    recoveryUrl: '',
    status: 'pending_call',
    events: [],
    timer: null,
    scheduledFor: null,
    vapiCallId: null,
  };
  checkouts.set(id, rec);
  addEvent(rec, 'test_call_triggered', 'manual test');
  triggerCall(rec);
  res.send('Test call dispatched to ' + phone);
});

app.post('/webhooks/checkouts', function(req, res) {
  if (!verifyShopify(req)) return res.status(401).send('bad signature');
  res.status(200).send('ok');
  const checkout = parseBody(req);
  const token = String(checkout.token || checkout.id || '');
  if (!token) return;
  const phone = extractPhone(checkout);
  const cart = summarizeCart(checkout);
  let rec = checkouts.get(token);
  if (!rec) {
    const firstName = (checkout.customer && checkout.customer.first_name) || '';
    const lastName = (checkout.customer && checkout.customer.last_name) || '';
    const fullName = (firstName + ' ' + lastName).trim() || 'Customer';
    rec = {
      id: token,
      abandonedAt: Date.now(),
      customer: {
        name: fullName,
        email: checkout.email || (checkout.customer && checkout.customer.email) || '',
        phone: phone || null,
      },
      cart: cart,
      recoveryUrl: checkout.abandoned_checkout_url || '',
      status: 'pending_call',
      events: [],
      timer: null,
      scheduledFor: null,
      vapiCallId: null,
      callOutcome: null,
      callDuration: null,
      transcript: '',
      summary: '',
      recordingUrl: '',
      endReason: '',
      orderId: null,
      orderCompletedAt: null,
      orderTotal: null,
    };
    checkouts.set(token, rec);
    trimCheckouts();
    addEvent(rec, 'abandoned', cart.itemsText + ' - ' + cart.total + ' ' + cart.currency);
  } else {
    rec.cart = cart;
    if (phone) rec.customer.phone = phone;
    if (checkout.customer && checkout.customer.first_name) {
      rec.customer.name = (checkout.customer.first_name + ' ' + (checkout.customer.last_name || '')).trim();
    }
    if (checkout.email) rec.customer.email = checkout.email;
  }
  if (rec.status !== 'pending_call' && rec.status !== 'abandoned_no_phone' && rec.status !== 'skipped_test_mode') return;
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(function() { triggerCall(rec); }, DELAY_MS);
  rec.scheduledFor = Date.now() + DELAY_MS;
  rec.status = 'pending_call';
  addEvent(rec, 'scheduled', 'timer reset, fires in ' + DELAY_MIN + 'min' + (phone ? ' (phone known)' : ' (phone TBD)'));
});

app.post('/webhooks/orders', function(req, res) {
  if (!verifyShopify(req)) return res.status(401).send('bad signature');
  res.status(200).send('ok');
  const order = parseBody(req);
  const token = String(order.checkout_token || order.checkout_id || '');
  if (!token) return;
  const rec = checkouts.get(token);
  if (!rec) return;
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  rec.orderId = order.id;
  rec.orderCompletedAt = Date.now();
  rec.orderTotal = parseFloat(order.total_price || '0');
  if (rec.vapiCallId) {
    rec.status = 'recovered_after_call';
    addEvent(rec, 'recovered', 'order ' + order.id + ' after call');
  } else {
    rec.status = 'completed_before_call';
    addEvent(rec, 'completed_before_call', 'order ' + order.id);
  }
});

async function triggerCall(rec) {
  rec.timer = null;
  rec.scheduledFor = null;
  if (!rec.customer.phone) {
    addEvent(rec, 'fetching_latest', 'asking Shopify API');
    const latest = await fetchCheckoutFromShopify(rec.id);
    if (latest) {
      const apiPhone = extractPhone(latest);
      if (apiPhone) {
        rec.customer.phone = apiPhone;
        if (latest.customer && latest.customer.first_name) {
          rec.customer.name = (latest.customer.first_name + ' ' + (latest.customer.last_name || '')).trim();
        }
        if (latest.email) rec.customer.email = latest.email;
        rec.cart = summarizeCart(latest);
        addEvent(rec, 'phone_found_via_api', apiPhone);
      } else {
        addEvent(rec, 'api_no_phone', 'Shopify API also has no phone');
      }
    }
  }
  if (!rec.customer.phone) {
    rec.status = 'abandoned_no_phone';
    addEvent(rec, 'abandoned_no_phone', 'no phone available');
    return;
  }
  if (MODE === 'test' && !ALLOWED_PHONES.includes(rec.customer.phone)) {
    rec.status = 'skipped_test_mode';
    addEvent(rec, 'skipped_test_mode', 'phone ' + rec.customer.phone + ' not allowed');
    return;
  }
  try {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + VAPI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: rec.customer.phone },
        assistantOverrides: {
          variableValues: {
            customerName: rec.customer.name.split(' ')[0] || 'there',
            cartItems: rec.cart.itemsText,
            cartTotal: rec.cart.total + ' ' + rec.cart.currency,
            recoveryUrl: rec.recoveryUrl,
          },
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      rec.status = 'call_failed';
      addEvent(rec, 'call_failed', JSON.stringify(data).slice(0, 200));
      return;
    }
    rec.vapiCallId = data.id;
    rec.status = 'call_in_progress';
    callIdToCheckout.set(data.id, rec.id);
    addEvent(rec, 'call_dispatched', data.id);
  } catch (err) {
    rec.status = 'call_failed';
    addEvent(rec, 'call_failed', err.message);
  }
}

app.post('/webhooks/vapi', express.json({ limit: '5mb' }), function(req, res) {
  res.status(200).send('ok');
  const msg = req.body && req.body.message;
  if (!msg) return;
  const callId = msg.call && msg.call.id;
  if (!callId) return;
  const checkoutId = callIdToCheckout.get(callId);
  if (!checkoutId) return;
  const rec = checkouts.get(checkoutId);
  if (!rec) return;
  if (msg.type === 'status-update') {
    addEvent(rec, 'call_status', msg.status || '');
  } else if (msg.type === 'end-of-call-report') {
    const endedReason = msg.endedReason || (msg.call && msg.call.endedReason) || '';
    const startedAt = msg.startedAt || (msg.call && msg.call.startedAt);
    const endedAt = msg.endedAt || (msg.call && msg.call.endedAt);
    let duration = 0;
    if (startedAt && endedAt) {
      duration = Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
    } else if (msg.durationSeconds) {
      duration = msg.durationSeconds;
    }
    rec.endReason = endedReason;
    rec.callDuration = duration;
    rec.transcript = msg.transcript || '';
    rec.summary = msg.summary || (msg.analysis && msg.analysis.summary) || '';
    rec.recordingUrl = msg.recordingUrl || msg.stereoRecordingUrl || '';
    rec.messages = msg.messages || (msg.artifact && msg.artifact.messages) || [];
    const reasonLower = endedReason.toLowerCase();
    if (reasonLower.indexOf('voicemail') >= 0) {
      rec.callOutcome = 'voicemail';
      rec.status = 'call_voicemail';
    } else if (reasonLower.indexOf('no-answer') >= 0 || reasonLower.indexOf('did-not-answer') >= 0) {
      rec.callOutcome = 'no_answer';
      rec.status = 'call_no_answer';
    } else if (reasonLower.indexOf('busy') >= 0) {
      rec.callOutcome = 'busy';
      rec.status = 'call_no_answer';
    } else if (duration > 5) {
      rec.callOutcome = 'answered';
      if (rec.status !== 'recovered_after_call') rec.status = 'call_completed';
    } else {
      rec.callOutcome = endedReason || 'unknown';
      if (rec.status !== 'recovered_after_call') rec.status = 'call_completed';
    }
    addEvent(rec, 'call_ended', rec.callOutcome + ' (' + duration + 's)');
  }
});

function statsHandler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const records = Array.from(checkouts.values()).sort(function(a, b) { return b.abandonedAt - a.abandonedAt; });
  const todayRecords = records.filter(function(r) {
    return new Date(r.abandonedAt).toISOString().slice(0, 10) === today;
  });
  const c = {
    abandoned: todayRecords.length,
    called: todayRecords.filter(function(r) { return r.vapiCallId; }).length,
    answered: todayRecords.filter(function(r) { return r.callOutcome === 'answered'; }).length,
    voicemail: todayRecords.filter(function(r) { return r.callOutcome === 'voicemail'; }).length,
    no_answer: todayRecords.filter(function(r) { return r.callOutcome === 'no_answer'; }).length,
    recovered: todayRecords.filter(function(r) { return r.status === 'recovered_after_call'; }).length,
    completed_no_call: todayRecords.filter(function(r) { return r.status === 'completed_before_call'; }).length,
    skipped: todayRecords.filter(function(r) { return r.status === 'skipped_test_mode'; }).length,
    no_phone: todayRecords.filter(function(r) { return r.status === 'abandoned_no_phone'; }).length,
    failed: todayRecords.filter(function(r) { return r.status === 'call_failed'; }).length,
  };
  c.recovery_rate = c.called > 0 ? Math.round((c.recovered / c.called) * 100) : 0;
  c.revenue_recovered = todayRecords
    .filter(function(r) { return r.status === 'recovered_after_call'; })
    .reduce(function(sum, r) { return sum + (r.orderTotal || r.cart.total || 0); }, 0);
  res.send(renderStats(c, records));
}

if (STATS_SECRET) {
  app.get('/stats/' + STATS_SECRET, statsHandler);
} else {
  app.get('/stats', statsHandler);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, function(m) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m];
  });
}

const STATUS_LABEL = {
  pending_call: 'Waiting',
  abandoned_no_phone: 'Abandoned, no phone',
  skipped_test_mode: 'Skipped (test)',
  call_failed: 'Call failed',
  call_in_progress: 'Calling now',
  call_no_answer: 'No answer',
  call_voicemail: 'Voicemail',
  call_completed: 'Conversation',
  completed_before_call: 'Bought (no call)',
  recovered_after_call: 'RECOVERED',
};

function renderStats(c, records) {
  const modeLabel = MODE === 'live' ? 'LIVE - calling everyone' : 'TEST - only calling allowed phones';
  const allowedDisplay = ALLOWED_PHONES.length ? ALLOWED_PHONES.join(', ') : '(none)';
  const apiStatus = (SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN) ? 'connected' : 'NOT CONFIGURED';
  const rowsHtml = records.slice(0, 100).map(function(rec) {
    const label = STATUS_LABEL[rec.status] || rec.status;
    return '<tr><td>' + esc(new Date(rec.abandonedAt).toISOString().slice(11, 19)) + '</td><td>' + esc(rec.customer.name) + ' ' + esc(rec.customer.phone || '(no phone)') + '</td><td>' + esc(rec.cart.itemsText) + '</td><td>' + esc(label) + '</td></tr>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Cartback stats</title><meta http-equiv="refresh" content="15"><style>body { font: 14px sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; } table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: .4rem; border-bottom: 1px solid #eee; } .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .5rem; margin: 1rem 0; } .stat { background: #f5f5f3; padding: .6rem; border-radius: 4px; } .mode { padding: .5rem; background: #fdf3d8; border-radius: 4px; margin-bottom: 1rem; }</style></head><body><h1>Cartback stats</h1><div class="mode">' + modeLabel + '<br><small>Allowed: ' + esc(allowedDisplay) + ' / Shopify API: ' + apiStatus + '</small></div><div class="stats"><div class="stat"><strong>' + c.abandoned + '</strong><br>abandoned</div><div class="stat"><strong>' + c.called + '</strong><br>calls made</div><div class="stat"><strong>' + c.recovered + '</strong><br>RECOVERED</div><div class="stat"><strong>' + c.no_phone + '</strong><br>no phone</div><div class="stat"><strong>' + c.skipped + '</strong><br>skipped</div><div class="stat"><strong>' + c.failed + '</strong><br>errors</div></div><h2>Recent</h2><table><tr><th>Time</th><th>Customer</th><th>Cart</th><th>Status</th></tr>' + rowsHtml + '</table></body></html>';
}

app.get('/', function(req, res) {
  res.send('cartback up - mode=' + MODE + ' - ' + checkouts.size + ' tracked\nStats: ' + (STATS_SECRET ? '/stats/' + STATS_SECRET : '/stats') + '\nShopify API: ' + ((SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN) ? 'connected' : 'NOT CONFIGURED'));
});

app.listen(PORT, function() {
  console.log('cartback listening on :' + PORT + ' (mode=' + MODE + ')');
  if (MODE === 'test') {
    console.log('allowed phones: ' + (ALLOWED_PHONES.length ? ALLOWED_PHONES.join(', ') : '(none)'));
  }
  console.log('Shopify API: ' + ((SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN) ? 'connected to ' + SHOPIFY_STORE_DOMAIN : 'NOT configured'));
  console.log('OAuth callback: ' + ((SHOPIFY_CLIENT_ID && SHOPIFY_API_SECRET) ? 'ready' : 'NOT ready'));
  if (!STATS_SECRET) console.warn('WARNING: STATS_SECRET not set');
});
