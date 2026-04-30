import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Flight Tracker",
  description: "Ambient live air traffic"
};

// Why: TooltipProvider and Sonner Toaster were mounted at root after the
// shadcn install but never used anywhere in the actual UI. They're cheap
// individually but they're tree-depth + portal setup the cold start was
// paying for nothing. Add them back here when the first Tooltip or toast
// landing site appears.
export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", inter.variable)}>
      <body className="h-svh overflow-hidden bg-background text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
