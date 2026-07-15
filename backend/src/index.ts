// RuView PoC backend — real WiFi sensing + DeepSeek agent.
//
// - Spawns the Rust RSSI sensor (SENSOR_CMD) and reads its JSON line stream.
// - Runs motion/presence detection over the live RSSI.
// - Broadcasts frames over WebSocket (/stream) and keeps rolling history.
// - Exposes REST: /api/state, /api/history, /api/events, /api/chat, /api/analyze.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

// Load .env if present (Node >=20.6).
try {
  (process as any).loadEnvFile?.();
} catch {
  /* no .env file — rely on real env vars */
}

import http from "node:http";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { MotionDetector, type BssidObs, type Frame, type SensingEvent } from "./motion.js";
import { chat, buildContextSummary, type ChatMessage } from "./llm.js";
import { docsHtml } from "./docs.js";

const PORT = Number(process.env.PORT || 8090);
// Resolved relative to the backend/ working dir so a fresh clone works with no
// edits. Override with SENSOR_CMD in .env if the binary lives elsewhere.
const SENSOR_CMD =
  process.env.SENSOR_CMD ||
  "../sensor/target/release/ruview-rssi-sensor.exe";
const SENSOR_INTERVAL = process.env.SENSOR_INTERVAL_MS || "250";
const HISTORY_MAX = 600; // ~2.5 min at 4 Hz
const EVENTS_MAX = 200;

const detector = new MotionDetector(8000);
let latest: Frame | null = null;
const history: Frame[] = [];
const events: SensingEvent[] = [];

// Session stats
const startedAt = Date.now();
let peakMotion = 0;
let totalFrames = 0;
let motionFrames = 0;

// ---- WebSocket broadcast ----------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws) => {
  if (latest) ws.send(JSON.stringify({ kind: "frame", ...latest }));
  events.slice(-10).forEach((e) => ws.send(JSON.stringify({ kind: "event", ...e })));
});

function broadcast(obj: unknown) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

// ---- Sensor ingestion -------------------------------------------------------
function startSensor() {
  console.log(`[backend] spawning sensor: ${SENSOR_CMD} ${SENSOR_INTERVAL}`);
  const proc = spawn(SENSOR_CMD, [SENSOR_INTERVAL], { windowsHide: true });

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line.startsWith("{")) return;
    let parsed: { bssids: BssidObs[] };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed.bssids) return;

    const { frame, event } = detector.update(parsed.bssids);
    latest = frame;
    history.push(frame);
    if (history.length > HISTORY_MAX) history.shift();

    totalFrames++;
    if (!frame.calibrating) {
      if (frame.motionScore > peakMotion) peakMotion = frame.motionScore;
      if (frame.state === "motion") motionFrames++;
    }
    broadcast({ kind: "frame", ...frame });

    if (event) {
      events.push(event);
      if (events.length > EVENTS_MAX) events.shift();
      broadcast({ kind: "event", ...event });
      console.log(`[event] ${event.type} score=${event.motionScore}`);
    }
  });

  proc.stderr.on("data", (d) => process.stderr.write(`[sensor] ${d}`));
  proc.on("exit", (code) => {
    console.error(`[backend] sensor exited (code ${code}); restarting in 2s`);
    setTimeout(startSensor, 2000);
  });
}

// ---- REST -------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.type("html").send(docsHtml(PORT));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sensor: latest ? "streaming" : "starting", uptime: process.uptime() });
});

app.get("/api/state", (_req, res) => {
  res.json(latest || { state: "starting" });
});

app.get("/api/history", (_req, res) => {
  const n = Math.min(Number(req_n(_req)) || HISTORY_MAX, HISTORY_MAX);
  res.json(history.slice(-n));
});
function req_n(req: express.Request): string | undefined {
  return (req.query.n as string) || undefined;
}

app.get("/api/events", (_req, res) => {
  res.json(events.slice(-EVENTS_MAX));
});

app.post("/api/recalibrate", (_req, res) => {
  detector.reset();
  peakMotion = 0;
  console.log("[backend] recalibrated (baseline reset)");
  res.json({ ok: true });
});

app.get("/api/stats", (_req, res) => {
  res.json({
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    totalFrames,
    totalEvents: events.length,
    motionEvents: events.filter((e) => e.type === "motion_started").length,
    peakMotion: Math.round(peakMotion * 100) / 100,
    occupancyRatio: totalFrames ? Math.round((motionFrames / totalFrames) * 100) : 0,
    calibrating: latest?.calibrating ?? true,
  });
});

// Fast, LLM-free interpretation of the recent motion-energy graph.
app.get("/api/insight", (_req, res) => {
  const scores = history.slice(-48).map((f) => f.motionScore);
  if (scores.length < 6) {
    return res.json({ trend: "stable", level: "bajo", text: "Recopilando señal…" });
  }
  const half = Math.floor(scores.length / 2);
  const prior = avg(scores.slice(0, half));
  const recent = avg(scores.slice(half));
  const now = scores[scores.length - 1];
  const peak = Math.max(...scores);
  const delta = recent - prior;
  const trend = delta > 0.25 ? "rising" : delta < -0.25 ? "falling" : "stable";
  const level = now >= 1.6 ? "alto" : now >= 0.9 ? "moderado" : "bajo";

  let text: string;
  if (latest?.calibrating) text = "Calibrando la línea base del entorno…";
  else if (trend === "rising" && level !== "bajo")
    text = `Actividad en aumento: la energía subió de ${prior.toFixed(2)} a ${recent.toFixed(2)}. Probable movimiento cercano.`;
  else if (trend === "falling")
    text = `La actividad está bajando (de ${prior.toFixed(2)} a ${recent.toFixed(2)}). El entorno se está calmando.`;
  else if (level === "alto")
    text = `Movimiento sostenido: energía alta y estable (~${recent.toFixed(2)}). Presencia activa.`;
  else if (level === "moderado")
    text = `Fluctuaciones leves (~${recent.toFixed(2)}); posible movimiento sutil o cambios del entorno.`;
  else text = `Entorno tranquilo: energía baja y estable (~${recent.toFixed(2)}). Sin movimiento relevante.`;

  res.json({ trend, level, now: r2(now), recent: r2(recent), prior: r2(prior), peak: r2(peak), text });
});
function avg(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function r2(x: number): number { return Math.round(x * 100) / 100; }

function windowSummary(minutes = 10) {
  const cutoff = Date.now() - minutes * 60_000;
  const ev = events.filter((e) => e.t >= cutoff);
  return {
    state: latest?.state || "starting",
    motionScore: latest?.motionScore || 0,
    apCount: latest?.apCount || 0,
    calibrating: latest?.calibrating ?? true,
    topAps: (latest?.aps || []).map((a) => ({ ssid: a.ssid, z: a.z, rssi: a.rssi })),
    recentEvents: events.map((e) => ({
      t: e.t,
      type: e.type,
      motionScore: e.motionScore,
      durationMs: e.durationMs,
    })),
    windowMinutes: minutes,
    eventsInWindow: ev.length,
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const messages: ChatMessage[] = req.body?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] requerido" });
    }
    const context = buildContextSummary(windowSummary(10));
    const reply = await chat(messages, context);
    res.json({ reply });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/analyze", async (_req, res) => {
  try {
    const context = buildContextSummary(windowSummary(15));
    const reply = await chat(
      [
        {
          role: "user",
          content:
            "Dame un resumen breve y humano de la actividad detectada por WiFi en los últimos minutos: estado actual, si hubo movimiento, cuántos eventos y qué interpretas. 4-6 frases.",
        },
      ],
      context
    );
    res.json({ reply });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}  (WS: /stream)`);
  startSensor();
});
