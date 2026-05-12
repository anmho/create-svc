import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "{{SERVICE_NAME}}",
  description: "Agent-first ConnectRPC app",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
