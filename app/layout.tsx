// Root layout: denext supplies <html>/<head>/<body>. Closing the window closes it (Fleet stays in
// the tray; desktop.ts).
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "Fleet",
  description: "Brainwires GitHub Actions jobs and self-hosted runner pools, live",
  head:
    `<link rel="preload" href="/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>` +
    `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
