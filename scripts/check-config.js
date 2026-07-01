const required = [
  "SHOPIFY_WEBHOOK_SECRET",
  "ZOHO_ACCOUNTS_DOMAIN",
  "ZOHO_API_DOMAIN",
  "ZOHO_CLIENT_ID",
  "ZOHO_CLIENT_SECRET",
  "ZOHO_REFRESH_TOKEN",
  "ZOHO_ORGANIZATION_ID",
  "ZOHO_DEFAULT_ITEM_ID",
  "ZOHO_DEFAULT_TAX_ID"
];

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error("Missing required .env values:");
  missing.forEach((name) => console.error(`- ${name}`));
  process.exit(1);
}

console.log("Loaded .env values:");
for (const name of required) {
  console.log(`- ${name}: ${redact(process.env[name])}`);
}

checkShape();

console.log("\nChecking Zoho token...");
const accessToken = await getZohoAccessToken();
console.log("- Zoho access token: OK");

console.log("\nChecking Zoho organization...");
const orgs = await zohoGet(accessToken, "/books/v3/organizations");
const organization = (orgs.organizations ?? []).find((org) => {
  return String(org.organization_id) === String(process.env.ZOHO_ORGANIZATION_ID);
});

if (!organization) {
  throw new Error("ZOHO_ORGANIZATION_ID was not found in your Zoho account.");
}

console.log(`- Organization: ${organization.name} (${organization.organization_id})`);

console.log("\nChecking Zoho default item...");
const item = await zohoGet(
  accessToken,
  `/books/v3/items/${encodeURIComponent(process.env.ZOHO_DEFAULT_ITEM_ID)}?organization_id=${encodeURIComponent(
    process.env.ZOHO_ORGANIZATION_ID
  )}`
);
console.log(`- Default item: ${item.item?.name ?? "found"} (${process.env.ZOHO_DEFAULT_ITEM_ID})`);

console.log("\nChecking Zoho default tax...");
const taxes = await zohoGet(
  accessToken,
  `/books/v3/settings/taxes?organization_id=${encodeURIComponent(process.env.ZOHO_ORGANIZATION_ID)}`
);
const tax = (taxes.taxes ?? []).find((zohoTax) => {
  return String(zohoTax.tax_id) === String(process.env.ZOHO_DEFAULT_TAX_ID);
});

if (!tax) {
  throw new Error("ZOHO_DEFAULT_TAX_ID was not found in your Zoho tax settings.");
}

console.log(`- Default tax: ${tax.tax_name} (${tax.tax_percentage}%)`);

console.log("\nConfig looks good for Zoho.");
console.log("Shopify secret can only be fully verified when Shopify sends a webhook.");

function checkShape() {
  const shopifySecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (shopifySecret.startsWith("shpat_")) {
    console.warn("\nWarning: SHOPIFY_WEBHOOK_SECRET looks like an Admin API access token.");
    console.warn("Use the webhook signing secret or app client secret, not the Admin API token.");
  }

  if (shopifySecret.length < 20) {
    console.warn("\nWarning: SHOPIFY_WEBHOOK_SECRET looks unusually short.");
  }

  if (!["https://accounts.zoho.in", "https://accounts.zoho.com"].includes(process.env.ZOHO_ACCOUNTS_DOMAIN)) {
    console.warn("\nWarning: ZOHO_ACCOUNTS_DOMAIN is unusual. Expected .in or .com unless you use another Zoho DC.");
  }
}

async function getZohoAccessToken() {
  const url = new URL("/oauth/v2/token", process.env.ZOHO_ACCOUNTS_DOMAIN);
  url.searchParams.set("refresh_token", process.env.ZOHO_REFRESH_TOKEN);
  url.searchParams.set("client_id", process.env.ZOHO_CLIENT_ID);
  url.searchParams.set("client_secret", process.env.ZOHO_CLIENT_SECRET);
  url.searchParams.set("grant_type", "refresh_token");

  const response = await fetch(url, { method: "POST" });
  const body = await response.json();

  if (!response.ok || !body.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(body)}`);
  }

  return body.access_token;
}

async function zohoGet(accessToken, path) {
  const response = await fetch(new URL(path, process.env.ZOHO_API_DOMAIN), {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`
    }
  });
  const body = await response.json();

  if (!response.ok || body.code !== 0) {
    throw new Error(`Zoho request failed: ${JSON.stringify(body)}`);
  }

  return body;
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
