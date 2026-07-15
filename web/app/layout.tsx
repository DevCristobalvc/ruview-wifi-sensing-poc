import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RuView · Sensado WiFi en vivo",
  description:
    "Detección de presencia y movimiento con WiFi real (RSSI) + agente conversacional DeepSeek. PoC sobre ruvnet/ruview.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
