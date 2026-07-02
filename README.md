# Shopify to Zoho Books Invoices

This is a small webhook service that creates a Zoho Books invoice whenever Shopify sends an `orders/create` webhook.

## 1. Configure Zoho

Create a Zoho API client and generate a refresh token with offline access. The useful scopes are:

```text
ZohoBooks.invoices.CREATE
ZohoBooks.contacts.READ
ZohoBooks.contacts.CREATE
ZohoBooks.items.READ
ZohoBooks.settings.READ
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

Create a Shopify app or use an existing custom app. Subscribe to the `orders/create` webhook and point it to:

```text
https://YOUR_DOMAIN/webhooks/shopify/orders-create
```

Set `SHOPIFY_WEBHOOK_SECRET` to your Shopify app client secret. This service verifies `X-Shopify-Hmac-SHA256` before processing the order.

## 3. Map Shopify products to Zoho items

Edit `mapShopifyOrderToZohoInvoice` in `src/server.js`.

Zoho invoice line items need a Zoho `item_id`. The starter uses `ZOHO_DEFAULT_ITEM_ID` for every Shopify line item so you can test the integration quickly. For cleaner accounting, replace that with a mapping from Shopify `variant_id`, `product_id`, or `sku` to the matching Zoho item.

Shopify line-item discounts are sent to Zoho as item-level `discount_amount` values. Discount codes and discount application details are added to the Zoho invoice notes.

By default, `ZOHO_INCLUSIVE_TAX=true`, so Shopify prices are treated as GST-inclusive. For example, a ₹100 Shopify line with 5% GST remains ₹100 total in Zoho, with tax calculated inside that price instead of being added on top.

## 4. Run locally

```bash
npm run start:local
```

For local webhook testing, expose the server with a tunnel and register the tunnel URL in Shopify.

## Production notes

This starter acknowledges Shopify quickly, then processes the order. For production, replace the in-memory dedupe set with a database table keyed by `X-Shopify-Webhook-Id` or Shopify order ID, and process invoices through a durable queue.

For continuous webhook operation, deploy this app to an always-on host. See `DEPLOYMENT.md`.
