const RADIUS = 21;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A circular gauge. Geometry is set through SVG attributes, so the strict style policy is not involved. */
export function ProgressRing({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "cyan" | "amber" }) {
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  return (
    <svg className={`ring ring-${tone}`} viewBox="0 0 52 52" aria-hidden="true" focusable="false">
      <circle className="ring-track" cx="26" cy="26" r={RADIUS} />
      <circle
        className="ring-value"
        cx="26"
        cy="26"
        r={RADIUS}
        strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
        transform="rotate(-90 26 26)"
      />
    </svg>
  );
}

/** A thin horizontal bar, drawn in SVG for the same reason. */
export function ProgressBar({ value, max }: { value: number; max: number }) {
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  return (
    <svg className="bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="bar-track" x="0" y="0" width="100" height="4" rx="2" />
      <rect className="bar-value" x="0" y="0" width={100 * fraction} height="4" rx="2" />
    </svg>
  );
}
