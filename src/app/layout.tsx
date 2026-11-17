import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpsPulse MCP — AI Incident & Task Assistant",
  description:
    "Production-grade Full-Stack Model Context Protocol (MCP) system with Human-in-the-Loop approval and live observability.",
};


export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
        <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >

      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
