import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const APP_VERSION = "invoice-v18-visible-discount-row";

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
const shopifyOrderInvoiceCache = new Map();
let zohoTaxCatalogPromise;

const server = http.createServer(async (req, res) => {
  log("Incoming request", {
    method: req.method,
    url: req.url,
    topic: req.headers["x-shopify-topic"],
    shop: req.headers["x-shopify-shop-domain"],
    webhookId: req.headers["x-shopify-webhook-id"]
  });

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, version: APP_VERSION });
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/webhooks/shopify/")) {
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

  let order;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    log("Rejected Shopify webhook: invalid JSON", { webhookId });
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const topic = req.headers["x-shopify-topic"];

  log("Accepted Shopify webhook", {
    webhookId,
    topic,
    resourceId: order.id,
    orderId: order.order_id ?? order.id,
    orderName: order.name ?? order.order_name ?? order.order?.name,
    email: order.email ?? order.customer?.email ?? order.order?.email
  });

  if (webhookId && processedWebhookIds.has(webhookId)) {
    log("Duplicate Shopify webhook ignored", { webhookId });
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }

  try {
    await processShopifyWebhook(topic, order, getShopifyWebhookContext(req));
    if (webhookId) {
      processedWebhookIds.add(webhookId);
    }
    sendJson(res, 200, { ok: true, processed: true });
  } catch (error) {
    console.error("Failed to process Shopify webhook", {
      topic,
      shopifyResourceId: order.id,
      shopifyOrderId: order.order_id ?? order.id,
      orderName: order.name ?? order.order_name ?? order.order?.name,
      error
    });
    log("Failed to process Shopify webhook", {
      topic,
      shopifyResourceId: order.id,
      shopifyOrderId: order.order_id ?? order.id,
      orderName: order.name ?? order.order_name ?? order.order?.name,
      error: error.message
    });
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Shopify to Zoho Books webhook server listening on :${config.port}`);
  console.log("Loaded config", {
    version: APP_VERSION,
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

function getShopifyWebhookContext(req) {
  return {
    shopDomain: req.headers["x-shopify-shop-domain"]
  };
}

async function processShopifyWebhook(topic, payload, context = {}) {
  if (topic === "orders/create") {
    await processShopifyOrder(payload);
    return;
  }

  if (topic === "orders/cancelled") {
    await processShopifyOrderCancellation(payload, context);
    return;
  }

  if (topic === "orders/updated") {
    await processShopifyOrderUpdate(payload, context);
    return;
  }

  if (topic === "refunds/create") {
    await processShopifyRefund(payload, context);
    return;
  }

  log("Ignored Shopify webhook topic", { topic });
}

async function processShopifyOrder(order) {
  const accessToken = await getZohoAccessToken();
  const existingInvoice = await findZohoInvoiceForShopifyPayload(accessToken, order);

  if (existingInvoice) {
    cacheShopifyInvoice(order.id, {
      invoiceId: existingInvoice.invoice_id,
      referenceNumber: existingInvoice.reference_number
    });
    log("Zoho invoice already exists for Shopify order", {
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      zohoInvoiceId: existingInvoice.invoice_id,
      zohoInvoiceNumber: existingInvoice.invoice_number
    });
    return;
  }

  const customerId = await findOrCreateZohoCustomer(accessToken, order);
  const invoicePayload = await mapShopifyOrderToZohoInvoice(accessToken, order, customerId);
  log("Prepared Zoho invoice payload", {
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    shopifyTotal: getShopifyOrderTotal(order),
    mappedTotal: getZohoPayloadTotal(invoicePayload),
    shippingCharge: invoicePayload.shipping_charge ?? 0,
    adjustment: invoicePayload.adjustment ?? 0,
    lineItemsTotal: getZohoPayloadLineItemsTotal(invoicePayload)
  });
  const invoice = await createZohoInvoice(accessToken, invoicePayload);
  cacheShopifyInvoice(order.id, {
    invoiceId: invoice.invoice?.invoice_id,
    referenceNumber: invoice.invoice?.reference_number ?? invoicePayload.reference_number
  });

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

async function processShopifyOrderUpdate(order, context = {}) {
  const refunds = order.refunds ?? [];

  if (order.cancelled_at || order.cancel_reason) {
    if (refunds.length > 0) {
      for (const refund of refunds) {
        await processShopifyRefund({ ...refund, order }, context);
      }
      return;
    }

    await processShopifyOrderCancellation(order, context);
    return;
  }

  if (refunds.length === 0) {
    log("Shopify order update has no refunds to process", {
      shopifyOrderId: order.id,
      orderName: order.name
    });
    return;
  }

  for (const refund of refunds) {
    await processShopifyRefund({ ...refund, order }, context);
  }
}

async function processShopifyOrderCancellation(order, context = {}) {
  const refunds = order.refunds ?? [];

  if (refunds.length > 0) {
    for (const refund of refunds) {
      await processShopifyRefund({ ...refund, order }, context);
    }
    return;
  }

  const accessToken = await getZohoAccessToken();
  const invoice = await findZohoInvoiceForShopifyPayload(accessToken, order);

  if (!invoice) {
    throw new Error(`Could not find Zoho invoice for cancelled Shopify order ${order.name ?? order.id}`);
  }

  const creditReference = getShopifyCancellationCreditReference(order);
  const existingCreditNote = await findZohoCreditNoteByReference(accessToken, creditReference);

  if (existingCreditNote) {
    log("Zoho cancellation credit note already exists for Shopify order", {
      shopifyOrderId: order.id,
      orderName: order.name,
      creditReference,
      zohoCreditNoteId: existingCreditNote.creditnote_id,
      zohoCreditNoteNumber: existingCreditNote.creditnote_number
    });
    return;
  }

  const creditAmount = roundMoney(money(invoice.total ?? invoice.balance ?? 0));

  if (creditAmount <= 0) {
    log("Zoho invoice has no positive amount to credit for cancelled Shopify order", {
      shopifyOrderId: order.id,
      orderName: order.name,
      zohoInvoiceId: invoice.invoice_id
    });
    return;
  }

  const creditNote = await createZohoCreditNote(
    accessToken,
    mapShopifyCancellationToZohoCreditNote(order, invoice, creditAmount, creditReference)
  );
  const creditNoteId = creditNote.creditnote?.creditnote_id;
  const amountToApply = roundMoney(Math.min(creditAmount, Math.max(money(invoice.balance ?? 0), 0)));

  if (creditNoteId && amountToApply > 0) {
    await applyZohoCreditNoteToInvoice(accessToken, creditNoteId, invoice.invoice_id, amountToApply);
  }

  log("Created Zoho credit note for cancelled Shopify order", {
    shopifyOrderId: order.id,
    orderName: order.name,
    creditReference,
    creditAmount,
    appliedAmount: amountToApply,
    zohoInvoiceId: invoice.invoice_id,
    zohoInvoiceNumber: invoice.invoice_number,
    zohoCreditNoteNumber: creditNote.creditnote?.creditnote_number
  });
}

async function processShopifyRefund(refund, context = {}) {
  const refundAmount = getShopifyRefundAmount(refund);

  if (refundAmount <= 0) {
    log("Shopify refund has no positive amount to credit", {
      refundId: refund.id,
      orderId: refund.order_id ?? refund.order?.id
    });
    return;
  }

  const enrichedRefund = refund;
  const accessToken = await getZohoAccessToken();
  const invoice = await findZohoInvoiceForShopifyPayload(accessToken, enrichedRefund.order ?? enrichedRefund);

  if (!invoice) {
    if (!hasShopifyOrderNameReference(enrichedRefund.order ?? enrichedRefund)) {
      log("Shopify refund webhook missing order name; waiting for orders/updated webhook", {
        refundId: refund.id,
        orderId: refund.order_id ?? refund.order?.id
      });
      return;
    }

    throw new Error(`Could not find Zoho invoice for Shopify refund ${refund.id}`);
  }

  const creditReference = getShopifyRefundReference(refund);
  const existingCreditNote = await findZohoCreditNoteByReference(accessToken, creditReference);

  if (existingCreditNote) {
    log("Zoho credit note already exists for Shopify refund", {
      refundId: refund.id,
      creditReference,
      zohoCreditNoteId: existingCreditNote.creditnote_id,
      zohoCreditNoteNumber: existingCreditNote.creditnote_number
    });
    return;
  }

  const creditAmount = refundAmount;
  const creditNote = await createZohoCreditNote(
    accessToken,
    mapShopifyRefundToZohoCreditNote(enrichedRefund, invoice, creditAmount, creditReference)
  );
  const creditNoteId = creditNote.creditnote?.creditnote_id;
  const amountToApply = roundMoney(Math.min(creditAmount, Math.max(money(invoice.balance ?? 0), 0)));

  if (creditNoteId && amountToApply > 0) {
    await applyZohoCreditNoteToInvoice(accessToken, creditNoteId, invoice.invoice_id, amountToApply);
  }

  log("Created Zoho credit note for Shopify refund", {
    refundId: refund.id,
    creditReference,
    refundAmount,
    appliedAmount: amountToApply,
    shopifyOrderId: refund.order_id ?? refund.order?.id,
    orderName: enrichedRefund.order?.name,
    zohoInvoiceId: invoice.invoice_id,
    zohoCreditNoteId: creditNoteId,
    zohoCreditNoteNumber: creditNote.creditnote?.creditnote_number
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
    const existingContacts = await findZohoContactsByEmail(accessToken, email);
    const matchingContact = existingContacts.find((contact) => {
      return doesZohoContactMatchShopifyOrderPlaceOfSupply(contact, order);
    });

    if (matchingContact) {
      return matchingContact.contact_id;
    }

    if (existingContacts.length > 0) {
      log("Creating new Zoho contact due to place of supply mismatch", {
        email,
        shopifyOrderId: order.id,
        orderName: order.name,
        matchedContactIds: existingContacts.map((contact) => contact.contact_id),
        orderProvinceCode: order.shipping_address?.province_code ?? order.billing_address?.province_code ?? null,
        orderCountryCode: order.shipping_address?.country_code ?? order.billing_address?.country_code ?? null
      });
    }
  }

  const contact = await createZohoContact(accessToken, order);
  return contact.contact.contact_id;
}

async function findZohoContactsByEmail(accessToken, email) {
  const url = zohoBooksUrl("/books/v3/contacts");
  url.searchParams.set("email", email);
  url.searchParams.set("contact_type", "customer");

  const body = await zohoFetch(accessToken, url);
  return body.contacts ?? [];
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
    contact_name: getZohoContactName(firstName, lastName, email, order.id),
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

function getZohoContactName(firstName, lastName, email, orderId) {
  const name = [firstName, lastName].filter(Boolean).join(" ");

  if (email) {
    return name ? `${name} - ${email}` : email;
  }

  return name || `Shopify Customer ${orderId}`;
}

async function createZohoInvoice(accessToken, payload) {
  return zohoFetch(accessToken, zohoBooksUrl("/books/v3/invoices"), {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function createZohoCreditNote(accessToken, payload) {
  const url = zohoBooksUrl("/books/v3/creditnotes");

  if (payload.invoice_id) {
    url.searchParams.set("invoice_id", payload.invoice_id);
  }

  return zohoFetch(accessToken, url, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function applyZohoCreditNoteToInvoice(accessToken, creditNoteId, invoiceId, amount) {
  return zohoFetch(accessToken, zohoBooksUrl(`/books/v3/creditnotes/${creditNoteId}/invoices`), {
    method: "POST",
    body: JSON.stringify({
      invoice_id: invoiceId,
      amount_applied: amount,
      invoices: [
        {
          invoice_id: invoiceId,
          amount_applied: amount
        }
      ]
    })
  });
}

async function mapShopifyOrderToZohoInvoice(accessToken, order, customerId) {
  const totalDiscount = getShopifyOrderDiscountAmount(order);
  const shippingTotal = getShopifyShippingTotal(order);
  const shippingTaxTotal = getShopifyShippingTaxAmount(order);
  const lineItemsSource = order.line_items ?? [];
  const shopifyTotal = getShopifyOrderTotal(order);
  const lineItems = await Promise.all(lineItemsSource.map(async (item) => {
    const quantity = Math.max(Number(item.quantity) || 0, 1);
    const taxDetails = await getZohoTaxForShopifyTaxLines(accessToken, order, item.tax_lines ?? [], "product");

    return withoutUndefined({
      item_id: getZohoItemIdForShopifyLineItem(item),
      tax_id: taxDetails.taxId || undefined,
      name: item.title,
      description: [item.variant_title, `Shopify line item ${item.id}`].filter(Boolean).join(" - "),
      rate: money(item.price),
      quantity
    });
  }));
  const discountNote = getShopifyDiscountNote(order, totalDiscount);
  const mappedTotal = getMappedInvoiceTotal(lineItems, shippingTotal, totalDiscount);
  const totalAdjustment = shopifyTotal > 0 ? roundMoney(shopifyTotal - mappedTotal) : 0;

  return withoutUndefined({
    customer_id: customerId,
    date: (order.created_at ?? new Date().toISOString()).slice(0, 10),
    reference_number: order.name ?? String(order.id),
    place_of_supply: getShopifyOrderStateCode(order) || undefined,
    payment_terms: config.defaultPaymentTerms,
    discount: totalDiscount > 0 ? totalDiscount : undefined,
    discount_type: totalDiscount > 0 ? "entity_level" : undefined,
    is_inclusive_tax: config.zohoInclusiveTax,
    is_discount_before_tax: false,
    line_items: lineItems,
    shipping_charge: shippingTotal,
    adjustment: totalAdjustment !== 0 ? totalAdjustment : undefined,
    adjustment_description: totalAdjustment !== 0 ? "Shopify total adjustment" : undefined,
    notes: [
      `Created automatically from Shopify order ${order.name ?? order.id}`,
      discountNote,
      shippingTaxTotal > 0 ? `Shopify shipping GST included: ${shippingTaxTotal}` : null,
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

async function getZohoTaxForShopifyTaxLines(accessToken, order, taxLines, source) {
  const defaultTaxId = config.zohoDefaultTaxId || null;
  const taxCatalog = await getZohoTaxCatalog(accessToken);
  const taxRate =
    getShopifyTaxRateForTaxLines(taxLines) ??
    getShopifyTaxRateForOrder(order) ??
    getZohoTaxRateById(taxCatalog.taxes, defaultTaxId);

  if (taxRate === null) {
    return {
      taxId: defaultTaxId,
      taxRate: null
    };
  }

  const taxSpecification = isInterstateShopifyOrder(order, taxCatalog.organizationStateCode) ? "inter" : "intra";
  const matchingTax = taxCatalog.taxes.find((tax) => {
    return tax.tax_specification === taxSpecification && isCloseTaxRate(tax.tax_percentage, taxRate);
  });

  if (matchingTax) {
    log("Selected Zoho tax for Shopify tax source", {
      orderName: order.name,
      shopifyOrderId: order.id,
      source,
      shopifyTaxTitles: (taxLines ?? []).map((taxLine) => taxLine.title).filter(Boolean),
      selectedTaxId: matchingTax.tax_id,
      selectedTaxName: matchingTax.tax_name,
      selectedTaxRate: matchingTax.tax_percentage,
      selectedTaxSpecification: taxSpecification
    });
    return {
      taxId: matchingTax.tax_id,
      taxRate: roundMoney(money(matchingTax.tax_percentage))
    };
  }

  log("Falling back to default Zoho tax", {
    orderName: order.name,
    shopifyOrderId: order.id,
    source,
    shopifyTaxTitles: (taxLines ?? []).map((taxLine) => taxLine.title).filter(Boolean),
    requestedTaxRate: taxRate,
    requestedTaxSpecification: taxSpecification,
    fallbackTaxId: defaultTaxId
  });

  return {
    taxId: defaultTaxId,
    taxRate: getZohoTaxRateById(taxCatalog.taxes, defaultTaxId) ?? taxRate
  };
}

function getZohoTaxRateById(taxes, taxId) {
  if (!taxId) {
    return null;
  }

  const matchingTax = taxes.find((tax) => String(tax.tax_id) === String(taxId));
  return matchingTax ? roundMoney(money(matchingTax.tax_percentage)) : null;
}

function isCloseTaxRate(zohoTaxPercentage, shopifyTaxRate) {
  return Math.abs(roundMoney(money(zohoTaxPercentage)) - roundMoney(shopifyTaxRate)) <= 0.1;
}

function mapShopifyRefundToZohoCreditNote(refund, invoice, amount, referenceNumber) {
  const order = refund.order ?? {};

  return withoutUndefined({
    customer_id: invoice.customer_id,
    invoice_id: invoice.invoice_id,
    invoices: [
      {
        invoice_id: invoice.invoice_id,
        amount
      }
    ],
    date: (refund.created_at ?? new Date().toISOString()).slice(0, 10),
    reference_number: referenceNumber,
    is_inclusive_tax: config.zohoInclusiveTax,
    line_items: [
      withoutUndefined({
        item_id: config.zohoDefaultItemId,
        invoice_id: invoice.invoice_id,
        name: `Shopify refund ${refund.id}`,
        description: [`Refund for Shopify order ${order.name ?? refund.order_id ?? invoice.reference_number}`, refund.note]
          .filter(Boolean)
          .join(" - "),
        rate: amount,
        quantity: 1
      })
    ],
    notes: `Created automatically from Shopify refund ${refund.id} for order ${order.name ?? refund.order_id ?? invoice.reference_number}`
  });
}

function mapShopifyCancellationToZohoCreditNote(order, invoice, amount, referenceNumber) {
  return withoutUndefined({
    customer_id: invoice.customer_id,
    invoice_id: invoice.invoice_id,
    invoices: [
      {
        invoice_id: invoice.invoice_id,
        amount
      }
    ],
    date: (order.cancelled_at ?? order.updated_at ?? new Date().toISOString()).slice(0, 10),
    reference_number: referenceNumber,
    is_inclusive_tax: config.zohoInclusiveTax,
    line_items: [
      withoutUndefined({
        item_id: config.zohoDefaultItemId,
        invoice_id: invoice.invoice_id,
        name: `Shopify cancellation ${order.name ?? order.id}`,
        description: [`Cancellation credit for Shopify order ${order.name ?? order.id}`, order.cancel_reason]
          .filter(Boolean)
          .join(" - "),
        rate: amount,
        quantity: 1
      })
    ],
    notes: `Created automatically for cancelled Shopify order ${order.name ?? order.id}`
  });
}

async function findZohoInvoiceForShopifyPayload(accessToken, payload) {
  const cached = shopifyOrderInvoiceCache.get(String(payload.order_id ?? payload.id));

  if (cached?.invoiceId) {
    return getZohoInvoice(accessToken, cached.invoiceId);
  }

  for (const reference of getShopifyInvoiceReferenceCandidates(payload)) {
    const invoice = await findZohoInvoiceByReference(accessToken, reference);

    if (invoice) {
      return invoice;
    }
  }

  return null;
}

async function getZohoInvoice(accessToken, invoiceId) {
  const body = await zohoFetch(accessToken, zohoBooksUrl(`/books/v3/invoices/${invoiceId}`));
  return body.invoice ?? null;
}

async function findZohoInvoiceByReference(accessToken, referenceNumber) {
  const url = zohoBooksUrl("/books/v3/invoices");
  url.searchParams.set("search_text", referenceNumber);
  url.searchParams.set("filter_by", "Status.All");
  url.searchParams.set("per_page", "20");

  const body = await zohoFetch(accessToken, url);
  return (
    body.invoices?.find((invoice) => {
      return invoice.reference_number === referenceNumber || invoice.reference_number?.includes(referenceNumber);
    }) ?? null
  );
}

async function findZohoCreditNoteByReference(accessToken, referenceNumber) {
  const url = zohoBooksUrl("/books/v3/creditnotes");
  url.searchParams.set("search_text", referenceNumber);
  url.searchParams.set("filter_by", "Status.All");
  url.searchParams.set("per_page", "20");

  const body = await zohoFetch(accessToken, url);
  const creditNotes = Array.isArray(body.creditnotes) ? body.creditnotes : body.creditnotes ? [body.creditnotes] : [];
  return creditNotes.find((creditNote) => creditNote.reference_number === referenceNumber) ?? null;
}

function getShopifyInvoiceReferenceCandidates(payload) {
  const order = payload.order ?? {};
  return uniqueValues([
    payload.name,
    payload.order_name,
    order.name,
    payload.order_number ? `#${payload.order_number}` : null,
    order.order_number ? `#${order.order_number}` : null,
    payload.order_id ? String(payload.order_id) : null,
    payload.id ? String(payload.id) : null
  ]);
}

function hasShopifyOrderNameReference(payload) {
  const order = payload.order ?? {};
  return Boolean(payload.name || payload.order_name || order.name || payload.order_number || order.order_number);
}

function getShopifyRefundReference(refund) {
  return `Shopify refund ${refund.id}`;
}

function getShopifyCancellationCreditReference(order) {
  return `Shopify cancellation ${order.name ?? order.id}`;
}

function getShopifyRefundAmount(refund) {
  const transactionAmount = (refund.transactions ?? [])
    .filter((transaction) => {
      return !transaction.status || ["success", "processed"].includes(transaction.status);
    })
    .reduce((total, transaction) => {
      return total + money(transaction.amount);
    }, 0);

  if (transactionAmount > 0) {
    return roundMoney(transactionAmount);
  }

  const lineItemAmount = (refund.refund_line_items ?? []).reduce((total, refundLineItem) => {
    return (
      total +
      money(refundLineItem.subtotal_set?.shop_money?.amount ?? refundLineItem.subtotal) +
      money(refundLineItem.total_tax_set?.shop_money?.amount ?? refundLineItem.total_tax)
    );
  }, 0);
  const adjustmentAmount = (refund.order_adjustments ?? []).reduce((total, adjustment) => {
    return (
      total +
      Math.abs(money(adjustment.amount_set?.shop_money?.amount ?? adjustment.amount)) +
      Math.abs(money(adjustment.tax_amount_set?.shop_money?.amount ?? adjustment.tax_amount))
    );
  }, 0);

  return roundMoney(lineItemAmount + adjustmentAmount);
}

function cacheShopifyInvoice(orderId, invoice) {
  if (!orderId || !invoice.invoiceId) {
    return;
  }

  shopifyOrderInvoiceCache.set(String(orderId), invoice);
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

async function getZohoTaxCatalog(accessToken) {
  if (!zohoTaxCatalogPromise) {
    zohoTaxCatalogPromise = loadZohoTaxCatalog(accessToken).catch((error) => {
      zohoTaxCatalogPromise = undefined;
      throw error;
    });
  }

  return zohoTaxCatalogPromise;
}

async function loadZohoTaxCatalog(accessToken) {
  const [organizationsBody, taxesBody] = await Promise.all([
    zohoFetch(accessToken, new URL("/books/v3/organizations", config.zohoApiDomain)),
    zohoFetch(accessToken, zohoBooksUrl("/books/v3/settings/taxes"))
  ]);
  const organization = (organizationsBody.organizations ?? []).find((candidate) => {
    return String(candidate.organization_id) === String(config.zohoOrganizationId);
  });

  return {
    organizationStateCode: organization?.state_code ?? "",
    taxes: (taxesBody.taxes ?? []).filter((tax) => !tax.is_inactive)
  };
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
  const normalizedStateCode = normalizeIndianStateCode(address.province_code ?? address.province);

  return {
    attention: [address.first_name, address.last_name].filter(Boolean).join(" "),
    address: address.address1,
    street2: address.address2,
    city: address.city,
    state: address.province,
    state_code: normalizedStateCode || address.province_code,
    zip: address.zip,
    country: address.country,
    phone: address.phone
  };
}

function doesZohoContactMatchShopifyOrderPlaceOfSupply(contact, order) {
  const orderCountryCode = normalizeCountryCode(order.shipping_address?.country_code ?? order.billing_address?.country_code);
  const orderProvinceCode = getShopifyOrderStateCode(order);

  if (orderCountryCode && orderCountryCode !== "IN") {
    return normalizeCountryCode(contact.country_code) === orderCountryCode;
  }

  if (!orderProvinceCode) {
    return true;
  }

  return (
    normalizeIndianStateCode(contact.place_of_contact) === orderProvinceCode ||
    normalizeIndianStateCode(contact.billing_address?.state_code ?? contact.billing_address?.state) === orderProvinceCode ||
    normalizeIndianStateCode(contact.shipping_address?.state_code ?? contact.shipping_address?.state) === orderProvinceCode
  );
}

function getShopifyLineItemTaxAmount(item) {
  return getShopifyTaxLinesAmount(item.tax_lines);
}

function getShopifyProductTaxAmount(order) {
  return roundMoney((order.line_items ?? []).reduce((total, item) => total + getShopifyLineItemTaxAmount(item), 0));
}

function getShopifyOrderTaxAmount(order) {
  const orderTax = money(
    order.current_total_tax_set?.shop_money?.amount ??
      order.total_tax_set?.shop_money?.amount ??
      order.current_total_tax ??
      order.total_tax
  );

  if (orderTax > 0) {
    return roundMoney(orderTax);
  }

  return roundMoney(
    getShopifyProductTaxAmount(order) +
      (order.shipping_lines ?? []).reduce((total, shippingLine) => {
        return total + getShopifyTaxLinesAmount(shippingLine.tax_lines);
      }, 0)
  );
}

function getShopifyShippingTaxAmount(order) {
  const shippingTax = (order.shipping_lines ?? []).reduce((total, shippingLine) => {
    return total + getShopifyTaxLinesAmount(shippingLine.tax_lines);
  }, 0);

  if (shippingTax > 0) {
    return roundMoney(shippingTax);
  }

  return getShopifyShippingTotal(order) > 0 ? getShopifyOrderTaxAmount(order) : 0;
}

function getShopifyTaxLinesAmount(taxLines = []) {
  return roundMoney(
    taxLines.reduce((total, taxLine) => {
      return total + money(taxLine.price_set?.shop_money?.amount ?? taxLine.price);
    }, 0)
  );
}

function getShopifyTaxRateForTaxLines(taxLines = []) {
  const taxRate = taxLines.reduce((total, taxLine) => {
    return total + Number(taxLine.rate ?? 0);
  }, 0);

  if (taxRate > 0) {
    return roundMoney(taxRate * 100);
  }

  return null;
}

function getShopifyShippingTotal(order) {
  return roundMoney(money(order.total_shipping_price_set?.shop_money?.amount ?? order.total_shipping_price ?? 0));
}

function getMappedInvoiceTotal(lineItems, shippingTotal, totalDiscount) {
  const lineTotal = (lineItems ?? []).reduce((total, item) => {
    const quantity = Math.max(Number(item.quantity) || 0, 1);
    return total + money(item.rate) * quantity;
  }, 0);

  return roundMoney(lineTotal + shippingTotal - totalDiscount);
}

function getShopifyOrderTotal(order) {
  return roundMoney(
    money(
      order.current_total_price_set?.shop_money?.amount ??
        order.total_price_set?.shop_money?.amount ??
        order.current_total_price ??
        order.total_price
    )
  );
}

function getZohoPayloadLineItemsTotal(invoicePayload) {
  return roundMoney(
    (invoicePayload.line_items ?? []).reduce((total, item) => {
      const quantity = Math.max(Number(item.quantity) || 0, 1);
      return total + money(item.rate) * quantity;
    }, 0)
  );
}

function getZohoPayloadTotal(invoicePayload) {
  return roundMoney(
    getZohoPayloadLineItemsTotal(invoicePayload) +
      money(invoicePayload.shipping_charge) +
      money(invoicePayload.adjustment) -
      money(invoicePayload.discount)
  );
}

function getShopifyTaxRateForOrder(order) {
  const orderLevelTaxRate = (order.tax_lines ?? []).reduce((total, taxLine) => {
    return total + Number(taxLine.rate ?? 0);
  }, 0);

  if (orderLevelTaxRate > 0) {
    return roundMoney(orderLevelTaxRate * 100);
  }

  return null;
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

function getShopifyOrderDiscountLabels(order) {
  const codeLabels = (order.discount_codes ?? []).map((discountCode) => {
    return formatShopifyDiscountParts(discountCode.code, null, discountCode.type);
  });
  const applicationLabels = (order.discount_applications ?? []).map(formatShopifyDiscountApplication);

  return uniqueValues([...codeLabels, ...applicationLabels]);
}

function formatShopifyDiscountApplication(discountApplication) {
  if (!discountApplication) {
    return null;
  }

  return formatShopifyDiscountParts(
    discountApplication.code ?? discountApplication.title,
    discountApplication.value,
    discountApplication.value_type
  );
}

function formatShopifyDiscountParts(label, value, valueType) {
  const parts = [label];

  if (value && valueType === "percentage") {
    parts.push(`${formatPercent(value)}%`);
  } else if (value && valueType && valueType !== "discount_code") {
    parts.push(String(valueType));
  }

  return parts.filter(Boolean).join(" ");
}

function formatPercent(value) {
  const percentage = money(value);
  return Number.isInteger(percentage) ? String(percentage) : formatMoney(percentage);
}

function formatMoney(value) {
  return roundMoney(money(value)).toFixed(2);
}

function getShopifyDiscountNote(order, totalDiscount) {
  if (totalDiscount <= 0) {
    return null;
  }

  const details = getShopifyOrderDiscountLabels(order);

  return [`Shopify discount total: INR ${formatMoney(totalDiscount)}`, details.length ? `Discount details: ${details.join(", ")}` : null]
    .filter(Boolean)
    .join("\n");
}

function isInterstateShopifyOrder(order, organizationStateCode) {
  const shipping = order.shipping_address ?? {};
  const billing = order.billing_address ?? {};
  const destinationCountryCode = normalizeCountryCode(shipping.country_code ?? billing.country_code);
  const destinationStateCode = getShopifyOrderStateCode(order);
  const normalizedOrganizationStateCode = normalizeIndianStateCode(organizationStateCode);

  if (destinationCountryCode && destinationCountryCode !== "IN") {
    return true;
  }

  if (!destinationStateCode || !normalizedOrganizationStateCode) {
    return false;
  }

  return destinationStateCode !== normalizedOrganizationStateCode;
}

function getShopifyOrderStateCode(order) {
  return normalizeIndianStateCode(
    order.shipping_address?.province_code ??
      order.shipping_address?.province ??
      order.billing_address?.province_code ??
      order.billing_address?.province
  );
}

function normalizeCountryCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeIndianStateCode(value) {
  const normalized = String(value ?? "").trim().toUpperCase();

  if (!normalized) {
    return "";
  }

  return INDIAN_STATE_CODES[normalized] ?? normalized;
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

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(String))];
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

const INDIAN_STATE_CODES = {
  "ANDAMAN AND NICOBAR ISLANDS": "AN",
  "ANDHRA PRADESH": "AP",
  "ARUNACHAL PRADESH": "AR",
  ASSAM: "AS",
  BIHAR: "BR",
  CHANDIGARH: "CH",
  CHHATTISGARH: "CG",
  DADRA: "DN",
  "DADRA AND NAGAR HAVELI": "DN",
  DAMAN: "DD",
  "DAMAN AND DIU": "DD",
  DELHI: "DL",
  "NCT OF DELHI": "DL",
  GOA: "GA",
  GUJARAT: "GJ",
  HARYANA: "HR",
  "HIMACHAL PRADESH": "HP",
  "JAMMU AND KASHMIR": "JK",
  JHARKHAND: "JH",
  KARNATAKA: "KA",
  KERALA: "KL",
  LADAKH: "LA",
  LAKSHADWEEP: "LD",
  "MADHYA PRADESH": "MP",
  MAHARASHTRA: "MH",
  MANIPUR: "MN",
  MEGHALAYA: "ML",
  MIZORAM: "MZ",
  NAGALAND: "NL",
  ODISHA: "OR",
  ORISSA: "OR",
  PUDUCHERRY: "PY",
  PONDICHERRY: "PY",
  PUNJAB: "PB",
  RAJASTHAN: "RJ",
  SIKKIM: "SK",
  "TAMIL NADU": "TN",
  TELANGANA: "TS",
  TRIPURA: "TR",
  "UTTAR PRADESH": "UP",
  UTTARAKHAND: "UK",
  "WEST BENGAL": "WB"
};
