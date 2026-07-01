import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

try {
  const required = [
    "ZOHO_ACCOUNTS_DOMAIN",
    "ZOHO_API_DOMAIN",
    "ZOHO_CLIENT_ID",
    "ZOHO_CLIENT_SECRET",
    "ZOHO_REFRESH_TOKEN",
    "ZOHO_ORGANIZATION_ID"
  ];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing .env values: ${missing.join(", ")}`);
  }

  console.log("Fetching Zoho tax options...");
  const accessToken = await getZohoAccessToken();
  const taxes = await zohoGet(
    accessToken,
    `/books/v3/settings/taxes?organization_id=${encodeURIComponent(process.env.ZOHO_ORGANIZATION_ID)}`
  );
  const activeTaxes = (taxes.taxes ?? []).filter((tax) => !tax.is_inactive);

  if (activeTaxes.length === 0) {
    throw new Error("No active Zoho taxes found. Create a tax in Zoho Books first.");
  }

  console.log("\nChoose default tax for Shopify invoice lines:");
  activeTaxes.forEach((tax, index) => {
    console.log(`${index + 1}. ${tax.tax_name} - ${tax.tax_percentage}% (${tax.tax_id})`);
  });

  const answer = await ask("\nEnter number", "1");
  const index = Number(answer) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= activeTaxes.length) {
    throw new Error("Invalid selection");
  }

  const selectedTax = activeTaxes[index];
  await upsertEnv("ZOHO_DEFAULT_TAX_ID", selectedTax.tax_id);

  console.log(`\nDone. Set ZOHO_DEFAULT_TAX_ID=${selectedTax.tax_id} (${selectedTax.tax_name}).`);
  console.log("Next: restart the server with npm start, then create a new Shopify order.");
} catch (error) {
  console.error("\nTax setup failed:");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}

async function ask(label, defaultValue) {
  const answer = await rl.question(`${label} (${defaultValue}): `);
  return answer.trim() || defaultValue;
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

async function upsertEnv(name, value) {
  const envPath = ".env";
  const existing = await fs.readFile(envPath, "utf8");
  const lines = existing.split("\n");
  let found = false;

  const nextLines = lines.map((line) => {
    if (line.startsWith(`${name}=`)) {
      found = true;
      return `${name}=${value}`;
    }

    return line;
  });

  if (!found) {
    nextLines.push(`${name}=${value}`);
  }

  await fs.writeFile(envPath, nextLines.join("\n"), { mode: 0o600 });
}
