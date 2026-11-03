import { api, IS_HOSTED_DEMO } from "./api";
import { AttemptsChart } from "./components/AttemptsChart";
import { DeliveriesTable } from "./components/DeliveriesTable";
import { EndpointHealth } from "./components/EndpointHealth";
import { StatTiles } from "./components/StatTiles";
import { relativeTime } from "./format";
import { useActive, useNow, usePoll } from "./usePoll";

const REPO_URL = "https://github.com/shourya-mittal/Webhook-Delivery-Platform";

export function App() {
  const now = useNow();
  const active = useActive();
  const stats = usePoll(api.stats, 2000, active);
  // Hosted on a free tier, "no answer yet" normally means it is still waking up.
  const waking = IS_HOSTED_DEMO && !stats.data;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Webhook Delivery</h1>
          <p className="muted">Events in, signed webhooks out: retried, dead-lettered and replayable.</p>
        </div>
        <div className={stats.error && !waking && active ? "live live-down" : "live"} role="status">
          <i aria-hidden="true" />
          {!active
            ? "Paused while idle · move your mouse to resume"
            : waking
              ? "Waking up…"
              : stats.error
                ? `API unreachable (${stats.error}), retrying`
                : stats.updatedAt
                  ? `Live · updated ${relativeTime(new Date(stats.updatedAt).toISOString(), Math.max(now, stats.updatedAt))}`
                  : "Connecting…"}
        </div>
      </header>

      {IS_HOSTED_DEMO && (
        <div className="demo-banner">
          <strong>Live demo with simulated data.</strong> A pretend school bus sends an event every
          4 seconds to three receivers. The SMS gateway goes down on purpose for 40 seconds out of
          every 85, so you can watch retries and dead-lettering. Press <strong>Replay</strong> on a
          dead-lettered delivery once the gateway is back.{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">How it works, on GitHub</a>
        </div>
      )}

      {stats.data ? (
        <>
          <StatTiles stats={stats.data} />
          <div className="grid-2">
            <AttemptsChart timeline={stats.data.timeline} />
            <EndpointHealth endpoints={stats.data.endpoints} />
          </div>
          <DeliveriesTable now={now} active={active} onReplayed={() => void stats.refresh()} />
        </>
      ) : (
        <div className="card empty muted">
          {waking
            ? "Waking up the demo server. It sleeps when nobody is using it, so this usually takes about a minute."
            : stats.error
              ? "Can't reach the API. Start it with `npm run dev` (or `npm run demo`) in the project root."
              : "Loading…"}
        </div>
      )}
    </div>
  );
}
