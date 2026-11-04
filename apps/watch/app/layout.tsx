import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "What we watched",
  description: "Mark the films you have seen and how much each of you liked them.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f2a44" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
