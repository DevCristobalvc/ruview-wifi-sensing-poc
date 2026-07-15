# π RuView WiFi-Sensing PoC — presencia y movimiento con datos WiFi reales + agente LLM

Prueba de concepto construida sobre [**ruvnet/ruview**](https://github.com/ruvnet/ruview)
(WiFi DensePose). Convierte **esta máquina** en un sensor de presencia usando el
**RSSI real** de los routers WiFi cercanos —sin cámaras, sin wearables— detecta
**movimiento** y lo expone en un **dashboard en vivo**, con un **agente
conversacional (DeepSeek)** que resume e interpreta la actividad en lenguaje natural.

> **100% datos reales.** No hay datos simulados en ninguna parte del pipeline.
> El sensor lee la señal de radio real que la tarjeta WiFi del equipo ya recibe.

## Cómo funciona (pipeline real de punta a punta)

```
 Tarjeta WiFi (Windows WLAN)
        │  RSSI real por punto de acceso (dBm)
        ▼
 [ sensor/ ]  Rust — usa el crate publicado `wifi-densepose-wifiscan` de ruvnet/ruview
        │      (WlanApiScanner::scan_native → wlanapi.dll nativo, sin parseo de texto,
        │       independiente del idioma del sistema). Emite 1 línea JSON por escaneo.
        ▼
 [ backend/ ] Node/TS — detección de movimiento por z-score sobre la varianza de RSSI
        │      (mismo enfoque Welford/anomalía que ruvnet/ruview). WebSocket + REST +
        │      agente DeepSeek con contexto de sensado en vivo.
        ▼
 [ web/ ]     Next.js (desplegable en Vercel) — dashboard en vivo + chat con el agente.
```

**La física:** cuando una persona se mueve, altera las reflexiones multipath de las
ondas de radio entre el router y el equipo. Eso se mide como una desviación del RSSI
respecto a su línea base. Agregando esa desviación (z-score RMS) sobre los puntos de
acceso obtenemos una "energía de movimiento" que dispara eventos de presencia.

## Alcance honesto

- ✅ **Movimiento / presencia**: real y funcional desde una laptop (RSSI).
- ❌ **Ritmo cardíaco / respiración**: el algoritmo existe en ruvnet/ruview
  (`wifi-densepose-vitals`, banda 0.8–2.0 Hz + autocorrelación) pero **requiere CSI
  multi-subportadora de un nodo ESP32-S3**. Una tarjeta WiFi normal no expone CSI, así
  que esta PoC **no** mide vitales; el agente lo explica con honestidad si se le pregunta.
  Añadir un ESP32-S3 (~USD 9) habilitaría vitales sin cambiar la arquitectura.

## Requisitos

- Windows con WiFi (probado en Windows 11, interfaz WLAN activa).
- **Rust** con toolchain GNU (`rustup toolchain install stable-x86_64-pc-windows-gnu`).
  Se usa GNU porque no requiere el linker de Visual Studio.
- **Node.js 20.6+** (usa `process.loadEnvFile`).
- Una API key de **DeepSeek** (https://platform.deepseek.com).
- Opcional: **ngrok** (exponer el backend) y una cuenta de **Vercel** (front).

## Puesta en marcha (local)

```bash
# 1) Compilar el sensor (RSSI real)
cd sensor
cargo +stable-x86_64-pc-windows-gnu build --release

# 2) Backend
cd ../backend
cp .env.example .env      # y pon tu DEEPSEEK_API_KEY
npm install
npm start                 # http://localhost:8090  (WS: /stream)

# 3) Frontend
cd ../web
npm install
npm run dev               # http://localhost:3000
```

El dashboard trae un campo para apuntar el backend a cualquier URL (útil para ngrok),
que se guarda en el navegador.

## Exponer para la demo

```bash
# Backend público por ngrok
ngrok http 8090
# copia la URL https://xxxx.ngrok-free.app al input del dashboard (o a NEXT_PUBLIC_BACKEND_URL)
```

El **front se despliega en Vercel** (carpeta `web/`), y consume el backend local a
través del túnel ngrok.

## Estructura

| Carpeta    | Qué es |
|------------|--------|
| `sensor/`  | Micro-servicio Rust que emite RSSI real (crate `wifi-densepose-wifiscan`). |
| `backend/` | Ingesta, detección de movimiento, WebSocket/REST y agente DeepSeek. |
| `web/`     | Dashboard Next.js (Vercel): estado en vivo, RSSI, eventos y chat. |

## Créditos

Basado en el trabajo de [ruvnet/ruview](https://github.com/ruvnet/ruview) y su crate
[`wifi-densepose-wifiscan`](https://crates.io/crates/wifi-densepose-wifiscan). MIT.
