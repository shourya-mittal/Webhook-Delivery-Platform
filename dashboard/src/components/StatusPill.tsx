import type { DeliveryStatus } from "../api";

// Status is never colour alone: every pill carries an icon and a word.
const LOOK: Record<string, { label: string; icon: string; tone: string }> = {
  succeeded: { label: "Delivered", icon: "✓", tone: "good" },
  retrying: { label: "Retrying", icon: "↻", tone: "warning" },
  queued: { label: "Queued", icon: "◷", tone: "neutral" },
  in_flight: { label: "Sending", icon: "➜", tone: "info" },
  dead: { label: "Dead-lettered", icon: "✕", tone: "critical" },
};

export function displayStatus(status: DeliveryStatus, attemptCount: number) {
  if (status === "pending") return attemptCount > 0 ? "retrying" : "queued";
  return status;
}

export function StatusPill({ status, attemptCount }: { status: DeliveryStatus; attemptCount: number }) {
  const look = LOOK[displayStatus(status, attemptCount)]!;
  return (
    <span className={`pill pill-${look.tone}`}>
      <span aria-hidden="true">{look.icon}</span>
      {look.label}
    </span>
  );
}
