"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ---- Backend config (overridable at runtime for ngrok demos) ---------------
const DEFAULT_BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8090";

function wsUrlFrom(base: string): string {
  return base.replace(/^http/, "ws").replace(/\/$/, "") + "/stream";
}
function api(base: string, path: string) {
  return base.replace(/\/$/, "") + path;
}
const NGROK_HEADERS = { "ngrok-skip-browser-warning": "true" };

// ---- Types ------------------------------------------------------------------
interface Ap { bssid: string; ssid: string; rssi: number; z: number; }
interface Frame {
  kind: "frame"; t: number; state: string; calibrating: boolean;
  motionScore: number; motionRaw: number; apCount: number; aps: Ap[];
}
interface Ev {
  kind: "event"; t: number; type: "motion_started" | "motion_stopped";
  motionScore: number; durationMs?: number;
}
interface ChatMsg { role: "user" | "assistant"; content: string; }

export default function Page() {
  const [backend, setBackend] = useState(DEFAULT_BACKEND);
  const [connected, setConnected] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const scoreHist = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Load saved backend url
  useEffect(() => {
    const saved = localStorage.getItem("ruview_backend");
    if (saved) setBackend(saved);
  }, []);

  // WebSocket stream
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (stop) return;
      try {
        ws = new WebSocket(wsUrlFrom(backend));
      } catch {
        retry = setTimeout(connect, 2000);
        return;
      }
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.kind === "frame") {
          setFrame(m as Frame);
          const h = scoreHist.current;
          h.push(m.motionScore);
          if (h.length > 240) h.shift();
        } else if (m.kind === "event") {
          setEvents((prev) => [...prev.slice(-40), m as Ev]);
        }
      };
    };
    connect();
    return () => { stop = true; clearTimeout(retry); ws?.close(); };
  }, [backend]);

  // Draw motion sparkline
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = scoreHist.current;
    const maxY = Math.max(3, ...data);

    // threshold line at 1.6
    ctx.strokeStyle = "#f8717155"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    const ty = h - (1.6 / maxY) * h;
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
    ctx.setLineDash([]);

    if (data.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2;
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (v / maxY) * h;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      // fill
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = "#38bdf815"; ctx.fill();
    }
  }, [frame]);

  const stateClass =
    frame?.state === "motion" ? "state-motion"
    : frame?.state === "calibrating" || frame?.calibrating ? "state-calibrating"
    : "state-quiet";
  const stateLabel =
    !frame ? "CONECTANDO"
    : frame.calibrating || frame.state === "calibrating" ? "CALIBRANDO"
    : frame.state === "motion" ? "MOVIMIENTO" : "QUIETO";

  const saveBackend = (url: string) => {
    setBackend(url); localStorage.setItem("ruview_backend", url);
  };

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next); setInput(""); setBusy(true);
    try {
      const res = await fetch(api(backend, "/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...NGROK_HEADERS },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply || data.error || "(sin respuesta)" }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Error: " + e.message }]);
    } finally { setBusy(false); }
  }, [backend, messages, busy]);

  const analyze = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: "Analiza la actividad reciente." }]);
    try {
      const res = await fetch(api(backend, "/api/analyze"), {
        method: "POST", headers: { ...NGROK_HEADERS },
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply || data.error }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Error: " + e.message }]);
    } finally { setBusy(false); }
  }, [backend, busy]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy]);

  const fmt = (t: number) => new Date(t).toLocaleTimeString("es", { hour12: false });

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <h1>π RuView · Sensado WiFi</h1>
          <span className="sub">presencia y movimiento con RSSI real · agente DeepSeek</span>
        </div>
        <div className="conn">
          <span className={"dot" + (connected ? " on" : "")} />
          {connected ? "en vivo" : "sin conexión"}
          <span className="cfg" style={{ marginLeft: 10 }}>
            <input
              defaultValue={backend}
              onBlur={(e) => saveBackend(e.target.value)}
              spellCheck={false}
              placeholder="https://xxxx.ngrok-free.app"
            />
          </span>
        </div>
      </header>

      <div className="grid">
        {/* LEFT: live sensing */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <h2>Estado en vivo</h2>
            <div className="presence">
              <div className={"state-badge " + stateClass}>{stateLabel}</div>
              <div className="metrics-row">
                <div className="metric">
                  <span className="v">{frame ? frame.motionScore.toFixed(2) : "–"}</span>
                  <span className="l">energía de movimiento</span>
                </div>
                <div className="metric">
                  <span className="v">{frame ? frame.apCount : "–"}</span>
                  <span className="l">puntos de acceso</span>
                </div>
              </div>
            </div>
            <canvas className="spark" ref={canvasRef} />
            <div className="note">
              Línea punteada = umbral de movimiento. La energía es el z-score RMS de la
              variación de RSSI respecto a la línea base (técnica de ruvnet/ruview).
            </div>
          </div>

          <div className="panel">
            <h2>Puntos de acceso (RSSI real)</h2>
            {frame?.aps?.length ? frame.aps.map((a) => {
              const pct = Math.max(4, Math.min(100, (a.rssi + 100) * 1.6));
              return (
                <div className="ap" key={a.bssid}>
                  <span className="name">{a.ssid || "(oculto)"}</span>
                  <span className="rssi">{a.rssi} dBm</span>
                  <span className="bar"><i style={{ width: pct + "%", background: Math.abs(a.z) > 1.6 ? "#f87171" : "#38bdf8" }} /></span>
                  <span className="rssi" style={{ width: 54, textAlign: "right" }}>z {a.z.toFixed(1)}</span>
                </div>
              );
            }) : <div className="note">Esperando datos del sensor…</div>}
          </div>
        </div>

        {/* RIGHT: events + chat */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <h2>Eventos</h2>
            <div className="events">
              {events.length ? [...events].reverse().map((e, i) => (
                <div className={"ev " + (e.type === "motion_started" ? "start" : "stop")} key={i}>
                  <span className="t">{fmt(e.t)}</span>
                  <span className="tag">{e.type === "motion_started" ? "▲ movimiento" : "▼ fin"}</span>
                  <span style={{ color: "var(--muted)" }}>
                    score {e.motionScore.toFixed(2)}{e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : ""}
                  </span>
                </div>
              )) : <div className="note">Sin eventos aún. Muévete cerca del equipo para generar uno.</div>}
            </div>
          </div>

          <div className="panel chat">
            <h2>Agente conversacional</h2>
            <div className="log" ref={logRef}>
              {messages.length === 0 && (
                <div className="msg assistant">
                  Hola 👋 Soy tu asistente de sensado WiFi. Pregúntame por el estado de la
                  habitación, pídeme un resumen, o toca “Analizar”.
                </div>
              )}
              {messages.map((m, i) => (
                <div className={"msg " + m.role} key={i}>{m.content}</div>
              ))}
              {busy && <div className="msg assistant">…</div>}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <button type="button" className="btn ghost" onClick={analyze} disabled={busy}>Analizar</button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="¿Hay alguien en la sala?"
              />
              <button type="submit" className="btn" disabled={busy || !input.trim()}>Enviar</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
