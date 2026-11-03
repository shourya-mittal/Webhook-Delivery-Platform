import { useState } from "react";
import type { Stats } from "../api";
import { minuteLabel } from "../format";
import { useWidth } from "../usePoll";

type Minute = Stats["timeline"][number];

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 36 };
const GAP = 2; // surface gap between stacked segments

/** Round a y-axis maximum up to a clean number with 4 ticks. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v / 4));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * step * 4 >= v) return m * step * 4;
  }
  return v;
}

/** Column path: square at the baseline, 4px rounded data-end on top. */
function columnPath(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function AttemptsChart({ timeline }: { timeline: Minute[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const max = niceMax(Math.max(0, ...timeline.map((m) => m.okAttempts + m.failedAttempts)));
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const band = timeline.length ? innerW / timeline.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const y = (v: number) => (v / max) * innerH;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const total = timeline.reduce((n, m) => n + m.okAttempts + m.failedAttempts, 0);
  const hovered = hover !== null ? timeline[hover] : undefined;

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Delivery attempts per minute</h2>
          <p className="muted">Last 30 minutes · every HTTP request the workers sent</p>
        </div>
        <div className="legend" aria-label="Legend">
          <span><i className="swatch swatch-good" />Succeeded (2xx)</span>
          <span><i className="swatch swatch-critical" />Failed (error, timeout, non-2xx)</span>
          <button className="link" onClick={() => setShowTable((s) => !s)}>
            {showTable ? "Show chart" : "Show table"}
          </button>
        </div>
      </header>

      {showTable ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Minute</th><th className="num">Events</th><th className="num">Succeeded</th><th className="num">Failed</th></tr>
            </thead>
            <tbody>
              {[...timeline].reverse().map((m) => (
                <tr key={m.minute}>
                  <td>{minuteLabel(m.minute)}</td>
                  <td className="num">{m.events}</td>
                  <td className="num">{m.okAttempts}</td>
                  <td className="num">{m.failedAttempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
          {total === 0 && <div className="chart-empty muted">No attempts yet. Send an event to see traffic.</div>}
          {width > 0 && (
            <svg width={width} height={HEIGHT} role="img" aria-label={`Delivery attempts per minute, ${total} in the last 30 minutes`}>
              <g transform={`translate(${PAD.left},${PAD.top})`}>
                {ticks.map((t) => (
                  <g key={t} transform={`translate(0,${innerH - y(t)})`}>
                    <line x2={innerW} className={t === 0 ? "axis" : "grid"} />
                    <text x={-8} dy="0.32em" textAnchor="end" className="tick">{t}</text>
                  </g>
                ))}
                {timeline.map((m, i) => {
                  const x = i * band + (band - barW) / 2;
                  const okH = y(m.okAttempts);
                  const failH = y(m.failedAttempts);
                  const failGap = m.okAttempts > 0 && m.failedAttempts > 0 ? GAP : 0;
                  return (
                    <g key={m.minute} className={hover === i ? "col col-hover" : "col"}>
                      {m.okAttempts > 0 && (
                        <path
                          className="fill-good"
                          d={m.failedAttempts > 0
                            ? `M${x},${innerH}V${innerH - okH}H${x + barW}V${innerH}Z`
                            : columnPath(x, innerH - okH, barW, okH, 4)}
                        />
                      )}
                      {m.failedAttempts > 0 && (
                        <path
                          className="fill-critical"
                          d={columnPath(x, innerH - okH - failH, barW, Math.max(0, failH - failGap), 4)}
                        />
                      )}
                      {/* Hit target spans the whole band, taller than the mark. */}
                      <rect x={i * band} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                    </g>
                  );
                })}
                {[0, Math.floor(timeline.length / 2), timeline.length - 1].map((i) =>
                  timeline[i] ? (
                    <text key={i} x={i * band + band / 2} y={innerH + 16} textAnchor="middle" className="tick">
                      {i === timeline.length - 1 ? "now" : minuteLabel(timeline[i]!.minute)}
                    </text>
                  ) : null,
                )}
              </g>
            </svg>
          )}
          {hovered && hover !== null && (
            <div
              className="tooltip"
              style={{
                left: Math.max(80, Math.min(PAD.left + hover * band + band / 2, width - 80)),
                top: PAD.top,
              }}
            >
              <strong>{minuteLabel(hovered.minute)}</strong>
              <div><i className="swatch swatch-good" />{hovered.okAttempts} succeeded</div>
              <div><i className="swatch swatch-critical" />{hovered.failedAttempts} failed</div>
              <div className="muted">{hovered.events} events received</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
