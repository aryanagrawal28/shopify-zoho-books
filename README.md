# Shopify to Zoho Books Invoices

This is a small webhook service that creates a Zoho Books invoice whenever Shopify sends an `orders/create` webhook.

## 1. Configure Zoho

Create a Zoho API client and generate a refresh token with offline access. The useful scopes are:

```text
ZohoBooks.invoices.CREATE
ZohoBooks.invoices.READ
ZohoBooks.contacts.READ
ZohoBooks.contacts.CREATE
ZohoBooks.items.READ
ZohoBooks.settings.READ
ZohoBooks.creditnotes.CREATE
ZohoBooks.creditnotes.READ
```

Find your Zoho Books organization ID from Zoho Books or the Organizations API, then copy `.env.example` to `.env` and fill in the Zoho values.

Use the right Zoho data center:

```text
US/global: ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.com
US/global: ZOHO_API_DOMAIN=https://www.zohoapis.com

India: ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.in
India: ZOHO_API_DOMAIN=https://www.zohoapis.in
```

## 2. Configure Shopify

Create a Shopify app or use an existing custom app. Subscribe to these webhooks:

```text
orders/create
orders/updated
orders/cancelled
refunds/create
```

Point each webhook to:

```text
https://YOUR_DOMAIN/webhooks/shopify/orders-create
```

The path can use the event name for clarity, for example:

```text
https://YOUR_DOMAIN/webhooks/shopify/orders-updated
https://YOUR_DOMAIN/webhooks/shopify/orders-cancelled
https://YOUR_DOMAIN/webhooks/shopify/refunds-create
```

Set `SHOPIFY_WEBHOOK_SECRET` to your Shopify app client secret. This service verifies `X-Shopify-Hmac-SHA256` before processing the order.

For reliable `refunds/create` handling, also set `SHOPIFY_ADMIN_ACCESS_TOKEN` and `SHOPIFY_SHOP_DOMAIN` in Render. Shopify refund webhooks can arrive with only `order_id`; the Admin API token lets the app fetch the Shopify order name (for example `#6480`) and match the original Zoho invoice.

## 3. Map Shopify products to Zoho items

Edit `mapShopifyOrderToZohoInvoice` in `src/server.js`.

Zoho invoice line items need a Zoho `item_id`. The starter uses `ZOHO_DEFAULT_ITEM_ID` for every Shopify line item so you can test the integration quickly. For cleaner accounting, replace that with a mapping from Shopify `variant_id`, `product_id`, or `sku` to the matching Zoho item.

Shopify order discounts are sent to Zoho as an invoice-level discount so the Zoho invoice total matches the Shopify paid total. Discount codes and discount application details are added to the Zoho invoice notes.

By default, `ZOHO_INCLUSIVE_TAX=true`, so Shopify shipping tax is treated as inclusive while product lines are not taxed again in Zoho. For example, Shopify product totals and discounts stay at the paid Shopify amount, and any Shopify shipping GST is shown inside the shipping charge instead of being added on top.

Shopify refunds and cancellations create Zoho credit notes associated with the original invoice, preserving the invoice record while deducting the appropriate amount. The app finds the original invoice using the Shopify order number saved as Zoho `reference_number`.

## 4. Run locally

```bash
npm run start:local
```

For local webhook testing, expose the server with a tunnel and register the tunnel URL in Shopify.

## Production notes

This starter acknowledges Shopify quickly, then processes the order. For production, replace the in-memory dedupe set with a database table keyed by `X-Shopify-Webhook-Id` or Shopify order ID, and process invoices through a durable queue.

For continuous webhook operation, deploy this app to an always-on host. See `DEPLOYMENT.md`.
