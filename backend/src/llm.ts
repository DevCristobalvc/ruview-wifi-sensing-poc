// DeepSeek conversational agent over the live WiFi-sensing data.
//
// DeepSeek exposes an OpenAI-compatible chat API, so we call it with the
// global fetch. The agent is given a compact, always-fresh summary of the
// current sensing state so it can answer questions, summarise activity, and
// reason about what the WiFi signals imply — in a human, conversational way.

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `Eres "RuView Assistant", un agente conversacional que interpreta un sensor de presencia por WiFi.
El sistema usa RSSI real de los routers WiFi cercanos (sin cámaras ni wearables): cuando una persona se mueve, perturba las reflexiones de radio y eso se mide como una desviación (z-score) respecto a una línea base por punto de acceso. La energía de movimiento agregada (RMS z) indica actividad.

Reglas:
- Habla en español, de forma clara, cálida y humana (no robótica).
- Basa TODO lo que digas en el contexto de sensado que se te entrega; no inventes datos.
- Si te preguntan por ritmo cardíaco o respiración: explica con honestidad que eso requiere hardware CSI (ESP32-S3) y no se puede medir con la tarjeta WiFi de una laptop; esta demo detecta movimiento y presencia reales.
- Sé conciso salvo que pidan detalle. Puedes dar resúmenes, tendencias y recomendaciones.`;

export function buildContextSummary(ctx: {
  state: string;
  motionScore: number;
  apCount: number;
  calibrating: boolean;
  topAps: { ssid: string; z: number; rssi: number }[];
  recentEvents: { t: number; type: string; motionScore: number; durationMs?: number }[];
  windowMinutes: number;
  eventsInWindow: number;
}): string {
  const aps = ctx.topAps
    .slice(0, 6)
    .map((a) => `${a.ssid || "(oculto)"}: RSSI ${a.rssi} dBm, z=${a.z}`)
    .join("; ");
  const ev = ctx.recentEvents
    .slice(-6)
    .map((e) => {
      const ago = Math.round((Date.now() - e.t) / 1000);
      const dur = e.durationMs ? ` (duró ${Math.round(e.durationMs / 1000)}s)` : "";
      return `hace ${ago}s: ${e.type}${dur}`;
    })
    .join("; ");
  return [
    `CONTEXTO DE SENSADO (en vivo):`,
    `- Estado actual: ${ctx.calibrating ? "calibrando" : ctx.state}`,
    `- Energía de movimiento (RMS z): ${ctx.motionScore}`,
    `- Puntos de acceso WiFi observados: ${ctx.apCount}`,
    `- APs más reactivos: ${aps || "n/d"}`,
    `- Eventos en los últimos ${ctx.windowMinutes} min: ${ctx.eventsInWindow}`,
    `- Historial reciente: ${ev || "sin eventos"}`,
  ].join("\n");
}

export async function chat(messages: ChatMessage[], context: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return "⚠️ Falta configurar DEEPSEEK_API_KEY en el backend.";
  }
  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: context },
      ...messages,
    ],
    temperature: 0.6,
    max_tokens: 800,
  };

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() || "(respuesta vacía)";
}
