import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inventory · Strongest Home",
  description: "Inventory dashboard — Amazon, AWD, Proboxx and month-to-stock by product",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
