import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(projectRoot, ".env");

if (!fs.existsSync(envPath)) {
  throw new Error(`Could not find .env at ${envPath}`);
}

const rl = readline.createInterface({ input, output });

try {
  const clientId = (await rl.question("Paste full ZOHO_CLIENT_ID: ")).trim();
  const clientSecret = (await rl.question("Paste full ZOHO_CLIENT_SECRET: ")).trim();

  if (!clientId.startsWith("1000.")) {
    throw new Error("ZOHO_CLIENT_ID should start with 1000.");
  }

  if (!clientSecret) {
    throw new Error("ZOHO_CLIENT_SECRET cannot be empty.");
  }

  let env = fs.readFileSync(envPath, "utf8");

  env = upsertEnvValue(env, "ZOHO_CLIENT_ID", clientId);
  env = upsertEnvValue(env, "ZOHO_CLIENT_SECRET", clientSecret);

  fs.writeFileSync(envPath, env);

  console.log("\nUpdated local .env.");
  console.log(`ZOHO_CLIENT_ID now starts with ${clientId.slice(0, 13)}...`);
} finally {
  rl.close();
}

function upsertEnvValue(env, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(env)) {
    return env.replace(pattern, line);
  }

  return `${env.trimEnd()}\n${line}\n`;
}
