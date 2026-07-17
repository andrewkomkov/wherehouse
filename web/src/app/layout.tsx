export const metadata = { title: "WhereHouse" };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/*
         * IBM Plex from Google Fonts.
         *
         * ⚠️ KNOWN CONFLICT, left deliberately rather than papered over. The design brief warns
         * against "exotic font CDNs" because ADR-003 may serve this page out of ClickHouse
         * itself, and a page that is self-contained apart from two external font requests is not
         * self-contained. This is fine while we serve from Next; the day the page moves into a
         * `web.layers`-style row, these two <link>s become the thing that still phones home.
         *
         * Fix when that day comes (day 5): self-host the two woff2 subsets, or drop to the
         * system stack. The stack below already degrades correctly — Plex is the intent, not a
         * dependency, and the fallbacks keep the layout intact.
         */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, background: "#0a0c0f" }}>{children}</body>
    </html>
  );
}
