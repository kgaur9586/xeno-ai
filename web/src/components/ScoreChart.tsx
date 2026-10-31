import { formatNumber, formatPercent } from "../format.js";
import type { AnyWorldReport } from "../types.js";

const WIDTH = 360;
const HEIGHT = 170;
const PAD = { left: 40, right: 12, top: 14, bottom: 30 };
const BAR = 64;

/**
 * Held-out scores for one evaluation: accuracy (boolean worlds) or the
 * within-tolerance rate (numeric worlds), in range and out of range, each
 * with its pass threshold.
 */
export function ScoreChart({ report, title }: { report: AnyWorldReport; title?: string }) {
  const metric = report.kind === "boolean" ? "accuracy" : "within tolerance";
  const valueOf = (set: "inRange" | "outOfRange") =>
    report.kind === "boolean" ? report[set].accuracy : report[set].withinToleranceRate;
  const sets = (
    [
      ["In range", "inRange"],
      ["Out of range", "outOfRange"],
    ] as const
  ).map(([label, set]) => ({
    label,
    value: valueOf(set),
    threshold: report[set].passThreshold,
    passed: report[set].passed,
  }));
  const y = (value: number) => HEIGHT - PAD.bottom - value * (HEIGHT - PAD.top - PAD.bottom);
  const slot = (WIDTH - PAD.left - PAD.right) / sets.length;

  return (
    <figure className="score-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title ?? "Scores"}: ${metric}`}>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="grid" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="axis-label">
              {tick * 100}%
            </text>
          </g>
        ))}
        {sets.map((set, index) => {
          const center = PAD.left + slot * index + slot / 2;
          return (
            <g key={set.label} data-testid="score-bar">
              <rect
                x={center - BAR / 2}
                y={y(set.value)}
                width={BAR}
                rx={6}
                height={y(0) - y(set.value)}
                className={set.passed ? "bar-pass" : "bar-fail"}
              >
                <title>{`${set.label}: ${formatPercent(set.value)} (needs ${formatPercent(set.threshold)})`}</title>
              </rect>
              <line
                x1={center - BAR / 2 - 6}
                x2={center + BAR / 2 + 6}
                y1={y(set.threshold)}
                y2={y(set.threshold)}
                className="threshold"
              />
              <text x={center} y={HEIGHT - 10} textAnchor="middle" className="axis-label">
                {set.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        {sets.map((set) => (
          <span key={set.label} className={set.passed ? "pass" : "fail"}>
            <span className="score-dot" aria-hidden="true" />
            {set.label}: {formatPercent(set.value)} {set.passed ? "passed" : "failed"} (needs {formatPercent(set.threshold)})
          </span>
        ))}
        {report.kind === "number" && (
          <span className="muted">
            RMSE {formatNumber(report.inRange.rootMeanSquaredError)} in range,{" "}
            {formatNumber(report.outOfRange.rootMeanSquaredError)} out of range
          </span>
        )}
      </figcaption>
    </figure>
  );
}
