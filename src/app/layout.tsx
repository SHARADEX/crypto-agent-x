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
  title: "CryptoEarn Agent — Autonomous Zero-Cost Crypto Earning Agent",
  description:
    "Operator dashboard for the autonomous multi-agent crypto earning system. Discover, verify, score, execute, and verify payment across bounties, hackathons, grants, and more — at zero cost.",
  keywords: [
    "CryptoEarn",
    "autonomous agent",
    "crypto earning",
    "bounty hunter",
    "multi-agent",
    "Next.js",
    "dashboard",
  ],
  authors: [{ name: "CryptoEarn Agent" }],
  icons: {
    icon: "/agent-logo.png",
  },
  openGraph: {
    title: "CryptoEarn Agent",
    description: "Autonomous zero-cost crypto earning agent dashboard",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CryptoEarn Agent",
    description: "Autonomous zero-cost crypto earning agent dashboard",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
        {/* suppressHydrationWarning on the wrapper div to prevent Radix UI
            ID mismatch errors (radix generates different IDs on server vs
            client — this is a known issue with SSR + Radix components). */}
        <div suppressHydrationWarning>
          {children}
        </div>
      </body>
    </html>
  );
}
