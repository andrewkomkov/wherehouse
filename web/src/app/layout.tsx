import "./fonts.css";

export const metadata = { title: "WhereHouse" };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/*
       * IBM Plex, self-hosted (day 5 / ADR-003).
       *
       * This used to be two Google Fonts <link>s — fine while served from Next, but the page
       * now ships as a static bundle out of ClickHouse (served by the Cloudflare Worker), and a
       * page that phones home to fonts.googleapis.com on load is not self-contained. `fonts.css`
       * (imported above) vendors the same woff2 bytes under `public/fonts/`, so this page loads
       * with zero external requests. The stack below still degrades correctly if a font fails
       * to load — Plex is the intent, not a hard dependency.
       */}
      <body style={{ margin: 0, background: "#0a0c0f" }}>{children}</body>
    </html>
  );
}
