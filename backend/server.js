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
const AZURE_OPENAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "";
const AZURE_OPENAI_ASSISTANT_ID = process.env.AZURE_OPENAI_ASSISTANT_ID || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..", "frontend");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(helmet({ contentSecurityPolicy: false }));
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

function buildUserMessage(body) {
  const pretty = JSON.stringify(body || {}, null, 2);
  return `Erstelle einen Angebotsentwurf auf Deutsch. Verwende die folgenden Eingangsdaten als JSON:\n${pretty}`;
}

async function createRun(message) {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/threads/runs?api-version=${encodeURIComponent(AZURE_OPENAI_API_VERSION)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_OPENAI_API_KEY
    },
    body: JSON.stringify({
      assistant_id: AZURE_OPENAI_ASSISTANT_ID,
      thread: { messages: [{ role: "user", content: message }] }
    })
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    const err = new Error(msg);
    err.raw = data || text;
    throw err;
  }
  return data;
}

async function pollRun(threadId, runId, timeoutMs = 60000, intervalMs = 1500) {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}?api-version=${encodeURIComponent(AZURE_OPENAI_API_VERSION)}`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(url, {
      method: "GET",
      headers: { "api-key": AZURE_OPENAI_API_KEY }
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || res.statusText;
      const err = new Error(msg);
      err.raw = data || text;
      throw err;
    }
    if (data?.status === "completed") return data;
    if (data?.status && data.status !== "queued" && data.status !== "in_progress") {
      const err = new Error(`Run status: ${data.status}`);
      err.raw = data;
      throw err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const err = new Error("Run polling timed out");
  err.raw = { threadId, runId };
  throw err;
}

async function fetchMessages(threadId) {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/threads/${encodeURIComponent(threadId)}/messages?api-version=${encodeURIComponent(AZURE_OPENAI_API_VERSION)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": AZURE_OPENAI_API_KEY }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    const err = new Error(msg);
    err.raw = data || text;
    throw err;
  }
  return data;
}

function extractAssistantText(messages) {
  const list = Array.isArray(messages?.data) ? messages.data : [];
  const assistantMsg = list.find(msg => msg?.role === "assistant") || list[list.length - 1];
  if (!assistantMsg) return "";
  const contents = assistantMsg.content || [];
  const firstText = contents.find(c => c.type === "text");
  return firstText?.text?.value || "";
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    api: "online (Assistant)",
    configured: {
      assistantId: Boolean(AZURE_OPENAI_ASSISTANT_ID),
      apiKey: Boolean(AZURE_OPENAI_API_KEY)
    }
  });
});

app.post("/api/generate-offer", async (req, res) => {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const context = normalizeContext(req.body);
  const requestBody = req.body || {};
  let raw = null;

  try {
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_ASSISTANT_ID) {
      return res.status(500).json({ error: "Azure OpenAI Konfiguration fehlt" });
    }

    const userMessage = buildUserMessage(requestBody);
    const runCreate = await createRun(userMessage);
    raw = { runCreate };

    const threadId = runCreate?.thread_id;
    const runObj = await pollRun(threadId, runCreate?.id);
    raw.run = runObj;

    const messages = await fetchMessages(threadId);
    raw.messages = messages;

    const text = extractAssistantText(messages);

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;

    return res.json({
      runId,
      status: "succeeded",
      mode: "agent",
      request: requestBody,
      context,
      text,
      raw,
      meta: { startedAt, finishedAt, durationMs }
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    return res.status(500).json({
      runId,
      status: "failed",
      mode: "agent",
      error: err?.message || String(err),
      request: requestBody,
      context,
      raw: raw || err?.raw || null,
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
