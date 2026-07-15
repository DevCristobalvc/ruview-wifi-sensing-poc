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

const PORT = Number(process.env.PORT || 8090);
const SENSOR_CMD =
  process.env.SENSOR_CMD ||
  "C:/Users/Public/cristobal/ruview/poc/sensor/target/release/ruview-rssi-sensor.exe";
const SENSOR_INTERVAL = process.env.SENSOR_INTERVAL_MS || "250";
const HISTORY_MAX = 600; // ~2.5 min at 4 Hz
const EVENTS_MAX = 200;

const detector = new MotionDetector(8000);
let latest: Frame | null = null;
const history: Frame[] = [];
const events: SensingEvent[] = [];

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
