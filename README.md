# Baileys WhatsApp Service

Standalone Node.js service that runs [Baileys](https://github.com/WhiskeySockets/Baileys) and exposes a small REST API. The Lovable app calls this service over HTTPS to send WhatsApp messages, and this service POSTs incoming messages / status updates / connection changes back to the Lovable app as webhooks.

**This folder is NOT part of the Lovable app build.** Deploy it separately to Railway, Fly.io, Render, or any host that runs a long-lived Node process with a persistent volume.

---

## 1. Deploy to Railway (recommended, ~5 min)

1. Push this repo to GitHub (Railway deploys from Git).
2. Go to <https://railway.app/new> → **Deploy from GitHub repo** → pick this repo.
3. In the service settings, set **Root Directory** to `baileys-service`.
4. Railway auto-detects the `Dockerfile`. Leave build/start commands empty.
5. Under **Variables**, add:

   | Key              | Value                                                                                     |
   | ---------------- | ----------------------------------------------------------------------------------------- |
   | `BAILEYS_API_KEY` | a strong random string (`openssl rand -hex 32`)                                          |
   | `WEBHOOK_URL`     | `https://wa-reach-flow.lovable.app/api/public/webhooks/whatsapp`                         |
   | `WEBHOOK_SECRET`  | (optional) a second random string, must match the one saved in the Lovable app          |
   | `SESSION_DIR`     | `/app/sessions`                                                                          |
   | `LOG_LEVEL`       | `info`                                                                                    |

6. Under **Settings → Volumes**, mount a volume at `/app/sessions` (any size, 1 GB is plenty). This persists WhatsApp auth across restarts — without it, users must rescan the QR after every deploy.
7. Deploy. Railway gives you a public URL like `https://baileys-service-production.up.railway.app`. Copy it.
8. In the Lovable app, save two secrets:
   - `BAILEYS_SERVICE_URL` = the Railway URL from step 7
   - `BAILEYS_API_KEY` = the same key from step 5
   - (if you set one) `BAILEYS_WEBHOOK_SECRET` = same as step 5

---

## 2. REST API

All routes except `GET /health` require `Authorization: Bearer $BAILEYS_API_KEY`.

| Method | Path                       | Body                       | Purpose                                      |
| ------ | -------------------------- | -------------------------- | -------------------------------------------- |
| GET    | `/health`                  | —                          | Liveness probe (no auth).                    |
| GET    | `/instances`               | —                          | List all instances and their status.         |
| POST   | `/instances`               | `{ "id": "<account-id>" }` | Create/start an instance (idempotent).       |
| GET    | `/instances/:id`           | —                          | Status, phone, QR (if pairing).              |
| GET    | `/instances/:id/qr`        | —                          | `{ status, qr }` — qr is a PNG data URL.     |
| POST   | `/instances/:id/send`      | `{ "to", "body" }`         | Send a text message.                         |
| DELETE | `/instances/:id?wipe=true` | —                          | Logout and delete session files (default).   |

Use the WhatsApp account row's UUID as `id`.

---

## 3. Webhook payloads

The service POSTs JSON to `WEBHOOK_URL` with header `x-baileys-event: <type>`, and (if `WEBHOOK_SECRET` is set) `x-webhook-signature: <hmac-sha256 hex>` over the raw body.

```jsonc
// connection.update — instance goes to QR / open / close
{ "type": "connection.update", "instanceId": "…", "state": "qr", "qr": "data:image/png;base64,…" }
{ "type": "connection.update", "instanceId": "…", "state": "open", "phone": "9715…" }
{ "type": "connection.update", "instanceId": "…", "state": "close", "reason": "…" }

// message.upsert — inbound (or fromMe echo)
{ "type": "message.upsert", "instanceId": "…", "messageId": "3EB0…", "from": "9715…", "fromMe": false, "text": "hi", "timestamp": 1735000000 }

// message.status — delivery / read receipts
{ "type": "message.status", "instanceId": "…", "messageId": "3EB0…", "status": "delivered", "to": "9715…" }
```

The Lovable app's `/api/public/webhooks/whatsapp` route handles all three.

---

## 4. Local development

```bash
cd baileys-service
cp .env.example .env
# edit .env — at minimum set BAILEYS_API_KEY
npm install
npm run dev
```

Then in another terminal:

```bash
export KEY=your-baileys-api-key
curl -X POST http://localhost:3001/instances \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"test-1"}'
curl http://localhost:3001/instances/test-1/qr -H "Authorization: Bearer $KEY"
# open the returned data URL in a browser, scan with WhatsApp
```
