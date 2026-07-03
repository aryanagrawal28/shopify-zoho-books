import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const config = {
  port: Number(process.env.PORT ?? 3000),
  shopifyWebhookSecret: requiredEnv("SHOPIFY_WEBHOOK_SECRET"),
  zohoAccountsDomain: optionalEnv("ZOHO_ACCOUNTS_DOMAIN", "https://accounts.zoho.com"),
  zohoApiDomain: optionalEnv("ZOHO_API_DOMAIN", "https://www.zohoapis.com"),
  zohoClientId: requiredEnv("ZOHO_CLIENT_ID"),
  zohoClientSecret: requiredEnv("ZOHO_CLIENT_SECRET"),
  zohoRefreshToken: requiredEnv("ZOHO_REFRESH_TOKEN"),
  zohoOrganizationId: requiredEnv("ZOHO_ORGANIZATION_ID"),
  zohoDefaultItemId: requiredEnv("ZOHO_DEFAULT_ITEM_ID"),
  zohoDefaultTaxId: optionalEnv("ZOHO_DEFAULT_TAX_ID"),
  zohoInclusiveTax: parseBoolean(optionalEnv("ZOHO_INCLUSIVE_TAX", "true")),
  defaultPaymentTerms: Number(optionalEnv("ZOHO_DEFAULT_PAYMENT_TERMS", "0"))
};

const processedWebhookIds = new Set();

const server = http.createServer(async (req, res) => {
  log("Incoming request", {
    method: req.method,
    url: req.url,
    topic: req.headers["x-shopify-topic"],
    shop: req.headers["x-shopify-shop-domain"],
    webhookId: req.headers["x-shopify-webhook-id"]
  });

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhooks/shopify/orders-create") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const rawBody = await readRawBody(req);
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const webhookId = req.headers["x-shopify-webhook-id"];

  if (!verifyShopifyHmac(rawBody, hmac)) {
    log("Rejected Shopify webhook: invalid HMAC", {
      topic: req.headers["x-shopify-topic"],
      shop: req.headers["x-shopify-shop-domain"],
      webhookId
    });
    sendJson(res, 401, { error: "Invalid Shopify HMAC" });
    return;
  }

  if (webhookId && processedWebhookIds.has(webhookId)) {
    log("Duplicate Shopify webhook ignored", { webhookId });
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }

  if (webhookId) {
    processedWebhookIds.add(webhookId);
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    log("Rejected Shopify webhook: invalid JSON", { webhookId });
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  log("Accepted Shopify order webhook", {
    webhookId,
    orderId: order.id,
    orderName: order.name,
    email: order.email ?? order.customer?.email
  });

  sendJson(res, 200, { ok: true });

  processShopifyOrder(order).catch((error) => {
    console.error("Failed to create Zoho invoice", {
      shopifyOrderId: order.id,
      orderName: order.name,
      error
    });
    log("Failed to create Zoho invoice", {
      shopifyOrderId: order.id,
      orderName: order.name,
      error: error.message
    });
  });
});

server.listen(config.port, () => {
  console.log(`Shopify to Zoho Books webhook server listening on :${config.port}`);
  console.log("Loaded config", {
    zohoAccountsDomain: config.zohoAccountsDomain,
    zohoApiDomain: config.zohoApiDomain,
    zohoClientId: redact(config.zohoClientId),
    zohoClientSecret: redact(config.zohoClientSecret),
    zohoRefreshToken: redact(config.zohoRefreshToken),
    zohoOrganizationId: config.zohoOrganizationId,
    zohoDefaultItemId: config.zohoDefaultItemId,
    zohoDefaultTaxId: config.zohoDefaultTaxId,
    zohoInclusiveTax: config.zohoInclusiveTax
  });
});

async function processShopifyOrder(order) {
  const accessToken = await getZohoAccessToken();
  const customerId = await findOrCreateZohoCustomer(accessToken, order);
  const invoicePayload = mapShopifyOrderToZohoInvoice(order, customerId);
  const invoice = await createZohoInvoice(accessToken, invoicePayload);

  console.log("Created Zoho invoice", {
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    zohoInvoiceId: invoice.invoice?.invoice_id,
    zohoInvoiceNumber: invoice.invoice?.invoice_number
  });
  log("Created Zoho invoice", {
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    zohoInvoiceId: invoice.invoice?.invoice_id,
    zohoInvoiceNumber: invoice.invoice?.invoice_number
  });
}

async function getZohoAccessToken() {
  const url = new URL("/oauth/v2/token", config.zohoAccountsDomain);
  url.searchParams.set("refresh_token", config.zohoRefreshToken);
  url.searchParams.set("client_id", config.zohoClientId);
  url.searchParams.set("client_secret", config.zohoClientSecret);
  url.searchParams.set("grant_type", "refresh_token");

  const response = await fetch(url, { method: "POST" });
  const body = await response.json();

  if (!response.ok || !body.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(body)}`);
  }

  return body.access_token;
}

async function findOrCreateZohoCustomer(accessToken, order) {
  const email = order.email ?? order.customer?.email;

  if (email) {
    const existingContact = await findZohoContactByEmail(accessToken, email);

    if (existingContact) {
      return existingContact.contact_id;
    }
  }

  const contact = await createZohoContact(accessToken, order);
  return contact.contact.contact_id;
}

async function findZohoContactByEmail(accessToken, email) {
  const url = zohoBooksUrl("/books/v3/contacts");
  url.searchParams.set("email", email);
  url.searchParams.set("contact_type", "customer");

  const body = await zohoFetch(accessToken, url);
  return body.contacts?.[0] ?? null;
}

async function createZohoContact(accessToken, order) {
  const customer = order.customer ?? {};
  const billing = order.billing_address ?? {};
  const shipping = order.shipping_address ?? billing;
  const firstName = customer.first_name ?? billing.first_name ?? "";
  const lastName = customer.last_name ?? billing.last_name ?? "";
  const email = order.email ?? customer.email ?? billing.email;
  const phone = billing.phone ?? shipping.phone ?? order.phone ?? customer.phone;

  const payload = {
    contact_name: [firstName, lastName].filter(Boolean).join(" ") || email || `Shopify Customer ${order.id}`,
    contact_type: "customer",
    customer_sub_type: "individual",
    currency_code: order.currency,
    contact_persons: [
      {
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        mobile: phone,
        is_primary_contact: true
      }
    ].filter((person) => person.email || person.phone || person.first_name || person.last_name),
    billing_address: mapAddress(billing),
    shipping_address: mapAddress(shipping)
  };

  return zohoFetch(accessToken, zohoBooksUrl("/books/v3/contacts"), {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function createZohoInvoice(accessToken, payload) {
  return zohoFetch(accessToken, zohoBooksUrl("/books/v3/invoices"), {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

function mapShopifyOrderToZohoInvoice(order, customerId) {
  const lineItems = order.line_items.map((item) => {
    return withoutUndefined({
      item_id: getZohoItemIdForShopifyLineItem(item),
      tax_id: config.zohoDefaultTaxId || undefined,
      name: item.title,
      description: [item.variant_title, `Shopify line item ${item.id}`].filter(Boolean).join(" - "),
      rate: money(item.price),
      quantity: Number(item.quantity)
    });
  });
  const totalDiscount = getShopifyOrderDiscountAmount(order);
  const discountNote = getShopifyDiscountNote(order, totalDiscount);

  return withoutUndefined({
    customer_id: customerId,
    date: (order.created_at ?? new Date().toISOString()).slice(0, 10),
    reference_number: order.name ?? String(order.id),
    payment_terms: config.defaultPaymentTerms,
    discount: totalDiscount > 0 ? totalDiscount : undefined,
    discount_type: totalDiscount > 0 ? "entity_level" : undefined,
    is_inclusive_tax: config.zohoInclusiveTax,
    is_discount_before_tax: true,
    line_items: lineItems,
    shipping_charge: money(order.total_shipping_price_set?.shop_money?.amount ?? 0),
    notes: [
      `Created automatically from Shopify order ${order.name ?? order.id}`,
      discountNote,
      config.zohoInclusiveTax ? "Shopify product prices are treated as GST-inclusive." : null
    ]
      .filter(Boolean)
      .join("\n")
  });
}

function getZohoItemIdForShopifyLineItem(_item) {
  // Replace this with a SKU/product/variant lookup once your Zoho item catalog is mapped.
  return config.zohoDefaultItemId;
}

async function zohoFetch(accessToken, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  const body = await response.json();

  if (!response.ok || body.code !== 0) {
    throw new Error(`Zoho API request failed: ${JSON.stringify(body)}`);
  }

  return body;
}

function zohoBooksUrl(pathname) {
  const url = new URL(pathname, config.zohoApiDomain);
  url.searchParams.set("organization_id", config.zohoOrganizationId);
  return url;
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (typeof hmacHeader !== "string") {
    return false;
  }

  const digest = crypto.createHmac("sha256", config.shopifyWebhookSecret).update(rawBody).digest("base64");
  const actual = Buffer.from(hmacHeader, "base64");
  const expected = Buffer.from(digest, "base64");

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function mapAddress(address) {
  return {
    attention: [address.first_name, address.last_name].filter(Boolean).join(" "),
    address: address.address1,
    street2: address.address2,
    city: address.city,
    state: address.province,
    state_code: address.province_code,
    zip: address.zip,
    country: address.country,
    phone: address.phone
  };
}

function getShopifyLineItemDiscountAmount(item) {
  const allocationDiscount = (item.discount_allocations ?? []).reduce((total, allocation) => {
    return total + money(allocation.amount_set?.shop_money?.amount ?? allocation.amount);
  }, 0);

  if (allocationDiscount > 0) {
    return roundMoney(allocationDiscount);
  }

  return roundMoney(money(item.total_discount_set?.shop_money?.amount ?? item.total_discount));
}

function getShopifyOrderDiscountAmount(order) {
  return roundMoney(
    money(
      order.current_total_discounts_set?.shop_money?.amount ??
        order.total_discounts_set?.shop_money?.amount ??
        order.current_total_discounts ??
        order.total_discounts
    )
  );
}

function getShopifyDiscountNote(order, totalDiscount) {
  if (totalDiscount <= 0) {
    return null;
  }

  const codeDetails = (order.discount_codes ?? [])
    .map((discountCode) => {
      return [discountCode.code, discountCode.type, discountCode.amount].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const applicationDetails = (order.discount_applications ?? [])
    .map((discountApplication) => {
      return [
        discountApplication.code ?? discountApplication.title,
        discountApplication.type,
        discountApplication.value ? `${discountApplication.value}${discountApplication.value_type === "percentage" ? "%" : ""}` : null
      ]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean);
  const details = [...new Set([...codeDetails, ...applicationDetails])];

  return [`Shopify discount total: ${totalDiscount}`, details.length ? `Discount details: ${details.join(", ")}` : null]
    .filter(Boolean)
    .join("\n");
}

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name, defaultValue) {
  return process.env[name]?.trim() || defaultValue;
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function log(message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    ...details
  };

  console.log(message, details);
  fs.appendFileSync("webhook.log", `${JSON.stringify(entry)}\n`);
}

function redact(value) {
  if (!value) {
    return "missing";
  }

  if (value.length <= 10) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 5)}...${value.slice(-4)} (${value.length} chars)`;
}
