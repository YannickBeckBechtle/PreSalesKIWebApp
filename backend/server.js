import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const PORT = Number(process.env.PORT) || 8080;
const FLOW_URL = (process.env.POWER_AUTOMATE_TRIGGER_URL || "").trim();
const FLOW_KEY = (process.env.POWER_AUTOMATE_KEY || "").trim();
const FLOW_AUTH_HEADER = (process.env.POWER_AUTOMATE_AUTH_HEADER_NAME || "x-flow-key").trim();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("tiny"));
app.use(cors());

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapToFlowSchema(body) {
  const looksLikeFlow =
    body &&
    typeof body === "object" &&
    body.customer &&
    body.offer &&
    body.goals &&
    body.context;
  if (looksLikeFlow) return body;

  const ctx = body?.context && typeof body.context === "object" ? body.context : body || {};
  return {
    customer: {
      companyOrProject: ctx.customer || ctx.companyOrProject || ctx.company || ctx.client || "",
      responsiblePerson: ctx.responsiblePerson || "",
      contactPerson: ctx.contactPerson || ""
    },
    offer: { primaryCategory: ctx.category || ctx.primaryCategory || "" },
    goals: { primary: ctx.primaryGoal || "", secondary: ctx.secondaryGoals || "" },
    context: {
      customerSituation: ctx.situation || ctx.customerSituation || "",
      serviceScope: ctx.scope || ctx.serviceScope || "",
      pt: toNumber(ctx.pt),
      details: ctx.detailDescription || ctx.details || "",
      additionalNotes: ctx.notes || ctx.additionalNotes || ""
    }
  };
}

function extractTextFromRaw(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw.text === "string") return raw.text;
  if (Array.isArray(raw.messages)) {
    const last = raw.messages[raw.messages.length - 1];
    if (last && typeof last.text === "string") return last.text;
  }
  if (Array.isArray(raw?.body?.messages)) {
    const msgs = raw.body.messages;
    const last = msgs[msgs.length - 1];
    if (last?.content?.[0]?.text?.value) return last.content[0].text.value;
  }
  return "";
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    api: "online (Power Automate)",
    configured: {
      powerAutomateTriggerUrl: Boolean(FLOW_URL)
    }
  });
});

app.post("/api/generate-offer", async (req, res) => {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestBody = req.body || {};
  const payload = mapToFlowSchema(requestBody);
  let raw = null;

  try {
    if (!FLOW_URL) {
      return res.status(500).json({ error: "POWER_AUTOMATE_TRIGGER_URL fehlt" });
    }

    const headers = { "Content-Type": "application/json" };
    if (FLOW_KEY) {
      headers[FLOW_AUTH_HEADER || "x-flow-key"] = FLOW_KEY;
    }

    const response = await fetch(FLOW_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    raw = data;

    if (!response.ok) {
      const msg = data?.error || data?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const runText = typeof data?.text === "string" ? data.text : (extractTextFromRaw(data) || text);

    return res.json({
      runId,
      status: "succeeded",
      mode: "powerautomate",
      text: runText,
      raw: data,
      meta: { startedAt, finishedAt, durationMs }
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    return res.status(500).json({
      runId,
      status: "failed",
      mode: "powerautomate",
      error: err?.message || String(err),
      raw,
      meta: { startedAt, finishedAt, durationMs }
    });
  }
});

app.use(express.static(frontendDir));
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(frontendDir, "index.html"));
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Backend listening on :${PORT}`);
});
