import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

import { loadConfig } from "./src/config.js";
import { getSecrets } from "./src/secrets.js";

dotenv.config();

const config = loadConfig();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(helmet());
app.use(morgan("tiny"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");

const corsOrigins = (config.cors?.allowedOrigins || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
if (corsOrigins.length) {
  const corsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes("*") || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    }
  };
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
}

const runs = new Map();
let activeRunId = null;

function makeAbortSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function sanitizeText(s, maxLen = 5000) {
  if (typeof s !== "string") return "";
  return s.replace(/\u0000/g, "").trim().slice(0, maxLen);
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseExtraHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // fallthrough to CSV parsing
  }
  const headers = {};
  text.split(",").forEach(part => {
    const [k, ...rest] = part.split(":");
    if (!k || !rest.length) return;
    const key = k.trim();
    const value = rest.join(":").trim();
    if (key) headers[key] = value;
  });
  return headers;
}

function normalizeInput(body) {
  const raw = body?.context && typeof body.context === "object" ? body.context : (body || {});
  return {
    customer: sanitizeText(raw.customer || raw.company || raw.client || ""),
    category: sanitizeText(raw.category || ""),
    primaryGoal: sanitizeText(raw.primaryGoal || ""),
    secondaryGoals: sanitizeText(raw.secondaryGoals || ""),
    situation: sanitizeText(raw.situation || ""),
    scope: sanitizeText(raw.scope || ""),
    detailDescription: sanitizeText(raw.detailDescription || ""),
    notes: sanitizeText(raw.notes || ""),
    pt: toNumber(raw.pt),
    style: sanitizeText(raw.style || "formal"),
    language: sanitizeText(raw.language || "de")
  };
}

function envDemoFlag() {
  return (process.env.DEMO_MODE || "").toLowerCase() === "true";
}

async function getRuntimeState() {
  const secrets = await getSecrets(config).catch(() => ({}));
  const demo = Boolean(
    config.app?.demoModeDefault ||
    envDemoFlag() ||
    !config.foundry?.endpoint ||
    !config.foundry?.modelOrDeployment ||
    !secrets?.foundryApiKey
  );
  return { secrets, demo };
}

app.get("/api/health", async (req, res) => {
  const { demo } = await getRuntimeState();
  res.json({
    ok: true,
    api: demo ? "offline (Demo-Modus)" : "online",
    run: activeRunId || "—",
    deployment: config.app?.deploymentLabel || "default",
    time: new Date().toISOString(),
    configured: {
      keyVault: Boolean(config.azure?.keyVaultUri),
      foundryEndpoint: Boolean(config.foundry?.endpoint),
      foundryModel: Boolean(config.foundry?.modelOrDeployment),
      chatPath: Boolean(config.foundry?.chatPath)
    }
  });
});

app.post("/api/generate-offer", async (req, res) => {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const input = normalizeInput(req.body || {});

  const { demo, secrets } = await getRuntimeState();
  activeRunId = runId;
  runs.set(runId, {
    runId,
    status: "running",
    startedAt,
    finishedAt: null,
    request: input,
    response: null,
    error: null,
    mode: demo ? "demo" : "foundry"
  });

  const finish = (payload) => {
    runs.set(runId, { ...runs.get(runId), ...payload });
  };

  try {
    if (demo) {
      const demoText = [
        "**Angebotsentwurf (Demo-Modus)**",
        "",
        `Kunde: ${input.customer || "—"}`,
        `Kategorie: ${input.category || "—"}`,
        `Primäres Ziel: ${input.primaryGoal || "—"}`,
        `Sekundäre Ziele: ${input.secondaryGoals || "—"}`,
        "",
        "**Kundensituation**",
        input.situation || "—",
        "",
        "**Leistungsumfang (Beispiel)**",
        input.scope || "—",
        "",
        "**Detailbeschreibung**",
        input.detailDescription || "—",
        "",
        `Gesamtaufwand (PT): ${input.pt != null ? input.pt : "—"}`,
        "",
        "Hinweis: Dieser Inhalt wurde lokal generiert, da die API aktuell im Demo-Modus ist."
      ].join("\n");

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      const response = {
        runId,
        status: "succeeded",
        mode: "demo",
        deployment: config.app?.deploymentLabel,
        context: input,
        text: demoText,
        meta: {
          startedAt,
          finishedAt,
          durationMs,
          request: {
            endpoint: "demo",
            deploymentLabel: config.app?.deploymentLabel
          },
          response: {
            httpStatus: 200
          }
        }
      };

      finish({
        status: "succeeded",
        finishedAt,
        response
      });

      return res.json(response);
    }

    const apiKey = secrets?.foundryApiKey;
    if (!apiKey) {
      throw new Error("Foundry API Key nicht verfügbar (Key Vault)");
    }

    const extraHeaders = parseExtraHeaders(config.foundry?.extraHeaders);
    const isGerman = input.language.toLowerCase().startsWith("de");
    const system = isGerman
      ? "Du bist ein Presales-Assistent. Erstelle einen sachlichen, professionellen Angebotsentwurf. Erfinde keine Fakten, nutze nur die Eingaben. Nenne Annahmen explizit. Keine detaillierte PT-Aufschlüsselung."
      : "You are a presales assistant. Draft a professional offer. Do not invent facts; only use the provided inputs. State assumptions explicitly. No detailed person-day breakdown.";

    const user = isGerman
      ? [
          "Erstelle einen Angebotsentwurf basierend auf den folgenden Eingaben.",
          "",
          `Kunde: ${input.customer || "—"}`,
          `Kategorie: ${input.category || "—"}`,
          `Primäres Ziel: ${input.primaryGoal || "—"}`,
          `Sekundäre Ziele: ${input.secondaryGoals || "—"}`,
          `Kundensituation: ${input.situation || "—"}`,
          `Leistungsumfang: ${input.scope || "—"}`,
          `Detailbeschreibung: ${input.detailDescription || "—"}`,
          `Hinweise: ${input.notes || "—"}`,
          `Gesamtaufwand (PT): ${input.pt != null ? input.pt : "—"}`,
          `Ton: ${input.style || "formal"}`,
          "",
          "Format:",
          "1) Kurzüberblick",
          "2) Leistungsumfang (Bulletpoints)",
          "3) Annahmen & Abgrenzungen",
          "4) Gesamtaufwand (nur Gesamt-PT, keine Aufschlüsselung)",
          "5) Nächste Schritte"
        ].join("\n")
      : [
          "Create an offer draft based on the inputs below.",
          "",
          `Customer: ${input.customer || "—"}`,
          `Category: ${input.category || "—"}`,
          `Primary goal: ${input.primaryGoal || "—"}`,
          `Secondary goals: ${input.secondaryGoals || "—"}`,
          `Situation: ${input.situation || "—"}`,
          `Scope: ${input.scope || "—"}`,
          `Details: ${input.detailDescription || "—"}`,
          `Notes: ${input.notes || "—"}`,
          `Total effort (person-days): ${input.pt != null ? input.pt : "—"}`,
          `Tone: ${input.style || "formal"}`,
          "",
          "Format:",
          "1) Summary",
          "2) Scope (bullets)",
          "3) Assumptions & exclusions",
          "4) Total effort (overall only, no breakdown)",
          "5) Next steps"
        ].join("\n");

    const body = {
      model: config.foundry?.modelOrDeployment,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    };

    const url = `${config.foundry.endpoint.replace(/\/$/, "")}${config.foundry.chatPath || "/v1/chat/completions"}`;
    const { signal, cancel } = makeAbortSignal(config.app?.requestTimeoutMs || 60000);
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [config.foundry?.apiKeyHeader || "api-key"]: apiKey,
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal
    }).finally(cancel);

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      throw new Error(`Foundry call failed: ${r.status} ${r.statusText} ${errText}`.slice(0, 4000));
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content ?? "";

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const response = {
      runId,
      status: "succeeded",
      mode: "foundry",
      deployment: config.app?.deploymentLabel,
      model: config.foundry?.modelOrDeployment,
      context: input,
      text,
      raw: data,
      meta: {
        startedAt,
        finishedAt,
        durationMs,
        request: {
          endpoint: url,
          deploymentLabel: config.app?.deploymentLabel,
          model: config.foundry?.modelOrDeployment,
          timeoutMs: config.app?.requestTimeoutMs
        },
        response: {
          httpStatus: r.status
        }
      }
    };

    finish({
      status: "succeeded",
      finishedAt,
      response
    });

    res.json(response);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    finish({
      status: "failed",
      finishedAt,
      error: msg
    });
    res.status(500).json({
      runId,
      status: "failed",
      mode: demo ? "demo" : "foundry",
      error: msg,
      context: input,
      meta: {
        startedAt,
        finishedAt,
        durationMs
      }
    });
  } finally {
    activeRunId = null;
  }
});

app.post("/api/generate-offer-via-flow", async (req, res) => {
  if (!config.powerAutomate?.enabled) {
    return res.status(400).json({ error: "Power Automate Integration ist nicht aktiviert" });
  }

  const { secrets } = await getRuntimeState();
  const key = secrets?.powerAutomateKey;
  if (!key) {
    return res.status(500).json({ error: "Power Automate Key nicht verfügbar (Key Vault)" });
  }

  const triggerUrl = config.powerAutomate?.triggerUrl;
  if (!triggerUrl) {
    return res.status(500).json({ error: "Power Automate Trigger URL fehlt" });
  }

  try {
    const { signal, cancel } = makeAbortSignal(config.app?.requestTimeoutMs || 60000);
    const r = await fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [config.powerAutomate?.authHeaderName || "x-flow-key"]: key
      },
      body: JSON.stringify(req.body || {}),
      signal
    }).finally(cancel);

    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!r.ok) {
      const msg = data?.error || data?.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return res.json(data ?? { ok: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get("/api/run/:id", (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.response) {
    res.json({
      ...run.response,
      request: run.request,
      error: run.error,
      status: run.status,
      mode: run.mode
    });
    return;
  }
  res.json(run);
});

app.get("/api/history", (req, res) => {
  const items = Array.from(runs.values())
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, 50)
    .map(r => ({
      runId: r.runId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      mode: r.mode,
      customer: r.request?.customer || "",
      category: r.request?.category || "",
      rating: r.feedback?.rating || null
    }));
  res.json({ items });
});

app.post("/api/feedback", (req, res) => {
  const { runId, rating, comment } = req.body || {};
  const run = runId ? runs.get(runId) : null;
  if (!run) return res.status(404).json({ error: "Run not found" });

  const fb = {
    rating: sanitizeText(String(rating || "")),
    comment: sanitizeText(comment),
    at: new Date().toISOString()
  };

  runs.set(runId, { ...run, feedback: fb });
  res.json({ ok: true });
});

app.use(express.static(frontendDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error" });
});

app.listen(Number(config.app?.port || 8080), () => {
  console.log(`Backend listening on :${config.app?.port || 8080}`);
  console.log(`Demo mode default: ${config.app?.demoModeDefault}`);
});
