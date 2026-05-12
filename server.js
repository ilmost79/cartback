// Cartback — abandoned checkout recovery via Vapi
// Includes OAuth callback handler for Dev Dashboard apps

import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

// --- Env vars ---
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

// --- State ---
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

function addEvent(rec, kind, detail = '') {
  rec.events.push({ time: Date.now(), kind, detail });
  console.log(`[${rec.id.slice(-12)}] ${kind}${detail ? ' - ' + detail : ''}`);
}

function normalizePhone(p) {
  if (!p) return null;
  const cleaned = String(p).replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+') && cleaned.length >= 10) return '+' + cleaned;
  return cleaned || null;
}

function extractPhone(checkout) {
  return normalizePhone(
    checkout.phone ||
    checkout.customer?.phone ||
    checkout.shipping_address?.phone ||
    checkout.billing_address?.phone ||
    checkout.customer?.default_address?.phone
  );
}

function summarizeCart(checkout) {
  const items = (checkout.line_items || []).map(i => ({ qty: i.quantity, title: i.title })) || [];
  const itemsText = items.map(i => `${i.qty}x ${i.title}`).join(', ') || 'items';
  const total = parseFloat(checkout.total_price || checkout.subtotal_price || '0');
  const currency = checkout.currency || 'USD';
  return { items, itemsText, total, currency };
}

async function fetchCheckoutFromShopify(token) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.warn('Shopify API not configured');
    return null;
  }
  try {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/checkouts/${token}.json`;
    const r = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
    });
    if (!r.ok) {
      console.warn(`Shopify API ${r.status} for checkout ${token.slice(-12)}`);
      return null;
    }
    const data = await r.json();
    return data.checkout || null;
  } catch (err) {
    console.warn(`Shopify API fetch failed: ${err.message}`);
    return null;
  }
}

// Webhook verification
app.use('/webhooks/checkouts', express.raw({ type: 'application/json' }));
app.use('/webhooks/orders', express.raw({ type: 'application/json' }));

function verifyShopify(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !SHOPIFY_API_SECRET) return false;
  const computed = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(req.body).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed)); }
  catch { return false; }
}

const parseBody = req => JSON.parse(req.body.toString('utf8'));

// --- OAuth callback - exchanges code for access token ---
app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) {
    return res.send('<h1>Missing parameters</h1><p>This page expects code and shop query parameters from Shopify OAuth.</p>');
  }
  if (!SHOPIFY_CLIENT_ID) {
    return res.send('<h1>Setup needed</h1><p>Set SHOPIFY_CLIENT_ID env var in Render with your Dev Dashboard Client ID.</p>');
  }
  if (!SHOPIFY_API_SECRET) {
    return res.send('<h1>Setup needed</h1><p>Set SHOPIFY_API_SECRET env var in Render with your Client Secret.</p>');
  }
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return res.send(`<h1>OAuth exchange failed</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
    console.log(`OAuth complete for ${shop}. Token: ${data.access_token.slice(0, 20)}...`);
    res.send(`
      <html><body style="font-family: -apple-system, sans-serif; max-width: 700px; margin: 3rem auto; padding: 0 1rem;">
        <h1>✅ Installation complete!</h1>
        <p>Store: <code>${shop}</code></p>
        <h2>Your Admin API Access Token:</h2>
        <p style="background: #f5f5f3; padding: 1rem; border-radius: 6px; word-break: break-all; font-family: monospace; font-size: 14px;">${data.access_token}</p>
        <p><strong>⚠️ Copy this token now — it won't be shown again.</strong></p>
        <ol>
          <li>Copy the token</li>
          <li>Go to Render → cartback → Environment</li>
          <li>Update <code>SHOPIFY_ADMIN_TOKEN</code> with this value</li>
          <li>Save Changes</li>
        </ol>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// --- Manual test endpoint ---
app.get('/test-call/:secret', (req, res) => {
  if (!STATS_SECRET || req.params.secret !== STATS_SECRET) return res.status(404).send('not found');
  const phone = ALLOWED_PHONES[0];
  if (!phone) return res.send('No phone in ALLOWED_PHONES env var');
  const id = 'test-' + Date.now();
  const rec = {
    id,
    abandonedAt: Date.now(),
    customer: { name: 'Test Customer', email: '', phone },
    cart: { items: [], itemsText: '1x Test Tacoma Skid Plate', total: 149.99, currency: 'USD' },
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
  res.send(`Test call dispatched to ${phone}. Phone should ring in 5-15 sec. Watch dashboard.`);
});

// --- Shopify checkout webhook ---
app.post('/webhooks/checkouts', (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send('bad signature');
  res.status(200).send('ok');

  const checkout = parseBody(req);
  const token = String(checkout.token || checkout.id || '');
  if (!token) return;

  const phone = extractPhone(checkout);
  const cart = summarizeCart(checkout);
  let rec = checkouts.get(token);

  if (!rec) {
    rec = {
      id: token,
      abandonedAt: Date.now(),
      customer: {
        name: [checkout.customer?.first_name, checkout.customer?.last_name].filter(Boolean).join(' ') || 'Customer',
        email: checkout.email || checkout.customer?.email || '',
        phone: phone || null,
      },
      cart,
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
    addEvent(rec, 'abandoned', `${cart.itemsText} - ${cart.total} ${cart.currency}`);
  } else {
    rec.cart = cart;
    if (phone) rec.customer.phone = phone;
    if (checkout.customer?.first_name) {
      rec.customer.name = [checkout.customer.first_name, checkout.customer.last_name].filter(Boolean).join(' ');
    }
    if (checkout.email) rec.customer.email = checkout.email;
  }

  if (rec.status !== 'pending_call' && rec.status !== 'abandoned_no_phone' && rec.status !== 'skipped_test_mode') return;

  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => triggerCall(rec), DELAY_MS);
  rec.scheduledFor = Date.now() + DELAY_MS;
  rec.status = 'pending_call';
  addEvent(rec, 'scheduled', `timer reset, fires in ${DELAY_MIN}min${phone ? ' (phone known)' : ' (phone TBD)'}`);
});

app.post('/webhooks/orders', (req, res) => {
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
    addEvent(rec, 'recovered', `order ${order.id} after call`);
  } else {
    rec.status = 'completed_before_call';
    addEvent(rec, 'completed_before_call', `order ${order.id}`);
  }
});

async function triggerCall(rec) {
  rec.timer = null;
  rec.scheduledFor = null;

  if (!rec.customer.phone) {
    addEvent(rec, 'fetching_latest', 'no phone in cache, asking Shopify API');
    const latest = await fetchCheckoutFromShopify(rec.id);
    if (latest) {
      const apiPhone = extractPhone(latest);
      if (apiPhone) {
        rec.customer.phone = apiPhone;
        if (latest.customer?.first_name) {
          rec.customer.name = [latest.customer.first_name, latest.customer.last_name].filter(Boolean).join(' ');
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
    addEvent(rec, 'skipped_test_mode', `phone ${rec.customer.phone} not in ALLOWED_PHONES`);
    return;
  }

  try {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: rec.customer.phone },
        assistantOverrides: {
          variableValues: {
            customerName: rec.customer.name.split(' ')[0] || 'there',
            cartItems: rec.cart.itemsText,
            cartTotal: `${rec.cart.total} ${rec.cart.currency}`,
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

// Vapi webhook
app.post('/webhooks/vapi', express.json({ limit: '5mb' }), (req, res) => {
  res.status(200).send('ok');
  const msg = req.body?.message;
  if (!msg) return;
  const callId = msg.call?.id;
  if (!callId) return;
  const checkoutId = callIdToCheckout.get(callId);
  if (!checkoutId) return;
  const rec = checkouts.get(checkoutId);
  if (!rec) return;

  if (msg.type === 'status-update') {
    addEvent(rec, 'call_status', msg.status || '');
  } else if (msg.type === 'end-of-call-report') {
    const endedReason = msg.endedReason || msg.call?.endedReason || '';
    const startedAt = msg.startedAt || msg.call?.startedAt;
    const endedAt = msg.endedAt || msg.call?.endedAt;
    const duration = startedAt && endedAt
      ? Math.round((new Date(endedAt) - new Date(startedAt)) / 1000)
      : (msg.durationSeconds || 0);

    rec.endReason = endedReason;
    rec.callDuration = duration;
    rec.transcript = msg.transcript || '';
    rec.summary = msg.summary || msg.analysis?.summary || '';
    rec.recordingUrl = msg.recordingUrl || msg.stereoRecordingUrl || '';
    rec.messages = msg.messages || msg.artifact?.messages || [];

    const reasonLower = endedReason.toLowerCase();
    if (reasonLower.includes('voicemail')) {
      rec.callOutcome = 'voicemail'; rec.status = 'call_voicemail';
    } else if (reasonLower.includes('no-answer') || reasonLower.includes('did-not-answer') || reasonLower.includes('no_answer')) {
      rec.callOutcome = 'no_answer'; rec.status = 'call_no_answer';
    } else if (reasonLower.includes('busy')) {
      rec.callOutcome = 'busy'; rec.status = 'call_no_answer';
    } else if (duration > 5) {
      rec.callOutcome = 'answered';
      if (rec.status !== 'recovered_after_call') rec.status = 'call_completed';
    } else {
      rec.callOutcome = endedReason || 'unknown';
      if (rec.status !== 'recovered_after_call') rec.status = 'call_completed';
    }
    addEvent(rec, 'call_ended', `${rec.callOutcome} (${duration}s)`);
  }
});

// Stats page
function statsHandler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const records = Array.from(checkouts.values()).sort((a, b) => b.abandonedAt - a.abandonedAt);
  const todayRecords = records.filter(r =>
    new Date(r.abandonedAt).toISOString().slice(0, 10) === today
  );

  const c = {
    abandoned: todayRecords.length,
    called: todayRecords.filter(r => r.vapiCallId).length,
    answered: todayRecords.filter(r => r.callOutcome === 'answered').length,
    voicemail: todayRecords.filter(r => r.callOutcome === 'voicemail').length,
    no_answer: todayRecords.filter(r => r.callOutcome === 'no_answer').length,
    recovered: todayRecords.filter(r => r.status === 'recovered_after_call').length,
    completed_no_call: todayRecords.filter(r => r.status === 'completed_before_call').length,
    skipped: todayRecords.filter(r => r.status === 'skipped_test_mode').length,
    no_phone: todayRecords.filter(r => r.status === 'abandoned_no_phone').length,
    failed: todayRecords.filter(r => r.status === 'call_failed').length,
  };
  c.recovery_rate = c.called > 0 ? Math.round((c.recovered / c.called) * 100) : 0;
  c.revenue_recovered = todayRecords
    .filter(r => r.status === 'recovered_after_call')
    .reduce((sum, r) => sum + (r.orderTotal || r.cart.total || 0), 0);

  res.send(renderStats(c, records));
}

if (STATS_SECRET) app.get(`/stats/${STATS_SECRET}`, statsHandler);
else app.get('/stats', statsHandler);

const esc = s => String(s ?? '').replace(/[<>&"]/g, m =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

const STATUS_LABEL = {
  pending_call: { text: 'Waiting', cls: 'pending' },
  abandoned_no_phone: { text: 'Abandoned, no phone', cls: 'muted' },
  skipped_test_mode: { text: 'Skipped (test)', cls: 'muted' },
  call_failed: { text: 'Call failed', cls: 'err' },
  call_in_progress: { text: 'Calling now', cls: 'pending' },
  call_no_answer: { text: 'No answer', cls: 'warn' },
  call_voicemail: { text: 'Voicemail', cls: 'warn' },
  call_completed: { text: 'Conversation', cls: 'ok' },
  completed_before_call: { text: 'Bought (no call)', cls: 'ok' },
  recovered_after_call: { text: 'RECOVERED', cls: 'win' },
};

function fmtTime(ts) { return new Date(ts).toISOString().slice(11, 19) + ' UTC'; }
function fmtRelTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function renderTranscript(rec) {
  if (rec.messages && rec.messages.length) {
    return rec.messages
      .filter(m => m.role === 'bot' || m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const speaker = (m.role === 'bot' || m.role === 'assistant') ? 'AI' : 'Customer';
        const text = esc(m.message || m.content || '').trim();
        if (!text) return '';
        return `<div class="msg msg-${speaker.toLowerCase()}"><strong>${speaker}:</strong> ${text}</div>`;
      }).filter(Boolean).join('');
  }
  if (rec.transcript) return `<pre class="raw-transcript">${esc(rec.transcript)}</pre>`;
  return '<p class="muted">No transcript.</p>';
}

function renderRow(rec) {
  const label = STATUS_LABEL[rec.status] || { text: rec.status, cls: '' };
  const timeLeft = rec.scheduledFor ? Math.max(0, Math.round((rec.scheduledFor - Date.now()) / 1000)) : null;
  const statusExtra = rec.status === 'pending_call' && timeLeft !== null ? ` (${timeLeft}s)`
    : (rec.callDuration ? ` (${rec.callDuration}s)` : '');

  const summary = `
    <td class="time">${fmtRelTime(rec.abandonedAt)}</td>
    <td>${esc(rec.customer.name)}<br><span class="k">${esc(rec.customer.phone || '(no phone)')}</span></td>
    <td>${esc(rec.cart.itemsText)}<br><span class="muted">${rec.cart.total} ${rec.cart.currency}</span></td>
    <td><span class="badge ${label.cls}">${label.text}${statusExtra}</span>${rec.orderTotal ? `<br><span class="muted">order: ${rec.orderTotal}</span>` : ''}</td>
  `;
  const events = rec.events.map(e =>
    `<div class="event"><span class="k">${fmtTime(e.time)}</span> <strong>${esc(e.kind)}</strong> ${esc(e.detail)}</div>`
  ).join('');
  const hasCall = rec.vapiCallId || rec.transcript || (rec.messages && rec.messages.length);

  return `
    <tr class="row-main">${summary}<td><a href="#" onclick="this.closest('tr').nextElementSibling.classList.toggle('open');return false">details</a></td></tr>
    <tr class="row-detail"><td colspan="5"><div class="detail-box">
      <div class="dgrid">
        <div><strong>Abandoned</strong><br>${new Date(rec.abandonedAt).toISOString().replace('T',' ').slice(0,19)} UTC</div>
        <div><strong>Email</strong><br>${esc(rec.customer.email) || '<span class="muted">(none)</span>'}</div>
        ${rec.recoveryUrl ? `<div><strong>Recovery link</strong><br><a href="${esc(rec.recoveryUrl)}" target="_blank">checkout url</a></div>` : ''}
        ${rec.vapiCallId ? `<div><strong>Vapi call ID</strong><br><span class="k">${esc(rec.vapiCallId)}</span></div>` : ''}
        ${rec.callDuration ? `<div><strong>Duration</strong><br>${rec.callDuration}s</div>` : ''}
        ${rec.endReason ? `<div><strong>Ended because</strong><br>${esc(rec.endReason)}</div>` : ''}
        ${rec.recordingUrl ? `<div><strong>Recording</strong><br><a href="${esc(rec.recordingUrl)}" target="_blank">listen</a></div>` : ''}
        ${rec.orderId ? `<div><strong>Order</strong><br>#${esc(rec.orderId)} - ${rec.orderTotal} ${rec.cart.currency}</div>` : ''}
      </div>
      ${rec.summary ? `<div class="ai-summary"><strong>Call summary:</strong> ${esc(rec.summary)}</div>` : ''}
      ${hasCall ? `<div class="transcript-box"><strong>Transcript:</strong>${renderTranscript(rec)}</div>` : ''}
      <details class="event-log"><summary>Event log (${rec.events.length})</summary>${events}</details>
    </div></td></tr>`;
}

function renderStats(c, records) {
  const modeLabel = MODE === 'live' ? 'LIVE - calling everyone' : 'TEST - only calling allowed phones';
  const modeClass = MODE === 'live' ? 'live' : 'test';
  const allowedDisplay = ALLOWED_PHONES.length
    ? ALLOWED_PHONES.map(esc).join(', ')
    : '<em>none set - no calls will go out</em>';
  const apiStatus = (SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN)
    ? `<span class="ok">connected</span>`
    : `<span class="err">NOT CONFIGURED</span>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cartback stats</title>
<meta http-equiv="refresh" content="15">
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1200px; margin: 1.5rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 20px; margin: 0 0 .5rem; }
  h2 { font-size: 15px; margin: 1.5rem 0 .5rem; color: #555; font-weight: 500; }
  .mode { padding: .6rem .8rem; border-radius: 6px; margin-bottom: .5rem; font-weight: 500; }
  .mode.test { background: #fdf3d8; color: #6a5300; }
  .mode.live { background: #fde0e0; color: #8a1f1f; }
  .mode small { font-weight: 400; display: block; margin-top: .25rem; }
  .api { font-size: 12px; color: #888; margin-bottom: 1rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .5rem; margin-bottom: 1rem; }
  .stat { background: #f5f5f3; padding: .55rem .7rem; border-radius: 6px; }
  .stat .n { font-size: 20px; font-weight: 500; line-height: 1.1; }
  .stat .l { font-size: 11px; color: #666; margin-top: .15rem; }
  .stat.hero { background: #e8f4ea; }
  .stat.hero .n { color: #0a7a3a; }
  .ok { color: #0a7a3a; } .warn { color: #8a6d00; } .err { color: #b03030; } .win { color: #0a7a3a; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #666; font-weight: 500; }
  td.time { color: #888; white-space: nowrap; }
  .k { font-family: ui-monospace, monospace; font-size: 12px; color: #666; }
  .muted { color: #999; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: #eee; }
  .badge.pending { background: #fef0c8; color: #8a6d00; }
  .badge.ok { background: #d8efde; color: #0a7a3a; }
  .badge.warn { background: #fde6c8; color: #8a4d00; }
  .badge.err { background: #fbd8d8; color: #b03030; }
  .badge.win { background: #0a7a3a; color: white; font-weight: 500; }
  .badge.muted { background: #eee; color: #888; }
  .row-detail { display: none; }
  .row-detail.open { display: table-row; }
  .row-detail td { background: #fafaf8; padding: 0; }
  .detail-box { padding: .8rem 1rem; }
  .dgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .6rem; font-size: 12px; margin-bottom: .8rem; }
  .ai-summary { padding: .5rem .7rem; background: #eef4ff; border-radius: 4px; margin: .5rem 0; font-size: 13px; }
  .transcript-box { background: white; padding: .6rem .8rem; border-radius: 4px; border: 1px solid #eee; margin: .5rem 0; max-height: 400px; overflow-y: auto; }
  .msg { margin: .3rem 0; font-size: 13px; }
  .msg-ai strong { color: #4a5fc7; }
  .msg-customer strong { color: #8a4400; }
  .raw-transcript { white-space: pre-wrap; font-size: 12px; color: #444; }
  .event-log { margin-top: .5rem; font-size: 12px; color: #666; }
  .event-log summary { cursor: pointer; color: #888; }
  .event { padding: 2px 0; }
  a { color: #2a5fc7; }
</style></head><body>
<h1>Cartback stats</h1>
<div class="mode ${modeClass}">${modeLabel}<small>Allowed phones: ${allowedDisplay}</small></div>
<div class="api">Shopify API: ${apiStatus}</div>

<h2>Today (UTC)</h2>
<div class="stats">
  <div class="stat"><div class="n">${c.abandoned}</div><div class="l">abandoned</div></div>
  <div class="stat"><div class="n">${c.called}</div><div class="l">calls made</div></div>
  <div class="stat"><div class="n">${c.answered}</div><div class="l">answered</div></div>
  <div class="stat"><div class="n">${c.no_answer + c.voicemail}</div><div class="l">missed/voicemail</div></div>
  <div class="stat hero"><div class="n">${c.recovered}</div><div class="l">RECOVERED</div></div>
  <div class="stat hero"><div class="n">${c.recovery_rate}%</div><div class="l">recovery rate</div></div>
  <div class="stat hero"><div class="n">${c.revenue_recovered.toFixed(0)}</div><div class="l">revenue recovered</div></div>
  <div class="stat"><div class="n">${c.completed_no_call}</div><div class="l">paid before call</div></div>
  <div class="stat"><div class="n">${c.no_phone}</div><div class="l">no phone left</div></div>
  <div class="stat"><div class="n">${c.skipped}</div><div class="l">skipped (test)</div></div>
  <div class="stat"><div class="n">${c.failed}</div><div class="l">errors</div></div>
</div>

<h2>Abandoned checkouts (${records.length} total)</h2>
${records.length === 0 ? '<p class="muted">No abandoned checkouts yet.</p>' : `
<table><tr><th>When</th><th>Customer</th><th>Cart</th><th>Outcome</th><th></th></tr>
${records.slice(0, 100).map(renderRow).join('')}</table>`}

<p class="muted" style="margin-top: 2rem; font-size: 12px;">Auto-refresh every 15s. State is in-memory and resets on deploy.</p>
</body></html>`;
}

app.get('/', (req, res) =>
  res.send(`cartback up - mode=${MODE} - ${checkouts.size} tracked\nStats: ${STATS_SECRET ? '/stats/' + STATS_SECRET : '/stats'}\nShopify API: ${SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN ? 'connected' : 'NOT CONFIGURED'}`)
);

app.listen(PORT, () => {
  console.log(`cartback listening on :${PORT} (mode=${MODE})`);
  if (MODE === 'test') {
    console.log(`allowed phones: ${ALLOWED_PHONES.length ? ALLOWED_PHONES.join(', ') : '(none)'}`);
  }
  console.log(`Shopify API: ${SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN ? 'connected to ' + SHOPIFY_STORE_DOMAIN : 'NOT configured'}`);
  console.log(`OAuth callback: ${SHOPIFY_CLIENT_ID && SHOPIFY_API_SECRET ? 'ready' : 'NOT ready (set SHOPIFY_CLIENT_ID)'}`);
  if (!STATS_SECRET) console.warn('WARNING: STATS_SECRET not set');
});
