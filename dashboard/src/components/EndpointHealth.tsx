import type { Stats } from "../api";
import { endpointLabel } from "../format";

/** One row per receiver: where are deliveries succeeding, retrying, dying? */
export function EndpointHealth({ endpoints }: { endpoints: Stats["endpoints"] }) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Receivers</h2>
          <p className="muted">Delivery state per registered endpoint</p>
        </div>
      </header>
      {endpoints.length === 0 ? (
        <p className="muted empty">No endpoints registered yet.</p>
      ) : (
        <ul className="endpoints">
          {endpoints.map((e) => {
            const total = e.succeeded + e.retrying + e.dead;
            const parts = [
              { key: "good", n: e.succeeded },
              { key: "warning", n: e.retrying },
              { key: "critical", n: e.dead },
            ].filter((p) => p.n > 0);
            return (
              <li key={e.id}>
                <div className="endpoint-name">
                  <strong>{endpointLabel(e)}</strong>
                  <span className="muted mono">{e.url}</span>
                </div>
                <div className="meter" aria-hidden="true">
                  {total === 0 ? (
                    <span className="meter-empty" />
                  ) : (
                    parts.map((p) => (
                      <span key={p.key} className={`fill-${p.key}`} style={{ flexGrow: p.n }} />
                    ))
                  )}
                </div>
                <div className="endpoint-counts">
                  <span title="Delivered">✓ {e.succeeded}</span>
                  <span title="Queued or retrying">↻ {e.retrying}</span>
                  <span title="Dead-lettered" className={e.dead > 0 ? "text-critical" : undefined}>✕ {e.dead}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
