import { BrightnessThemeProvider } from "@/lib/ui";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactElement, ReactNode } from "react";
import { getSdkPackage } from "@/lib/sdk-package";
import "@schemavaults/theme/globals.css";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const sdk = getSdkPackage();
const title = "sandbox-management-sdk · One API for every sandbox";

export const metadata: Metadata = {
  title,
  description: sdk.description,
  applicationName: sdk.name,
  keywords: ["sandbox", "docker", "vercel sandbox", "typescript", "sdk", "kysely", "postgres"],
  openGraph: { type: "website", title, description: sdk.description },
  twitter: { card: "summary", title, description: sdk.description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020817" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <BrightnessThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:ring-2 focus:ring-ring"
          >
            Skip to content
          </a>
          {children}
        </BrightnessThemeProvider>
      </body>
    </html>
  );
}
