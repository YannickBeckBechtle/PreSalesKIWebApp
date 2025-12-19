import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appConfigPath = path.resolve(__dirname, "../config/app.config.json");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(v, fallback = false) {
  if (typeof v !== "string") return fallback;
  return v.toLowerCase() === "true";
}

export function loadConfig() {
  const base = readJson(appConfigPath);

  const withEnv = {
    ...base,
    app: {
      ...base.app,
      port: toNumber(process.env.PORT, base.app?.port),
      requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, base.app?.requestTimeoutMs),
      demoModeDefault: base.app?.demoModeDefault || parseBool(process.env.DEMO_MODE, false)
    },
    cors: {
      ...base.cors,
      allowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? base.cors?.allowedOrigins ?? ""
    },
    azure: {
      ...base.azure,
      keyVaultUri: process.env.KEY_VAULT_URI || base.azure?.keyVaultUri || ""
    },
    foundry: {
      ...base.foundry,
      endpoint: process.env.FOUNDRY_ENDPOINT || base.foundry?.endpoint || "",
      modelOrDeployment: process.env.FOUNDRY_MODEL_OR_DEPLOYMENT || base.foundry?.modelOrDeployment || "",
      chatPath: base.foundry?.chatPath || "/v1/chat/completions"
    },
    powerAutomate: {
      ...base.powerAutomate,
      triggerUrl: process.env.POWER_AUTOMATE_TRIGGER_URL || base.powerAutomate?.triggerUrl || ""
    }
  };

  return withEnv;
}
