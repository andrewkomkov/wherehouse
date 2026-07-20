/**
 * Data attribution.
 *
 * Kontur Population is CC BY 4.0 — crediting it wherever the map is shown is a **licence
 * obligation**, not a courtesy, and the repo goes public under MIT to an international jury.
 * (FR-017, SC-008.) It lives in the rail's footer so it is on screen for every view that shows
 * the map, and it cannot be toggled off with a layer.
 *
 * The snapshot date is here for a different reason: the population is from 2023-11-01, and a
 * map that silently implies live demand is overstating what we know. People move slower than
 * shops open, so it is the stable half of the score — but it is not live, and saying so costs
 * us nothing and buys us honesty a judge can check. (FR-018.)
 *
 * The score line sits with it on purpose. "A ranking heuristic, not a measurement" is FR-019,
 * and the place a sceptic looks for the small print is exactly where the licences are.
 */
export function Attribution() {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 9,
        lineHeight: 1.6,
        color: "#4c5560",
      }}
    >
      Score = demand × (100 − supply) / 100 · a ranking heuristic, not a measurement.
      <br />
      Population ©{" "}
      <A href="https://data.humdata.org/dataset/kontur-population-dataset">Kontur</A> (
      <A href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</A>), 2023-11-01 snapshot
      <br />
      Places, buildings &amp; districts © <A href="https://overturemaps.org">Overture Maps</A> · Basemap ©{" "}
      <A href="https://openstreetmap.org">OpenStreetMap</A>,{" "}
      <A href="https://protomaps.com">Protomaps</A>
    </div>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#69737d" }}>
      {children}
    </a>
  );
}
