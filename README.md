# Cartback — abandoned checkout recovery with Vapi

Minimal Shopify app that calls customers via AI voice agent after 2 minutes of checkout inactivity, with a full-lifecycle dashboard showing what happened on every call.

**Defaults to test mode** — won't call anyone unless you put their phone on the allow list. Safe to install on a real store before going live.

---

## What you see on the dashboard

For every abandoned checkout, you can see in one place:

- When the cart was abandoned
- Who (name, email, phone)
- What's in the cart and the total
- Whether a call was triggered (or why it was skipped)
- Outcome: answered, no answer, voicemail, error
- Full conversation transcript with AI lines and customer lines
- AI's own summary of the call (if you enable Vapi's summary feature)
- A link to the recording (if Vapi recorded it)
- Whether the customer eventually came back and completed the order
- If they did — how much, and whether it happened AFTER the call (= recovered) or before (= no credit to us)
- A complete event log per checkout for debugging

Top of the page: today's counters including **recovery rate** and **revenue recovered** — the metrics that actually matter for proving ROI.

---

## Setup — ~30 min from zero

### 1. Vapi (~10 min)

1. Sign up at https://vapi.ai, add billing.
2. Create an **assistant** — paste the prompt from `vapi-prompt.md` into System Prompt. Pick a voice.
3. **Important: set the assistant's Server URL** to your app's Vapi webhook endpoint. In Vapi dashboard → your assistant → Advanced → Server URL → paste:
   ```
   https://YOUR_RENDER_URL/webhooks/vapi
   ```
   This is how Vapi tells your app what happened on each call (status, transcript, recording).
4. While in Advanced settings, you may also want to enable **End of Call Report** (it's on by default) and optionally **AI Summary**.
5. Buy a **phone number** in Vapi. Note the Phone Number ID.
6. From Vapi: copy API Key, Assistant ID, Phone Number ID.

### 2. Deploy (~5 min)

Same as before — push to GitHub, connect to Render, set env vars. Required:

```
VAPI_API_KEY=...
VAPI_ASSISTANT_ID=...
VAPI_PHONE_NUMBER_ID=...
SHOPIFY_API_SECRET=...        (fill in after step 3)
MODE=test
ALLOWED_PHONES=+15551234567    (your phone)
STATS_SECRET=anyrandomstring
```

After deploying, note your Render URL. Go back to Vapi step 1.3 above and set the Server URL to `https://YOUR_RENDER_URL/webhooks/vapi`.

### 3. Shopify Partner app (~10 min)

1. Create a Partner account at https://partners.shopify.com.
2. Apps → Create app manually. Name "Cartback". App URL: your Render URL.
3. From API credentials, copy **API secret key** → set as `SHOPIFY_API_SECRET` in Render → redeploy.
4. Distribution → Custom distribution → enter client's store domain → install link generated.

### 4. Register Shopify webhooks (~5 min)

```bash
curl -X POST "https://STORE.myshopify.com/admin/api/2025-01/webhooks.json" \
  -H "X-Shopify-Access-Token: ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"topic":"checkouts/update","address":"YOUR_URL/webhooks/checkouts","format":"json"}}'

curl -X POST "https://STORE.myshopify.com/admin/api/2025-01/webhooks.json" \
  -H "X-Shopify-Access-Token: ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"topic":"orders/create","address":"YOUR_URL/webhooks/orders","format":"json"}}'
```

---

## Testing on the real client store, safely

`MODE=test` means real customers' abandoned checkouts get tracked but never called. Only phones in `ALLOWED_PHONES` actually get called.

Run these on the client's real store with your own phone in the allow list:

| Test | What to do | What dashboard should show |
|---|---|---|
| Happy path | Abandon checkout with your phone | "Waiting" → "Calling now" → "Conversation" with full transcript |
| Recovery | Abandon, get the call, then return to the recovery URL and complete order | Status flips to **RECOVERED**, revenue counter increments |
| Order before call | Abandon, then complete order within 2 min | "Bought (no call)" — no call should fire |
| No answer | Abandon with your phone, but don't pick up | Status: "No answer" |
| Real customer abandons | (Happens naturally) | Tracked in dashboard, status: "Skipped (test)" — no call made |

Watch the dashboard live during testing. Each row has a **details** link that expands to show the full transcript and event log.

---

## Going live

When test scenarios pass: in Render → Environment → change `MODE` from `test` to `live`. Redeploy. Banner turns red. Real customers start getting called.

To stop: flip `MODE` back to `test`.

---

## Status meanings

- **Waiting** — checkout is in the 2-min timer. Will call when it expires (unless customer completes order first).
- **Calling now** — Vapi call dispatched, waiting to hear back.
- **Conversation** — call connected, the AI spoke with the customer. Click details to see transcript.
- **No answer** — phone rang out.
- **Voicemail** — call went to voicemail.
- **Call failed** — Vapi rejected the call (bad phone format, etc.) — check details.
- **Bought (no call)** — customer completed the order before the 2-min timer fired. We didn't call.
- **RECOVERED** — customer completed the order AFTER our call. This is what we want to maximize.
- **Skipped (test)** — test mode, phone wasn't on the allow list.

---

## Limits of this MVP

- State is in-memory — restart/redeploy clears all history and pending timers
- No SMS fallback yet (next thing to add)
- No opt-in widget (you need this before going live for TCPA compliance)
- No long-term storage — if you want historical analytics, add Postgres
- Vapi webhook isn't signed — anyone who guesses your URL could POST fake data. Add Vapi signature verification before going public.

## What to build next

1. Vapi webhook signature verification (5 min)
2. SMS fallback via Twilio when call goes unanswered (1 hr)
3. Postgres to persist checkouts across restarts (1-2 hr)
4. Shopify Checkout Extension for opt-in checkbox (TCPA, 1 hr)
5. Persistent job queue with BullMQ + Redis (half a day)
