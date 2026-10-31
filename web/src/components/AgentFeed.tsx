import type { ReactNode } from "react";
import { formatExpression, formatNumber, formatTheory } from "../format.js";
import type { TranscriptEntry } from "../types.js";
import { AlertIcon, ChatIcon, CheckIcon, FlaskIcon, RulerIcon, SparkIcon } from "./Icons.js";

const MAX_INPUT_CHIPS = 6;

/**
 * The public transcript as a readable activity feed. Text the model wrote is
 * rendered as plain text only.
 */
export function AgentFeed({ entries }: { entries: readonly TranscriptEntry[] }) {
  const items = entries.flatMap((entry, index) => feedItems(entry, index));
  if (items.length === 0) {
    return (
      <div className="empty-state compact">
        <p>The agent has not acted yet.</p>
      </div>
    );
  }
  return (
    <ol className="feed" aria-label="Agent activity">
      {items.map((item) => (
        <li key={item.key} className={`feed-item feed-${item.tone}`}>
          <span className="feed-icon">{item.icon}</span>
          <div className="feed-body">
            <div className="feed-title">{item.title}</div>
            {item.detail && <div className="feed-detail">{item.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

interface FeedItem {
  key: string;
  tone: "model" | "tool" | "result" | "error" | "theory" | "user";
  icon: ReactNode;
  title: string;
  detail?: ReactNode | string;
}

function feedItems(entry: TranscriptEntry, index: number): FeedItem[] {
  switch (entry.type) {
    case "system_prompt":
      return [];
    case "user_message":
      return [{ key: `${index}`, tone: "user", icon: <ChatIcon />, title: "Briefing sent to the agent" }];
    case "model_text":
      return entry.text.trim() === ""
        ? []
        : [{ key: `${index}`, tone: "model", icon: <SparkIcon />, title: "Agent", detail: <p className="feed-text">{entry.text}</p> }];
    case "tool_calls":
      return entry.calls.map((call) => ({
        key: `${index}-${call.id}`,
        tone: "tool",
        icon: call.name === "run_experiment" ? <FlaskIcon /> : call.name === "evaluate_measurement" ? <RulerIcon /> : <SparkIcon />,
        title: callTitle(call.name),
        detail: callDetail(call.name, call.arguments),
      }));
    case "tool_result": {
      const ok = entry.output.ok === true;
      const error = entry.output.error as { code?: unknown } | undefined;
      return [
        {
          key: `${index}-${entry.callId}`,
          tone: ok ? "result" : "error",
          icon: ok ? <CheckIcon /> : <AlertIcon />,
          title: ok ? resultTitle(entry.name, entry.output) : `Rejected · ${typeof error?.code === "string" ? error.code : "error"}`,
        },
      ];
    }
    case "provider_notice":
      return [
        {
          key: `${index}`,
          tone: "error",
          icon: <AlertIcon />,
          title: `Provider ${entry.code.toLowerCase().replace("_", " ")}${entry.retried ? " · retried" : ""}`,
        },
      ];
    default:
      return entry.type === "submitted_theory"
        ? [{ key: `${index}`, tone: "theory", icon: <SparkIcon />, title: "Final theory recorded" }]
        : [];
  }
}

function callTitle(name: string): string {
  switch (name) {
    case "run_experiment":
      return "Runs an experiment";
    case "evaluate_measurement":
      return "Tests a measurement";
    case "submit_theory":
      return "Submits a theory";
    case "describe_world":
      return "Reads the world description";
    case "get_observation_log":
      return "Reviews the observation log";
    default:
      return name.replaceAll("_", " ");
  }
}

function callDetail(name: string, args: unknown): ReactNode | undefined {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  if (name === "run_experiment") {
    const inputs = Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number");
    return (
      <span className="chips">
        {inputs.slice(0, MAX_INPUT_CHIPS).map(([key, value]) => (
          <span key={key} className="chip mono">
            {key} {formatNumber(value)}
          </span>
        ))}
        {inputs.length > MAX_INPUT_CHIPS && <span className="chip">+{inputs.length - MAX_INPUT_CHIPS}</span>}
      </span>
    );
  }
  if (name === "evaluate_measurement") {
    const expression = typeof record.expression === "string" ? safeParse(record.expression) : record.expression;
    return <code className="formula small">{formatExpression(expression)}</code>;
  }
  if (name === "submit_theory") {
    return (
      <code className="formula small">
        {formatTheory({
          measurement: record.measurement,
          operator: typeof record.operator === "string" ? record.operator : undefined,
          threshold: typeof record.threshold === "number" ? record.threshold : undefined,
        })}
      </code>
    );
  }
  return undefined;
}

function resultTitle(name: string, output: Record<string, unknown>): string {
  if (name === "run_experiment") {
    const observation = output.observation as { outcome?: Record<string, unknown> } | undefined;
    const outcome = observation?.outcome ? Object.entries(observation.outcome)[0] : undefined;
    if (outcome) {
      const value = typeof outcome[1] === "number" ? formatNumber(outcome[1]) : String(outcome[1]);
      return `Observed ${outcome[0]} = ${value}`;
    }
  }
  if (name === "evaluate_measurement" && Array.isArray(output.rows)) {
    return `Measured over ${output.rows.length} experiments`;
  }
  if (name === "submit_theory") {
    return "Theory accepted";
  }
  return "Done";
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
