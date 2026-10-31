const LABELS: Record<string, string> = {
  running: "Running",
  theory_submitted: "Theory submitted",
  turn_limit: "Turn limit",
  timeout: "Timed out",
  provider_failure: "Provider failure",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" aria-hidden="true" />
      {LABELS[status] ?? status}
    </span>
  );
}
