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
const FLOW_URL = process.env.POWER_AUTOMATE_TRIGGER_URL || "";
const fetchFn = globalThis.fetch;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(helmet());
app.use(morgan("tiny"));
app.use(cors());

function normalizeContext(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.context && typeof body.context === "object" && !Array.isArray(body.context)) {
      return body.context;
    }
    return body;
  }
  return {};
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    api: "online (Power Automate)",
    configured: { triggerUrl: Boolean(FLOW_URL) }
  });
});

app.post("/api/generate-offer", async (req, res) => {
  if (!FLOW_URL) {
    return res.status(500).json({ error: "POWER_AUTOMATE_TRIGGER_URL fehlt" });
  }

  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const context = normalizeContext(req.body);
  const requestBody = req.body || {};
  let rawData = null;

  try {
    const headers = { "Content-Type": "application/json" };

    const response = await fetchFn(FLOW_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    rawData = data;

    if (!response.ok) {
      const msg = data?.error || data?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;

    return res.json({
      runId,
      status: "succeeded",
      mode: "flow",
      request: requestBody,
      context,
      text: typeof data?.text === "string" ? data.text : JSON.stringify(data ?? {}, null, 2),
      raw: data,
      meta: { startedAt, finishedAt, durationMs }
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    return res.status(500).json({
      runId,
      status: "failed",
      mode: "flow",
      error: err?.message || String(err),
      context,
      request: requestBody,
      raw: rawData,
      meta: { startedAt, finishedAt, durationMs }
    });
  }
});

app.use(express.static(frontendDir));
app.get("/", (_req, res) => res.sendFile(path.join(frontendDir, "index.html")));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Backend listening on :${PORT}`);
});
