import { useId, useState } from "react";
import { formatNumber } from "../format.js";
import type { AnyObservation, PublicAttributeRange } from "../types.js";

export interface ExperimentSpaceProps {
  observations: readonly AnyObservation[];
  attributes: Readonly<Record<string, PublicAttributeRange>>;
  outcomeName: string;
  outcomeKind: "boolean" | "number";
}

const SIZE = 340;
const PAD = 36;
const HEAT_LEVELS = 6;

/**
 * Where the agent chose to probe: two chosen inputs against each other, each
 * point coloured by its observed outcome, the newest point ringed.
 */
export function ExperimentSpace({ observations, attributes, outcomeName, outcomeKind }: ExperimentSpaceProps) {
  const names = Object.keys(attributes);
  const [xName, setXName] = useState(names[0] ?? "");
  const [yName, setYName] = useState(names[1] ?? names[0] ?? "");
  const [hovered, setHovered] = useState<AnyObservation | null>(null);
  const idBase = useId();

  if (names.length === 0) {
    return null;
  }
  const xRange = attributes[xName] ?? { min: 0, max: 1 };
  const yRange = attributes[yName] ?? { min: 0, max: 1 };
  const project = (value: number, range: PublicAttributeRange, flip: boolean) => {
    const span = range.max - range.min || 1;
    const fraction = Math.min(Math.max((value - range.min) / span, -0.08), 1.08);
    return flip ? SIZE - PAD - fraction * (SIZE - 2 * PAD) : PAD + fraction * (SIZE - 2 * PAD);
  };

  const numbers = observations
    .map((observation) => observation.outcome[outcomeName])
    .filter((value): value is number => typeof value === "number");
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const heatClass = (value: boolean | number | undefined) => {
    if (outcomeKind === "boolean") {
      return value === true ? "dot-true" : "dot-false";
    }
    const level = high > low && typeof value === "number" ? Math.round(((value - low) / (high - low)) * (HEAT_LEVELS - 1)) : 0;
    return `dot-heat-${level}`;
  };
  const latest = observations.at(-1);
  const focus = hovered ?? latest ?? null;

  return (
    <div className="space">
      <div className="space-controls">
        <label className="field inline">
          <span className="field-label">X axis</span>
          <select id={`${idBase}-x`} value={xName} onChange={(event) => setXName(event.target.value)}>
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span className="field-label">Y axis</span>
          <select id={`${idBase}-y`} value={yName} onChange={(event) => setYName(event.target.value)}>
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div className="legend" aria-hidden="true">
          {outcomeKind === "boolean" ? (
            <>
              <span className="legend-item">
                <span className="swatch dot-true" /> true
              </span>
              <span className="legend-item">
                <span className="swatch dot-false" /> false
              </span>
            </>
          ) : (
            <span className="legend-item">
              {formatNumber(low, 3)}
              <span className="heat-scale" />
              {formatNumber(high, 3)}
            </span>
          )}
        </div>
      </div>
      <svg
        className="space-plot"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Experiment space: ${observations.length} experiments, ${yName} against ${xName}, coloured by ${outcomeName}`}
        onMouseLeave={() => setHovered(null)}
      >
        <rect className="plot-frame" x={PAD} y={PAD} width={SIZE - 2 * PAD} height={SIZE - 2 * PAD} rx="8" />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <g key={fraction}>
            <line className="grid" x1={PAD + fraction * (SIZE - 2 * PAD)} x2={PAD + fraction * (SIZE - 2 * PAD)} y1={PAD} y2={SIZE - PAD} />
            <line className="grid" y1={PAD + fraction * (SIZE - 2 * PAD)} y2={PAD + fraction * (SIZE - 2 * PAD)} x1={PAD} x2={SIZE - PAD} />
          </g>
        ))}
        <text className="axis-label" x={PAD} y={SIZE - PAD + 16}>
          {formatNumber(xRange.min, 3)}
        </text>
        <text className="axis-label" x={SIZE - PAD} y={SIZE - PAD + 16} textAnchor="end">
          {formatNumber(xRange.max, 3)}
        </text>
        <text className="axis-title" x={SIZE / 2} y={SIZE - 8} textAnchor="middle">
          {xName}
        </text>
        <text className="axis-label" x={PAD - 6} y={SIZE - PAD} textAnchor="end">
          {formatNumber(yRange.min, 3)}
        </text>
        <text className="axis-label" x={PAD - 6} y={PAD + 8} textAnchor="end">
          {formatNumber(yRange.max, 3)}
        </text>
        <text className="axis-title" x={12} y={SIZE / 2} textAnchor="middle" transform={`rotate(-90 12 ${SIZE / 2})`}>
          {yName}
        </text>
        {observations.map((observation) => {
          const cx = project(observation.inputs[xName] ?? 0, xRange, false);
          const cy = project(observation.inputs[yName] ?? 0, yRange, true);
          const value = observation.outcome[outcomeName];
          return (
            <circle
              key={observation.step}
              className={`dot ${heatClass(value)}`}
              data-testid="space-dot"
              cx={cx}
              cy={cy}
              r={5}
              onMouseEnter={() => setHovered(observation)}
            >
              <title>{describe(observation, outcomeName)}</title>
            </circle>
          );
        })}
        {latest && (
          <circle
            className="dot-latest"
            cx={project(latest.inputs[xName] ?? 0, xRange, false)}
            cy={project(latest.inputs[yName] ?? 0, yRange, true)}
            r={10}
          />
        )}
      </svg>
      <p className="space-readout" aria-live="polite">
        {focus ? (
          <>
            <span className="readout-step">{hovered ? `Step ${focus.step}` : `Latest · step ${focus.step}`}</span>
            {Object.entries(focus.inputs).map(([name, value]) => (
              <span key={name} className="chip mono">
                {name} {formatNumber(value)}
              </span>
            ))}
            <span className="chip chip-accent mono">
              {outcomeName} {formatOutcome(focus.outcome[outcomeName])}
            </span>
          </>
        ) : (
          <span className="muted">No experiments yet.</span>
        )}
      </p>
    </div>
  );
}

function describe(observation: AnyObservation, outcomeName: string): string {
  const inputs = Object.entries(observation.inputs)
    .map(([name, value]) => `${name}=${formatNumber(value)}`)
    .join(", ");
  return `Step ${observation.step}: ${inputs} → ${outcomeName} = ${formatOutcome(observation.outcome[outcomeName])}`;
}

function formatOutcome(value: boolean | number | undefined): string {
  return typeof value === "number" ? formatNumber(value) : String(value);
}
