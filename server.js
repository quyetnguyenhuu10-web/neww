// server.js (ESM) — Workspace + SSE + 2-call AI (Executor → Presenter)
// FIXES:
// 1) Build EXEC JOURNAL (inputs/outputs/changed/before/after) and pass to Presenter as facts JSON.
// 2) Stream "work" (proposed/applied) gradually (small sleeps) so UI doesn't jump to a lump.
// 3) Keep your SSE contract SSOT: progress, paper.state, paper.proposed/applied, preview_* plain/html, chat.delta/final, done, debug.executor_raw.

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

import { makeAIClient } from "./aiClient.js";
import { createPaperKernel } from "./paperKernel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const cfgPath = path.join(__dirname, "config.json");
const config = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};

const PORT = Number(process.env.PORT || config.port || 3001);
const FRONTEND_ORIGIN = config.frontendOrigin || "*";
const MODELS = config.models || { executor: "gpt-4o-mini", presenter: "gpt-4o-mini" };
const MAX_STEPS = config.executor?.maxSteps ?? 6;

const SPEED_FACTOR = Number(config.speedFactor || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const ai = makeAIClient();
const paper = createPaperKernel({ cols: config.paper?.cols ?? 26 });

const jobs = new Map();

function mkSid() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(job, event, data) {
  const payload = { ts: new Date().toISOString(), sid: job.sid, ...data };
  job.events.push({ event, data: payload });
  for (const sub of job.subscribers) {
    try {
      sseWrite(sub, event, payload);
    } catch {
      job.subscribers.delete(sub);
    }
  }
}

function endSubscribers(job) {
  for (const s of job.subscribers) {
    try {
      s.end();
    } catch {}
  }
  job.subscribers.clear();
}

/**
 * Preview helpers
 * - Plain preview (append): stream raw text
 * - HTML preview (edit): stream html (already escaped in kernel), client uses innerHTML
 */

async function streamPreviewPlain(job, stepIndex, totalSteps, op, fullText) {
  const text = String(fullText || "");
  if (!text.trim().length) return;

  broadcast(job, "paper.preview_reset", { stepIndex, totalSteps, op, mode: "plain" });
  await sleep(25 * SPEED_FACTOR);

  broadcast(job, "paper.preview_start", { stepIndex, totalSteps, op, mode: "plain" });

  const chunkSize = 24;
  const baseDelay = 15 * SPEED_FACTOR;

  for (let i = 0; i < text.length; i += chunkSize) {
    broadcast(job, "paper.preview_delta", {
      stepIndex,
      totalSteps,
      op,
      mode: "plain",
      delta: text.slice(i, i + chunkSize),
    });
    await sleep(baseDelay);
  }

  broadcast(job, "paper.preview_done", { stepIndex, totalSteps, op, mode: "plain", length: text.length });
  await sleep(25 * SPEED_FACTOR);
}

async function streamPreviewHtml(job, stepIndex, totalSteps, op, htmlText) {
  const html = String(htmlText || "");
  if (!html.trim().length) return;

  broadcast(job, "paper.preview_reset", { stepIndex, totalSteps, op, mode: "html" });
  await sleep(25 * SPEED_FACTOR);

  broadcast(job, "paper.preview_start", { stepIndex, totalSteps, op, mode: "html" });

  const chunkSize = 64;
  const baseDelay = 12 * SPEED_FACTOR;

  for (let i = 0; i < html.length; i += chunkSize) {
    broadcast(job, "paper.preview_html_delta", {
      stepIndex,
      totalSteps,
      op,
      mode: "html",
      delta: html.slice(i, i + chunkSize),
    });
    await sleep(baseDelay);
  }

  broadcast(job, "paper.preview_done", { stepIndex, totalSteps, op, mode: "html", length: html.length });
  await sleep(25 * SPEED_FACTOR);
}

// APIs
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/paper/state", (req, res) => res.json({ ok: true, ...paper.getState() }));

app.post("/api/paper/seed", (req, res) => {
  paper.seed(req.body?.text ?? "");
  res.json({ ok: true, ...paper.getState() });
});

app.post("/api/paper/clear", (req, res) => {
  paper.clear();
  res.json({ ok: true, ...paper.getState() });
});

app.post("/api/paper/cols", (req, res) => {
  paper.setCols(Number(req.body?.cols));
  res.json({ ok: true, ...paper.getState() });
});

// Create streaming job
app.post("/api/chat/create", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") return res.status(400).json({ error: "Message is required" });

  // new turn => clear last diff immediately
  paper.clearDiff?.();

  const sid = mkSid();
  const job = {
    sid,
    userText: message,
    events: [],
    subscribers: new Set(),
    done: false,
    reply: "",
  };
  jobs.set(sid, job);

  // Emit paper state early so UI clears highlight immediately on new turn
  broadcast(job, "paper.state", { ...paper.getState() });

  runPipeline(job).catch((e) => {
    broadcast(job, "error", { error: e?.message || String(e) });
    broadcast(job, "done", { ok: false });
    job.done = true;
    endSubscribers(job);
  });

  res.json({ sid });
});

// Stream endpoint (SSE) with replay
app.get("/api/chat/stream", (req, res) => {
  const sid = String(req.query.sid || "");
  const job = jobs.get(sid);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // replay all past events for late subscribers
  for (const evt of job.events) sseWrite(res, evt.event, evt.data);

  if (job.done) {
    sseWrite(res, "done", { ts: new Date().toISOString(), sid, ok: true });
    res.end();
    return;
  }

  job.subscribers.add(res);
  req.on("close", () => job.subscribers.delete(res));
});

// Pipeline: Executor → commit steps (with preview rules) → paper.state → Presenter
async function runPipeline(job) {
  broadcast(job, "progress", { state: "received" });

  // CALL 1: EXECUTOR
  broadcast(job, "progress", { state: "executing", model: MODELS.executor });

  const st0 = paper.getState({ includeVisual: false });
  const plan = await ai.planActions({
    model: MODELS.executor,
    userText: job.userText,
    paperHead: st0.head,
    maxSteps: MAX_STEPS,
  });

  broadcast(job, "debug.executor_raw", { text: plan.raw || "" });

  const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, MAX_STEPS) : [];
  broadcast(job, "progress", { state: "committing", steps: steps.length });

  // Execution Journal for Presenter (the missing piece)
  const exec = {
    stepsTotal: steps.length,
    appliedCount: 0,
    items: [],
  };

  function pushExec(stepIndex, op, input, output, beforeHead, afterHead) {
    exec.items.push({
      stepIndex,
      op,
      input,
      output,
      changed: typeof output?.changed === "boolean" ? output.changed : undefined,
      beforeHead,
      afterHead,
      paper_rev: output?.paper_rev,
    });
    exec.appliedCount++;
  }

  // NO_OP
  if (!steps.length) {
    broadcast(job, "paper.state", { ...paper.getState() });

    const st = paper.getState({ includeVisual: false });
    const factsObj = {
      kernel_status: "no_op",
      applied_steps: "0/0",
      paper_rev: st.paper_rev,
      paper_head: st.head,
      exec,
    };

    await streamPresenter(job, JSON.stringify(factsObj, null, 2));

    job.done = true;
    broadcast(job, "done", { ok: true });
    endSubscribers(job);
    return;
  }

  // proposed meta (STREAM it a bit so UI doesn't jump)
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i] || {};
    const op = String(a.op || "unknown");
    const t = String(a.text ?? "");
    const previewEnabled =
      (op === "write_append" && t.trim().length > 0) ||
      (op === "write_replace" && t.trim().length > 0);

    broadcast(job, "paper.proposed", {
      stepIndex: i + 1,
      totalSteps: steps.length,
      op,
      previewEnabled,
      previewTextLength: op === "write_append" ? t.length : 0,
    });

    await sleep(60 * SPEED_FACTOR);
  }

  let applied = 0;
  const appliedNotes = [];

  // Rules:
  // append: preview plain first → apply → final paper.state later
  // replace: apply first → preview html (from kernel diff) → final paper.state later
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i] || {};
    const op = String(a.op || "");
    const stepIndex = i + 1;

    // before snapshot (light)
    const before = paper.getState({ includeVisual: false });
    const beforeHead = before.head;

    // Helper: after snapshot & journal
    const afterAndJournal = (input, out) => {
      const after = paper.getState({ includeVisual: false });
      pushExec(stepIndex, op, input, out, beforeHead, after.head);
    };

    // Give UI time to "see" the step start
    await sleep(70 * SPEED_FACTOR);

    if (op === "search") {
      const q = String(a.query ?? "");
      const out = paper.actions.search({ query: q, topK: 8 });
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ query: q }, out);
      applied++;
      appliedNotes.push(`search("${q}")`);
      continue;
    }

    if (op === "read") {
      const sL = a.startLine ?? 1;
      const eL = a.endLine ?? a.startLine ?? 1;
      const out = paper.actions.read({ startLine: sL, endLine: eL });
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ startLine: sL, endLine: eL }, out);
      applied++;
      appliedNotes.push(`read(${out.startLine}..${out.endLine})`);
      continue;
    }

    if (op === "write_append") {
      const text = String(a.text ?? "");
      await streamPreviewPlain(job, stepIndex, steps.length, op, text);

      const out = paper.actions.write_append({ text, ensureNewParagraph: true });
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ textLength: text.length }, out);

      applied++;
      appliedNotes.push(`append(changed=${out.changed}, rev=${out.paper_rev})`);
      continue;
    }

    if (op === "write_replace") {
      const text = String(a.text ?? "");
      const isEmpty = !text.trim().length;

      const line = Number(a.line ?? 1);
      const out = paper.actions.write_replace({ anchorLine: line, newText: text });

      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ line, textLength: text.length }, out);

      applied++;
      appliedNotes.push(`replace(line=${out.anchorLine}, changed=${out.changed}, rev=${out.paper_rev})`);

      // preview only when non-empty AND changed (if unchanged, preview would be misleading)
      if (!isEmpty && out.changed) {
        const st = paper.getState({ includeVisual: false });
        const htmlLines = st?.diff?.annot?.htmlLines || [];
        const html = htmlLines.join("\n");
        await streamPreviewHtml(job, stepIndex, steps.length, op, html);
      }
      continue;
    }

    if (op === "clear_all") {
      const out = paper.actions.clear_all();
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({}, out);

      applied++;
      appliedNotes.push(`clear_all(changed=${out.changed}, rev=${out.paper_rev})`);
      continue;
    }

    if (op === "clear_line") {
      const line = Number(a.line ?? 1);
      const out = paper.actions.clear_line({ line });
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ line }, out);

      applied++;
      appliedNotes.push(`clear_line(${out.clearedLine}, changed=${out.changed}, rev=${out.paper_rev})`);
      continue;
    }

    if (op === "clear_range") {
      const startLine = Number(a.startLine ?? 1);
      const endLine = Number(a.endLine ?? startLine);
      const out = paper.actions.clear_range({ startLine, endLine });
      broadcast(job, "paper.applied", { stepIndex, totalSteps: steps.length, op, output: out });
      afterAndJournal({ startLine, endLine }, out);

      applied++;
      appliedNotes.push(
        `clear_range(${out.startLine}..${out.endLine}, changed=${out.changed}, rev=${out.paper_rev})`
      );
      continue;
    }

    broadcast(job, "paper.applied", {
      stepIndex,
      totalSteps: steps.length,
      op,
      output: { ok: false, changed: false, reason: "unknown_op" },
    });
    afterAndJournal({}, { ok: false, changed: false, reason: "unknown_op" });
  }

  // NOW update paper UI (after previews done)
  broadcast(job, "paper.state", { ...paper.getState() });

  // CALL 2: PRESENTER — pass FULL RESULTS (exec journal), not just head
  broadcast(job, "progress", { state: "presenting", model: MODELS.presenter });

  const st1 = paper.getState({ includeVisual: false });
  const factsObj = {
    kernel_status: "applied",
    applied_steps: `${applied}/${steps.length}`,
    applied_notes: appliedNotes,
    paper_rev: st1.paper_rev,
    paper_head: st1.head,
    exec,
  };

  await streamPresenter(job, JSON.stringify(factsObj, null, 2));

  job.done = true;
  broadcast(job, "done", { ok: true });
  endSubscribers(job);
}

async function streamPresenter(job, facts) {
  let lastFull = "";
  const fullReply = await ai.streamPresenter({
    model: MODELS.presenter,
    userText: job.userText,
    facts,
    onDelta: (delta, full) => {
      lastFull = full;
      job.reply = full;
      broadcast(job, "chat.delta", { delta, full });
    },
  });

  job.reply = fullReply || lastFull || "";
  broadcast(job, "chat.final", { text: job.reply });
}

const server = app.listen(PORT, () => {
  console.log(`🚀 Workspace server on :${PORT}`);
  console.log(`   POST /api/chat/create`);
  console.log(`   GET  /api/chat/stream?sid=...`);
  console.log(`   GET  /api/paper/state`);
});

server.timeout = 600000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
