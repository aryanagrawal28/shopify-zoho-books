const code = process.argv[2]?.trim();

if (!code) {
  throw new Error("Usage: node --env-file=.env scripts/exchange-zoho-code.js ZOHO_GRANT_CODE");
}

const accountsDomain = process.env.ZOHO_ACCOUNTS_DOMAIN;

if (!accountsDomain || !process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) {
  throw new Error("Missing ZOHO_ACCOUNTS_DOMAIN, ZOHO_CLIENT_ID, or ZOHO_CLIENT_SECRET in .env");
}

const url = new URL("/oauth/v2/token", accountsDomain);
url.searchParams.set("code", code);
url.searchParams.set("client_id", process.env.ZOHO_CLIENT_ID);
url.searchParams.set("client_secret", process.env.ZOHO_CLIENT_SECRET);
url.searchParams.set("grant_type", "authorization_code");

const response = await fetch(url, { method: "POST" });
const body = await response.json();

if (body.refresh_token) {
  console.log("\nSuccess. Copy this value into Render as ZOHO_REFRESH_TOKEN:\n");
  console.log(body.refresh_token);
  process.exit(0);
}

console.error(`Zoho token exchange failed on ${accountsDomain}: ${JSON.stringify(body)}`);

if (body.error === "invalid_code") {
  throw new Error(
    "Zoho rejected the grant code. Generate a fresh Self Client code from the same client ID in .env, then run this command immediately. Do not reuse an old code."
  );
}

if (body.error === "invalid_client") {
  throw new Error("Zoho rejected the client ID/secret. Confirm the Self Client belongs to the ZOHO_CLIENT_ID in .env.");
}

throw new Error("Zoho did not accept this grant code.");
