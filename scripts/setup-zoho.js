import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

try {
  console.log("Zoho Books setup");
  console.log("Paste values from your Zoho API Console. They stay on this machine.\n");

  const dataCenter = await ask("Zoho data center [in/com]", "in");
  const zohoAccountsDomain = dataCenter === "com" ? "https://accounts.zoho.com" : "https://accounts.zoho.in";
  const zohoApiDomain = dataCenter === "com" ? "https://www.zohoapis.com" : "https://www.zohoapis.in";

  const clientId = await ask("Zoho Client ID");
  const clientSecret = await ask("Zoho Client Secret");
  const refreshToken = await ask("Zoho Refresh Token");
  const shopifyWebhookSecret = await ask("Shopify app client secret / webhook secret (optional for now)", "");

  console.log("\nChecking Zoho token...");
  const accessToken = await getZohoAccessToken({
    zohoAccountsDomain,
    clientId,
    clientSecret,
    refreshToken
  });

  console.log("Fetching Zoho organizations...");
  const organizations = await zohoGet(accessToken, zohoApiDomain, "/books/v3/organizations");
  const organization = await chooseOne("Choose organization", organizations.organizations ?? [], (org) => {
    return `${org.name} (${org.organization_id})`;
  });

  console.log("\nFetching Zoho items...");
  const items = await zohoGet(
    accessToken,
    zohoApiDomain,
    `/books/v3/items?organization_id=${encodeURIComponent(organization.organization_id)}`
  );

  if ((items.items ?? []).length === 0) {
    throw new Error(
      "No Zoho items found. In Zoho Books, create an item first: Items > + New Item. Use a simple item like 'Shopify Product Sales', then run this setup again."
    );
  }

  const item = await chooseOne("Choose default item for Shopify invoices", items.items ?? [], (zohoItem) => {
    return `${zohoItem.name} (${zohoItem.item_id})`;
  });

  const env = [
    "PORT=3000",
    "",
    `SHOPIFY_WEBHOOK_SECRET=${shopifyWebhookSecret}`,
    "",
    `ZOHO_ACCOUNTS_DOMAIN=${zohoAccountsDomain}`,
    `ZOHO_API_DOMAIN=${zohoApiDomain}`,
    `ZOHO_CLIENT_ID=${clientId}`,
    `ZOHO_CLIENT_SECRET=${clientSecret}`,
    `ZOHO_REFRESH_TOKEN=${refreshToken}`,
    `ZOHO_ORGANIZATION_ID=${organization.organization_id}`,
    `ZOHO_DEFAULT_ITEM_ID=${item.item_id}`,
    "",
    "ZOHO_DEFAULT_PAYMENT_TERMS=0",
    ""
  ].join("\n");

  await fs.writeFile(".env", env, { mode: 0o600 });

  console.log("\nDone. Wrote .env");
  console.log("Next run: npm start");
} catch (error) {
  console.error("\nSetup failed:");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}

async function ask(label, defaultValue) {
  const suffix = defaultValue === undefined ? "" : ` (${defaultValue})`;
  const answer = await rl.question(`${label}${suffix}: `);
  const value = answer.trim() || defaultValue;

  if (value === undefined || value === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

async function chooseOne(label, values, format) {
  if (values.length === 0) {
    throw new Error(`No options found for: ${label}`);
  }

  if (values.length === 1) {
    console.log(`${label}: ${format(values[0])}`);
    return values[0];
  }

  console.log(`\n${label}:`);
  values.forEach((value, index) => {
    console.log(`${index + 1}. ${format(value)}`);
  });

  const answer = await ask("Enter number", "1");
  const index = Number(answer) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= values.length) {
    throw new Error("Invalid selection");
  }

  return values[index];
}

async function getZohoAccessToken({ zohoAccountsDomain, clientId, clientSecret, refreshToken }) {
  const url = new URL("/oauth/v2/token", zohoAccountsDomain);
  url.searchParams.set("refresh_token", refreshToken);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "refresh_token");

  const response = await fetch(url, { method: "POST" });
  const body = await response.json();

  if (!response.ok || !body.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(body)}`);
  }

  return body.access_token;
}

async function zohoGet(accessToken, zohoApiDomain, path) {
  const response = await fetch(new URL(path, zohoApiDomain), {
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
