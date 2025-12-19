import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretsMapPath = path.resolve(__dirname, "../config/secrets.map.json");

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
let kvClient = null;
let kvUri = "";

function readMap() {
  const raw = fs.readFileSync(secretsMapPath, "utf-8");
  return JSON.parse(raw);
}

function getKvClient(uri) {
  if (!uri) return null;
  if (kvClient && kvUri === uri) return kvClient;
  kvUri = uri;
  kvClient = new SecretClient(uri, new DefaultAzureCredential());
  return kvClient;
}

async function fetchKeyVaultSecret(client, name) {
  if (!client || !name) return null;
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.value;
  const secret = await client.getSecret(name);
  const value = secret?.value || null;
  cache.set(name, { value, fetchedAt: now });
  return value;
}

export async function getSecrets(config) {
  const map = readMap();
  const secrets = {};
  const keyVaultUri = (config?.azure?.keyVaultUri || "").trim();
  const client = getKvClient(keyVaultUri);

  for (const [key, def] of Object.entries(map)) {
    if (def.source === "keyvault") {
      try {
        secrets[key] = await fetchKeyVaultSecret(client, def.secretName);
      } catch (err) {
        console.warn(`Failed to load secret "${key}" from Key Vault: ${err?.message || err}`);
        secrets[key] = null;
      }
    }
  }

  return secrets;
}
