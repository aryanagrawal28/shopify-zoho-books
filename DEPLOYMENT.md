# Continuous Webhook Deployment

Localtunnel is only for testing. For live Shopify webhooks, deploy this Node app to an always-on server with HTTPS, then replace the Shopify webhook URL with the permanent production URL.

The fastest managed testing path is Render Free, Railway, Fly.io, or any VPS. This repo includes:

- `render.yaml` for a Render web service
- `Dockerfile` for Docker/VPS deployment
- `/health` endpoint for uptime checks

## Production Checklist

1. Deploy this repo to a Node-capable host or VPS.
2. Set the same `.env` values as production environment variables on the host.
3. Start the app with:

```bash
npm start
```

4. Confirm the production health endpoint:

```text
https://YOUR_PRODUCTION_DOMAIN/health
```

It should return:

```json
{"ok":true}
```

5. Update Shopify's `Order creation` webhook URL:

```text
https://YOUR_PRODUCTION_DOMAIN/webhooks/shopify/orders-create
```

6. Create one test order and confirm Zoho Books creates an invoice.

## Required Environment Variables

```text
PORT=3000
SHOPIFY_WEBHOOK_SECRET=
ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.in
ZOHO_API_DOMAIN=https://www.zohoapis.in
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_ORGANIZATION_ID=
ZOHO_DEFAULT_ITEM_ID=
ZOHO_DEFAULT_TAX_ID=
ZOHO_DEFAULT_PAYMENT_TERMS=0
```

## Render Option

1. Push this repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Use `render.yaml` if creating from a Blueprint.
4. Add the secret environment variables from your local `.env`.
5. Deploy.
6. Open:

```text
https://YOUR_RENDER_SERVICE.onrender.com/health
```

7. Update Shopify's `Order creation` webhook URL:

```text
https://YOUR_RENDER_SERVICE.onrender.com/webhooks/shopify/orders-create
```

## VPS Option

On a VPS, run the app with a process manager such as PM2 so it restarts after crashes or server reboots:

```bash
npm install -g pm2
pm2 start "npm start" --name shopify-zoho-books
pm2 save
pm2 startup
```

Put Nginx or another reverse proxy in front of the app so Shopify can reach it at an HTTPS URL.

## Important

- Do not use localtunnel for production.
- Render Free web services spin down after idle time, so use it for testing or low-stakes automation. For truly continuous webhook reliability, use a paid always-on instance or a VPS.
- Do not commit `.env`.
- Keep only one Shopify `orders/create` webhook active for this service to avoid duplicate invoices.
- If you regenerate any secret/token, update the production environment and restart the app.
