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
  const refreshToken = (await rl.question("Paste full ZOHO_REFRESH_TOKEN: ")).trim();

  if (!refreshToken.startsWith("1000.")) {
    throw new Error("ZOHO_REFRESH_TOKEN should start with 1000.");
  }

  let env = fs.readFileSync(envPath, "utf8");
  env = upsertEnvValue(env, "ZOHO_REFRESH_TOKEN", refreshToken);
  fs.writeFileSync(envPath, env);

  console.log("\nUpdated local .env.");
  console.log(`ZOHO_REFRESH_TOKEN now starts with ${refreshToken.slice(0, 8)}... and is ${refreshToken.length} chars long.`);
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
