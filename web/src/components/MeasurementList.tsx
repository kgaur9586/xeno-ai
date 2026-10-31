import { formatExpression, formatNumber } from "../format.js";
import type { MeasurementRecord } from "../transcript.js";

export function MeasurementList({ measurements }: { measurements: readonly MeasurementRecord[] }) {
  if (measurements.length === 0) {
    return (
      <div className="empty-state compact">
        <p>The agent has not defined any measurements.</p>
      </div>
    );
  }
  return (
    <table className="table" aria-label="Measurements">
      <thead>
        <tr>
          <th>Measurement</th>
          <th>Result</th>
          <th>Values</th>
          <th aria-label="Trend" />
        </tr>
      </thead>
      <tbody>
        {measurements.map((measurement) => {
          const numbers = measurement.values.map((row) => row.value).filter((value): value is number => value !== null);
          return (
            <tr key={measurement.callId}>
              <td>
                <code className="formula small">{formatExpression(measurement.expression)}</code>
              </td>
              <td>
                {measurement.ok ? (
                  <span className="tag tag-pass">valid</span>
                ) : (
                  <span className="tag tag-fail">{measurement.errorCode ?? "no result"}</span>
                )}
              </td>
              <td className="muted">
                {numbers.length === 0
                  ? "—"
                  : `${numbers.length} values, ${formatNumber(Math.min(...numbers))} to ${formatNumber(Math.max(...numbers))}`}
              </td>
              <td>
                <Sparkline values={numbers} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) {
    return null;
  }
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 96 + 2},${22 - ((value - low) / span) * 20}`);
  return (
    <svg className="sparkline" viewBox="0 0 100 24" aria-hidden="true" focusable="false">
      <polyline points={points.join(" ")} fill="none" />
    </svg>
  );
}
