"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const DEFAULT_BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8090";

function wsUrlFrom(base: string) { return base.replace(/^http/, "ws").replace(/\/$/, "") + "/stream"; }
function api(base: string, path: string) { return base.replace(/\/$/, "") + path; }
const NGROK = { "ngrok-skip-browser-warning": "true" };
const validUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u.trim());

interface Ap { bssid: string; ssid: string; rssi: number; z: number; }
interface Frame {
  kind: "frame"; t: number; state: string; calibrating: boolean;
  motionScore: number; motionRaw: number; apCount: number; aps: Ap[];
  avgRssi: number; bands: { g24: number; g5: number; g6: number }; activeAps: number;
}
interface Ev { kind: "event"; t: number; type: "motion_started" | "motion_stopped"; motionScore: number; durationMs?: number; }
interface Stats { uptimeSec: number; totalFrames: number; totalEvents: number; motionEvents: number; peakMotion: number; occupancyRatio: number; }
interface Insight { trend: string; level: string; text: string; now?: number; recent?: number; peak?: number; }
interface ChatMsg { role: "user" | "assistant"; content: string; narrate?: boolean; }

const SUGGESTIONS = [
  "¿Hay alguien en la sala?",
  "Resume la actividad reciente",
  "¿Puedes medir mi ritmo cardíaco?",
  "¿Qué tan fiable es esta detección?",
];

export default function Page() {
  const [backend, setBackend] = useState(DEFAULT_BACKEND);
  const [urlOk, setUrlOk] = useState(true);
  const [connected, setConnected] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);

  const scoreHist = useRef<number[]>([]);
  const frameRef = useRef<Frame | null>(null);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);
  const radarRef = useRef<HTMLCanvasElement | null>(null);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoNarrate, setAutoNarrate] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Live-test + demo controls
  const [flash, setFlash] = useState(false);
  const [recalMsg, setRecalMsg] = useState("");
  const [test, setTest] = useState<{ phase: "idle" | "baseline" | "active" | "done"; count: number; msg: string; base?: number; peak?: number; detected?: boolean }>({ phase: "idle", count: 0, msg: "" });
  const testRef = useRef(test);
  testRef.current = test;

  useEffect(() => {
    const saved = localStorage.getItem("ruview_backend");
    if (saved) { setBackend(saved); setUrlOk(validUrl(saved)); }
  }, []);

  // Health check on backend change (validation)
  useEffect(() => {
    if (!validUrl(backend)) { setUrlOk(false); setReachable(false); return; }
    setUrlOk(true);
    let cancel = false;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    fetch(api(backend, "/api/health"), { headers: { ...NGROK }, signal: ctrl.signal })
      .then((r) => r.ok).then((ok) => !cancel && setReachable(ok))
      .catch(() => !cancel && setReachable(false))
      .finally(() => clearTimeout(to));
    return () => { cancel = true; ctrl.abort(); };
  }, [backend]);

  // WebSocket stream
  useEffect(() => {
    if (!validUrl(backend)) return;
    let ws: WebSocket | null = null, stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (stop) return;
      try { ws = new WebSocket(wsUrlFrom(backend)); } catch { retry = setTimeout(connect, 2000); return; }
      ws.onopen = () => { setConnected(true); setReachable(true); };
      ws.onclose = () => { setConnected(false); if (!stop) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.kind === "frame") {
          setFrame(m); frameRef.current = m;
          const h = scoreHist.current; h.push(m.motionScore); if (h.length > 240) h.shift();
        } else if (m.kind === "event") {
          setEvents((p) => [...p.slice(-40), m]);
          if (m.type === "motion_started") { setFlash(true); setTimeout(() => setFlash(false), 700); }
        }
      };
    };
    connect();
    return () => { stop = true; clearTimeout(retry); ws?.close(); };
  }, [backend]);

  // Poll stats + insight
  useEffect(() => {
    if (!validUrl(backend)) return;
    let stop = false;
    const tick = async () => {
      try {
        const [s, i] = await Promise.all([
          fetch(api(backend, "/api/stats"), { headers: { ...NGROK } }).then((r) => r.json()),
          fetch(api(backend, "/api/insight"), { headers: { ...NGROK } }).then((r) => r.json()),
        ]);
        if (!stop) { setStats(s); setInsight(i); }
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [backend]);

  // Radar animation (continuous)
  useEffect(() => {
    const cv = radarRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1; const S = 260;
    cv.width = S * dpr; cv.height = S * dpr;
    const ctx = cv.getContext("2d")!; ctx.scale(dpr, dpr);
    let raf = 0, angle = 0;
    const cx = S / 2, cy = S / 2, R = S / 2 - 8;
    const draw = () => {
      const f = frameRef.current;
      const motion = f ? Math.min(1, f.motionScore / 3) : 0;
      const isMotion = f?.state === "motion";
      ctx.clearRect(0, 0, S, S);
      // rings
      ctx.strokeStyle = "#1e2a40"; ctx.lineWidth = 1;
      for (let r = R / 3; r <= R; r += R / 3) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      // sweep
      const speed = 0.012 + motion * 0.04;
      angle += speed;
      const grad = ctx.createConicGradient?.(angle, cx, cy);
      if (grad) {
        grad.addColorStop(0, isMotion ? "#f8717133" : "#38bdf833");
        grad.addColorStop(0.12, "transparent");
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, angle - 0.5, angle); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = isMotion ? "#f87171" : "#38bdf8"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R); ctx.stroke();
      // blips = APs (angle from bssid hash, radius from rssi)
      const aps = f?.aps || [];
      aps.forEach((a) => {
        let hash = 0; for (let i = 0; i < a.bssid.length; i++) hash = (hash * 31 + a.bssid.charCodeAt(i)) & 0xffff;
        const ang = (hash / 0xffff) * Math.PI * 2;
        const rr = Math.max(0.15, Math.min(1, (a.rssi + 95) / 60)) * R;
        const bx = cx + Math.cos(ang) * rr, by = cy + Math.sin(ang) * rr;
        const hot = Math.abs(a.z) > 1.6;
        ctx.fillStyle = hot ? "#f87171" : "#38bdf8";
        ctx.globalAlpha = hot ? 1 : 0.7;
        ctx.beginPath(); ctx.arc(bx, by, hot ? 4.5 : 3, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      });
      // center pulse
      const pr = 6 + Math.sin(angle * 4) * 2 + motion * 10;
      ctx.fillStyle = isMotion ? "#f8717166" : "#38bdf844";
      ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isMotion ? "#f87171" : "#38bdf8";
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  // Energy area chart
  useEffect(() => {
    const cv = sparkRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d")!; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const data = scoreHist.current; const maxY = Math.max(3, ...data);
    // grid
    ctx.strokeStyle = "#16202f"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = (i / 4) * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    // threshold
    ctx.strokeStyle = "#f8717166"; ctx.setLineDash([5, 4]);
    const ty = h - (1.6 / maxY) * h; ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f8717199"; ctx.font = "10px sans-serif"; ctx.fillText("umbral", 4, ty - 4);
    if (data.length > 1) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#38bdf855"); grad.addColorStop(1, "#38bdf800");
      ctx.beginPath(); ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2;
      data.forEach((v, i) => { const x = (i / (data.length - 1)) * w; const y = h - (v / maxY) * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    }
  }, [frame]);

  const stateClass = frame?.state === "motion" ? "state-motion"
    : frame?.calibrating || frame?.state === "calibrating" ? "state-calibrating" : "state-quiet";
  const stateLabel = !frame ? "···"
    : frame.calibrating || frame.state === "calibrating" ? "CALIBRANDO"
    : frame.state === "motion" ? "MOVIMIENTO" : "QUIETO";

  const saveBackend = (url: string) => { setBackend(url); localStorage.setItem("ruview_backend", url); setUrlOk(validUrl(url)); };

  const postChat = useCallback(async (msgs: ChatMsg[], narrate = false) => {
    setBusy(true);
    try {
      const res = await fetch(api(backend, "/api/chat"), {
        method: "POST", headers: { "Content-Type": "application/json", ...NGROK },
        body: JSON.stringify({ messages: msgs.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply || data.error || "(sin respuesta)", narrate }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Error de conexión: " + e.message }]);
    } finally { setBusy(false); }
  }, [backend]);

  const send = useCallback((text: string) => {
    if (!text.trim() || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next); setInput(""); postChat(next);
  }, [messages, busy, postChat]);

  // Auto-narrate every 20s
  useEffect(() => {
    if (!autoNarrate) return;
    const id = setInterval(() => {
      if (busy) return;
      postChat([{ role: "user", content: "En una frase corta y natural, narra qué está pasando ahora en la sala según el sensado." }], true);
    }, 20000);
    return () => clearInterval(id);
  }, [autoNarrate, busy, postChat]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [messages, busy]);

  // Recalibrate baseline on demand (clean start for a live demo)
  const recalibrate = useCallback(async () => {
    setRecalMsg("Recalibrando…");
    try {
      await fetch(api(backend, "/api/recalibrate"), { method: "POST", headers: { ...NGROK } });
      scoreHist.current = [];
      setRecalMsg("✓ Línea base reiniciada (calibrando ~8s)");
    } catch { setRecalMsg("✗ No se pudo recalibrar"); }
    setTimeout(() => setRecalMsg(""), 4000);
  }, [backend]);

  // Guided live test: stay still (measure baseline) → move (measure peak) → verdict.
  const liveTest = useCallback(() => {
    if (testRef.current.phase !== "idle" && testRef.current.phase !== "done") return;
    const baseSamples: number[] = [];
    let peak = 0;
    // Phase 1: baseline (4s)
    setTest({ phase: "baseline", count: 4, msg: "Quédate quieto…" });
    let bc = 4;
    const baseTimer = setInterval(() => {
      baseSamples.push(frameRef.current?.motionScore ?? 0);
      bc -= 1;
      if (bc <= 0) {
        clearInterval(baseTimer);
        const base = baseSamples.length ? baseSamples.reduce((a, c) => a + c, 0) / baseSamples.length : 0;
        // Phase 2: active (5s)
        let ac = 5;
        setTest({ phase: "active", count: ac, msg: "¡Muévete ahora! 🙋", base });
        const actTimer = setInterval(() => {
          peak = Math.max(peak, frameRef.current?.motionScore ?? 0);
          ac -= 1;
          if (ac <= 0) {
            clearInterval(actTimer);
            const detected = peak > base + 0.6 || peak >= 1.6;
            setTest({ phase: "done", count: 0, msg: "", base, peak, detected });
          } else {
            setTest((t) => ({ ...t, count: ac, peak }));
          }
        }, 1000);
      } else {
        setTest((t) => ({ ...t, count: bc }));
      }
    }, 1000);
  }, []);

  const fmt = (t: number) => new Date(t).toLocaleTimeString("es", { hour12: false });
  const upt = (s?: number) => s == null ? "–" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const arrow = insight?.trend === "rising" ? "▲" : insight?.trend === "falling" ? "▼" : "●";

  return (
    <div className="wrap">
      <div className={"flash-overlay" + (flash ? " on" : "")} />
      <header className="top">
        <div className="brand">
          <h1>π RuViu · Sensado WiFi</h1>
          <span className="sub">presencia y movimiento con RSSI real · agente DeepSeek</span>
        </div>
        <div className="conn">
          <span className={"dot" + (connected ? " on pulse" : "")} />
          {connected ? "en vivo" : reachable === false ? "backend no alcanzable" : "conectando…"}
          <span className="cfg" style={{ marginLeft: 10 }}>
            <input className={urlOk ? "" : "bad"} defaultValue={backend} spellCheck={false}
              onBlur={(e) => saveBackend(e.target.value)} placeholder="https://xxxx.ngrok-free.app" />
          </span>
        </div>
      </header>

      {!urlOk && (
        <div className="banner err">⚠️ La URL del backend no es válida. Debe empezar por http(s)://</div>
      )}
      {urlOk && reachable === false && (
        <div className="banner warn">
          🔌 No se pudo alcanzar el backend. Verifica que el backend local esté corriendo y que la URL de ngrok sea la actual (cambia al reiniciar ngrok).
        </div>
      )}

      <div className="grid">
        <div className="col">
          {/* LIVE VALIDATION — para demostrar en vivo que funciona */}
          <div className="panel">
            <h2>✅ Validación en vivo</h2>
            <div className="test-row">
              <button className="btn" onClick={liveTest} disabled={test.phase === "baseline" || test.phase === "active"}>
                ▶ Iniciar prueba de movimiento
              </button>
              <button className="btn ghost" onClick={recalibrate}>↻ Recalibrar línea base</button>
              {recalMsg && <span className="note" style={{ margin: 0 }}>{recalMsg}</span>}
            </div>
            {test.phase === "idle" && (
              <div className="note" style={{ marginTop: 12 }}>
                Pulsa la prueba: primero quédate quieto unos segundos y luego muévete. El sistema comprobará en vivo si detecta tu movimiento — ideal para demostrar a alguien que sí funciona.
              </div>
            )}
            {(test.phase === "baseline" || test.phase === "active") && (
              <div className={"test-live " + test.phase}>
                <div className="test-count">{test.count}</div>
                <div className="test-msg">{test.msg}</div>
                {test.phase === "active" && <div className="test-peak">pico actual: {(test.peak ?? 0).toFixed(2)}</div>}
              </div>
            )}
            {test.phase === "done" && (
              <div className={"test-result " + (test.detected ? "ok" : "no")}>
                <div className="tr-head">{test.detected ? "✅ Movimiento detectado" : "❌ No se detectó movimiento"}</div>
                <div className="tr-body">
                  Base en reposo: <b>{(test.base ?? 0).toFixed(2)}</b> · Pico al moverte: <b>{(test.peak ?? 0).toFixed(2)}</b>
                  {!test.detected && <div className="note" style={{ marginTop: 6 }}>Acércate más al equipo o muévete con más amplitud y repite.</div>}
                </div>
              </div>
            )}
          </div>

          {/* HERO */}
          <div className="panel">
            <div className="hero">
              <div className="radar-wrap"><canvas className="radar" ref={radarRef} /></div>
              <div>
                <div className={"state-badge " + stateClass}>{stateLabel}</div>
                <div className="big-metrics">
                  <div className="metric"><span className="v">{frame ? frame.motionScore.toFixed(2) : "–"}</span><span className="l">energía movim.</span></div>
                  <div className="metric"><span className="v">{frame?.apCount ?? "–"}</span><span className="l">puntos acceso</span></div>
                  <div className="metric"><span className="v">{frame ? frame.avgRssi : "–"}</span><span className="l">RSSI medio dBm</span></div>
                  <div className="metric"><span className="v" style={{ color: frame?.activeAps ? "var(--red)" : undefined }}>{frame?.activeAps ?? "–"}</span><span className="l">APs reactivos</span></div>
                </div>
                {frame && (
                  <div className="bands">
                    <span className="chip">2.4 GHz <b>{frame.bands.g24}</b></span>
                    <span className="chip">5 GHz <b>{frame.bands.g5}</b></span>
                    <span className="chip">6 GHz <b>{frame.bands.g6}</b></span>
                  </div>
                )}
              </div>
            </div>
            {insight && (
              <div className="insight">
                <span className={"arrow " + insight.trend}>{arrow}</span>
                <span className="txt"><b>Interpretación en vivo:</b> {insight.text}</span>
              </div>
            )}
          </div>

          {/* ENERGY CHART */}
          <div className="panel">
            <h2>Energía de movimiento (z-score RMS)</h2>
            <canvas className="spark" ref={sparkRef} />
            <div className="note">Cuando alguien se mueve, perturba las reflexiones de radio y el RSSI se desvía de su línea base. Al cruzar el umbral se registra un evento de presencia.</div>
          </div>

          {/* AP LIST */}
          <div className="panel">
            <h2>Puntos de acceso · RSSI real</h2>
            {frame?.aps?.length ? frame.aps.map((a) => {
              const pct = Math.max(4, Math.min(100, (a.rssi + 100) * 1.6));
              const hot = Math.abs(a.z) > 1.6;
              return (
                <div className="ap" key={a.bssid}>
                  <span className="name">{a.ssid || "(oculto)"}</span>
                  <span className="rssi">{a.rssi} dBm</span>
                  <span className="bar"><i style={{ width: pct + "%", background: hot ? "linear-gradient(90deg,#f87171,#fbbf24)" : "linear-gradient(90deg,#38bdf8,#818cf8)" }} /></span>
                  <span className="zb" style={{ color: hot ? "var(--red)" : "var(--muted)" }}>z {a.z.toFixed(1)}</span>
                </div>
              );
            }) : <div className="note">Esperando datos del sensor…</div>}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="col">
          {/* STATS */}
          <div className="panel">
            <h2>Métricas de sesión</h2>
            <div className="stats">
              <div className="stat"><div className="n">{upt(stats?.uptimeSec)}</div><div className="k">tiempo activo</div></div>
              <div className="stat"><div className="n">{stats?.motionEvents ?? "–"}</div><div className="k">eventos movim.</div></div>
              <div className="stat"><div className="n">{stats?.peakMotion?.toFixed(2) ?? "–"}</div><div className="k">energía máx.</div></div>
              <div className="stat"><div className="n">{stats ? stats.occupancyRatio + "%" : "–"}</div><div className="k">ocupación</div></div>
              <div className="stat"><div className="n">{stats?.totalFrames ?? "–"}</div><div className="k">muestras</div></div>
              <div className="stat"><div className="n">{insight?.peak?.toFixed(2) ?? "–"}</div><div className="k">pico reciente</div></div>
            </div>
          </div>

          {/* EVENTS */}
          <div className="panel">
            <h2>Eventos</h2>
            <div className="events">
              {events.length ? [...events].reverse().map((e, i) => (
                <div className={"ev " + (e.type === "motion_started" ? "start" : "stop")} key={i}>
                  <span className="t">{fmt(e.t)}</span>
                  <span className="tag">{e.type === "motion_started" ? "▲ movimiento" : "▼ fin"}</span>
                  <span style={{ color: "var(--muted)" }}>score {e.motionScore.toFixed(2)}{e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : ""}</span>
                </div>
              )) : <div className="note">Sin eventos aún. Muévete cerca del equipo para generar uno.</div>}
            </div>
          </div>

          {/* CHAT */}
          <div className="panel chat">
            <h2>Agente conversacional</h2>
            <div className="toolbar">
              <label className="switch"><input type="checkbox" checked={autoNarrate} onChange={(e) => setAutoNarrate(e.target.checked)} /> auto-narración (20s)</label>
              {busy && <span className="spinner" />}
            </div>
            <div className="chips">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} disabled={busy}>{s}</button>)}
            </div>
            <div className="log" ref={logRef}>
              {messages.length === 0 && (
                <div className="msg assistant">Hola 👋 Soy tu asistente de sensado WiFi. Pregúntame por el estado de la sala, o por cómo funciona el proyecto (arquitectura, si necesitas estar cerca del router, cómo probarlo…).</div>
              )}
              {messages.map((m, i) => (
                <div className={"msg " + m.role + (m.narrate ? " narrate" : "")} key={i}>{m.content}</div>
              ))}
              {busy && <div className="msg assistant"><span className="spinner" /></div>}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <input className="q" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Escribe tu pregunta…" />
              <button type="submit" className="btn" disabled={busy || !input.trim()}>Enviar</button>
            </form>
          </div>
        </div>
      </div>

      <div className="note" style={{ textAlign: "center", marginTop: 22 }}>
        RuViu · datos WiFi 100% reales · sensor Rust (wifi-densepose-wifiscan) + backend Node + agente DeepSeek · <a href="https://github.com/DevCristobalvc/ruview-wifi-sensing-poc" style={{ color: "var(--accent)" }}>código en GitHub</a>
      </div>
    </div>
  );
}
