import type { AnyObservation } from "../types.js";
import { formatNumber } from "../format.js";

export interface ExperimentTimelineProps {
  observations: readonly AnyObservation[];
  outcomeName: string;
  outcomeKind: "boolean" | "number";
}

const WIDTH = 640;
const HEIGHT = 150;
const PAD = { left: 48, right: 14, top: 16, bottom: 26 };

/** One mark per experiment in run order: two lanes for a boolean outcome, a line for a numeric one. */
export function ExperimentTimeline({ observations, outcomeName, outcomeKind }: ExperimentTimelineProps) {
  if (observations.length === 0) {
    return (
      <div className="empty-state compact">
        <p>No experiments yet.</p>
        <span className="muted">Step the agent to watch it design its first experiment.</span>
      </div>
    );
  }
  const attributeNames = Object.keys(observations[0]!.inputs);
  const maxStep = Math.max(...observations.map((observation) => observation.step), 1);
  const x = (step: number) => PAD.left + ((step - 1) / Math.max(maxStep - 1, 1)) * (WIDTH - PAD.left - PAD.right);
  const values = observations.map((observation) => observation.outcome[outcomeName]);
  const bottom = HEIGHT - PAD.bottom;

  let marks;
  let axis;
  if (outcomeKind === "boolean") {
    const y = (value: boolean) => (value ? PAD.top + 22 : bottom - 22);
    axis = (
      <>
        <line className="lane" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(true)} y2={y(true)} />
        <line className="lane" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(false)} y2={y(false)} />
        <text x={PAD.left - 8} y={y(true) + 4} textAnchor="end" className="axis-label">
          true
        </text>
        <text x={PAD.left - 8} y={y(false) + 4} textAnchor="end" className="axis-label">
          false
        </text>
      </>
    );
    marks = observations.map((observation, index) => {
      const value = values[index] === true;
      return (
        <circle
          key={observation.step}
          cx={x(observation.step)}
          cy={y(value)}
          r={4.5}
          className={value ? "mark-true" : "mark-false"}
          data-testid="timeline-mark"
        >
          <title>{`Step ${observation.step}: ${outcomeName} = ${String(value)}`}</title>
        </circle>
      );
    });
  } else {
    const numbers = values.map((value) => (typeof value === "number" ? value : 0));
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    const span = high - low || 1;
    const y = (value: number) => bottom - ((value - low) / span) * (HEIGHT - PAD.top - PAD.bottom);
    const points = observations.map((observation, index) => `${x(observation.step)},${y(numbers[index]!)}`);
    const area = `${x(observations[0]!.step)},${bottom} ${points.join(" ")} ${x(observations.at(-1)!.step)},${bottom}`;
    axis = (
      <>
        <text x={PAD.left - 8} y={y(high) + 4} textAnchor="end" className="axis-label">
          {formatNumber(high, 3)}
        </text>
        <text x={PAD.left - 8} y={y(low) + 4} textAnchor="end" className="axis-label">
          {formatNumber(low, 3)}
        </text>
      </>
    );
    marks = (
      <>
        <defs>
          <linearGradient id="timeline-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7c5cff" stopOpacity="0.35" />
            <stop offset="1" stopColor="#7c5cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon className="area" points={area} fill="url(#timeline-area)" />
        <polyline className="line" fill="none" points={points.join(" ")} />
        {observations.map((observation, index) => (
          <circle
            key={observation.step}
            cx={x(observation.step)}
            cy={y(numbers[index]!)}
            r={3.5}
            className="mark-value"
            data-testid="timeline-mark"
          >
            <title>{`Step ${observation.step}: ${outcomeName} = ${formatNumber(numbers[index]!)}`}</title>
          </circle>
        ))}
      </>
    );
  }

  return (
    <div className="timeline">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Experiment timeline: ${observations.length} experiments, ${outcomeName} by step`}
      >
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={bottom} y2={bottom} className="axis" />
        <text x={PAD.left} y={HEIGHT - 6} className="axis-label">
          step 1
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" className="axis-label">
          step {maxStep}
        </text>
        {axis}
        {marks}
      </svg>
      <details className="disclosure">
        <summary>
          All {observations.length} experiments <span className="muted">· inputs and observed {outcomeName}</span>
        </summary>
        <div className="scroll">
          <table className="table compact" aria-label="Experiments">
            <thead>
              <tr>
                <th>Step</th>
                {attributeNames.map((name) => (
                  <th key={name}>{name}</th>
                ))}
                <th>{outcomeName}</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((observation, index) => (
                <tr key={observation.step}>
                  <td>{observation.step}</td>
                  {attributeNames.map((name) => (
                    <td key={name}>{formatNumber(observation.inputs[name])}</td>
                  ))}
                  <td>
                    {typeof values[index] === "number" ? (
                      formatNumber(values[index] as number)
                    ) : (
                      <span className={values[index] === true ? "value-true" : "value-false"}>{String(values[index])}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
