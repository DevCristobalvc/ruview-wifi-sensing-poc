// Self-contained HTML API documentation served at the backend root ("/").
// Lets anyone opening the ngrok URL see what the backend exposes.

export const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://ruviu.vercel.app";

export function docsHtml(port: number): string {
  const ep = (
    method: string,
    path: string,
    desc: string,
    example: string
  ) => `
    <div class="ep">
      <div class="ep-head"><span class="m ${method.toLowerCase()}">${method}</span><code>${path}</code></div>
      <p>${desc}</p>
      <pre>${example}</pre>
    </div>`;

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuViu · API de sensado WiFi</title>
<style>
  :root{--bg:#070b12;--panel:#111826;--panel2:#172032;--border:#212c40;--text:#e8eef6;--muted:#8695ab;--accent:#38bdf8;--green:#34d399;--amber:#fbbf24}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 70px}
  h1{font-size:26px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:16px}
  .ep{border-top:1px solid var(--border);padding:14px 0} .ep:first-of-type{border-top:none}
  .ep-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
  .m{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px}
  .m.get{background:#0e3a2e;color:var(--green)} .m.post{background:#3a2f0e;color:var(--amber)} .m.ws{background:#0e2a3a;color:var(--accent)}
  p{margin:4px 0;color:#c7d2e0;font-size:14px}
  pre{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;font-size:12.5px;color:#aeb9cc;margin:8px 0 0}
  a{color:var(--accent)} .pill{display:inline-block;background:var(--panel2);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--muted);margin-right:6px}
  .ok{color:var(--green)}
</style></head><body><div class="wrap">
  <h1>π RuViu · API de sensado WiFi</h1>
  <p class="sub">Backend en vivo · datos WiFi 100% reales (RSSI) · detección de movimiento + agente DeepSeek</p>
  <p><span class="pill">Estado: <span class="ok">en línea</span></span><span class="pill">Puerto local: ${port}</span><span class="pill"><a href="${DASHBOARD_URL}">Abrir dashboard →</a></span></p>

  <div class="card">
    <h2 style="font-size:15px;margin:0 0 6px">¿Qué es esto?</h2>
    <p>Este servidor convierte la tarjeta WiFi del equipo en un sensor de presencia. Lee el RSSI (intensidad de señal, en dBm) de los routers cercanos; cuando una persona se mueve, altera las reflexiones de radio y el RSSI se desvía de su línea base. Esa desviación (z-score) se agrega en una "energía de movimiento" que dispara eventos de presencia. No usa cámaras ni wearables.</p>
    <p style="margin-top:8px"><b>Nota:</b> el ritmo cardíaco / respiración requiere CSI multi-subportadora (nodo ESP32-S3); no se puede medir con la tarjeta WiFi de una laptop. Esta API entrega movimiento y presencia reales.</p>
  </div>

  <div class="card">
    <h2 style="font-size:15px;margin:0 0 6px">Endpoints</h2>
    ${ep("WS", "/stream", "WebSocket en tiempo real. Emite frames de sensado y eventos de movimiento.", `{ "kind":"frame", "state":"quiet|motion|calibrating", "motionScore":0.42,\n  "apCount":13, "avgRssi":-71, "bands":{"g24":6,"g5":6,"g6":1}, "aps":[...] }\n{ "kind":"event", "type":"motion_started", "motionScore":1.8 }`)}
    ${ep("GET", "/api/health", "Estado del servidor y del sensor.", `{ "ok":true, "sensor":"streaming", "uptime":123.4 }`)}
    ${ep("GET", "/api/state", "Último frame de sensado.", `{ "state":"quiet", "motionScore":0.18, "apCount":13, "aps":[...] }`)}
    ${ep("GET", "/api/history", "Historial reciente de frames (query ?n=N).", `[ { "t":..., "motionScore":0.2, ... }, ... ]`)}
    ${ep("GET", "/api/events", "Registro de eventos de movimiento.", `[ { "type":"motion_started", "t":..., "motionScore":1.9 }, ... ]`)}
    ${ep("GET", "/api/stats", "Métricas de sesión.", `{ "uptimeSec":600, "totalFrames":2400, "motionEvents":7,\n  "peakMotion":3.1, "occupancyRatio":12 }`)}
    ${ep("GET", "/api/insight", "Interpretación (sin LLM) de la tendencia del gráfico de energía.", `{ "trend":"rising|falling|stable", "level":"bajo|moderado|alto",\n  "now":0.5, "recent":1.1, "peak":6.7, "text":"Actividad en aumento…" }`)}
    ${ep("POST", "/api/recalibrate", "Reinicia la línea base del detector (calibración limpia para demos).", `→ { "ok":true }`)}
    ${ep("POST", "/api/chat", "Agente conversacional DeepSeek con contexto de sensado en vivo.", `body: { "messages":[{"role":"user","content":"¿Hay alguien en la sala?"}] }\n→ { "reply":"Sí, detecto movimiento reciente…" }`)}
    ${ep("POST", "/api/analyze", "Resumen en lenguaje natural de la actividad reciente.", `→ { "reply":"En los últimos minutos hubo 3 eventos…" }`)}
  </div>

  <p class="sub" style="margin-top:20px">Código: <a href="https://github.com/DevCristobalvc/ruview-wifi-sensing-poc">GitHub</a> · Basado en <a href="https://github.com/ruvnet/ruview">ruvnet/ruview</a></p>
</div></body></html>`;
}
