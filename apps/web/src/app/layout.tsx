import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Weaver",
  description: "A graphical agent harness built from context blocks.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      {/* The shell owns scrolling: the page itself never scrolls, so the tab
          bar stays pinned and only the content column moves. */}
      <body className="flex h-full flex-col overflow-hidden font-mono text-xs dark">
        {children}
      </body>
    </html>
  );
}
