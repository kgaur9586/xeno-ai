import { formatNumber, formatPercent, formatTheory } from "../format.js";
import type { AnyWorldReport, PublicSessionView } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

export interface TheoryRow {
  session: PublicSessionView;
  /** Latest evaluator report. Undefined when scores are not loaded (no operator token). */
  report?: AnyWorldReport | null;
}

/** Every submitted theory, with held-out scores when the operator has loaded them. */
export function TheoryTable({ rows, showScores }: { rows: readonly TheoryRow[]; showScores: boolean }) {
  const submitted = rows.filter((row) => row.session.submittedTheory !== null);
  if (submitted.length === 0) {
    return (
      <div className="empty-state compact">
        <p>No theories submitted yet.</p>
      </div>
    );
  }
  return (
    <table className="table" aria-label="Theories">
      <thead>
        <tr>
          <th>World</th>
          <th>Theory</th>
          <th>Status</th>
          {showScores && (
            <>
              <th>In range</th>
              <th>Out of range</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {submitted.map(({ session, report }) => (
          <tr key={session.sessionId}>
            <td className="strong">{session.worldId}</td>
            <td>
              <code className="formula small">{formatTheory(session.submittedTheory)}</code>
            </td>
            <td>
              <StatusBadge status={session.status} />
            </td>
            {showScores && (
              <>
                <td>{scoreCell(report, "inRange")}</td>
                <td>{scoreCell(report, "outOfRange")}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function scoreCell(report: AnyWorldReport | null | undefined, set: "inRange" | "outOfRange") {
  if (!report) {
    return <span className="muted">not evaluated</span>;
  }
  const data = report[set];
  const text =
    report.kind === "boolean"
      ? formatPercent(report[set].accuracy)
      : `RMSE ${formatNumber(report[set].rootMeanSquaredError)}`;
  return <span className={data.passed ? "pass" : "fail"}>{`${text} ${data.passed ? "✓" : "✗"}`}</span>;
}
