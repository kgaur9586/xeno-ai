// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateSessionForm } from "../src/components/CreateSessionForm.js";
import { AgentFeed } from "../src/components/AgentFeed.js";
import { ExperimentSpace } from "../src/components/ExperimentSpace.js";
import { ExperimentTimeline } from "../src/components/ExperimentTimeline.js";
import { MeasurementList } from "../src/components/MeasurementList.js";
import { ScoreChart } from "../src/components/ScoreChart.js";
import { SessionList } from "../src/components/SessionList.js";
import { TheoryTable } from "../src/components/TheoryTable.js";
import { formatExpression, formatTheory } from "../src/format.js";
import { extractMeasurements, extractTheoryAttempts } from "../src/transcript.js";
import type { AnyObservation, AnyWorldReport, PublicSessionView, PublicWorld, TranscriptEntry } from "../src/types.js";

afterEach(cleanup);

function session(overrides: Partial<PublicSessionView> = {}): PublicSessionView {
  return {
    sessionId: "11111111-2222-4333-8444-555555555555",
    worldId: "ring-world",
    provider: "dummy",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    status: "running",
    modelTurns: 1,
    maxModelTurns: 16,
    budget: 30,
    experimentCount: 12,
    remainingBudget: 18,
    submittedTheory: null,
    providerDiagnostic: null,
    ...overrides,
  };
}

const booleanTheory = {
  measurement: { op: "sub", left: { var: "p" }, right: { const: 5 } },
  operator: "gt",
  threshold: 0,
};

function booleanReport(inRange: number, outOfRange: number): AnyWorldReport {
  const set = (accuracy: number) => ({
    totalCases: 200,
    correctPredictions: Math.round(accuracy * 200),
    incorrectPredictions: 200 - Math.round(accuracy * 200),
    accuracy,
    evaluationErrors: {},
    passThreshold: 0.904,
    passed: accuracy >= 0.904,
  });
  return {
    kind: "boolean",
    noiseCeiling: 0.95,
    inRange: set(inRange),
    outOfRange: set(outOfRange),
    complexity: { nodeCount: 3, depth: 2 },
  } as AnyWorldReport;
}

function numericReport(): AnyWorldReport {
  const set = (rate: number, rmse: number) => ({
    totalCases: 200,
    scoredCases: 200,
    meanAbsoluteError: rmse * 0.8,
    rootMeanSquaredError: rmse,
    withinTolerance: Math.round(rate * 200),
    withinToleranceRate: rate,
    evaluationErrors: {},
    passThreshold: 0.986,
    passed: rate >= 0.986,
  });
  return {
    kind: "number",
    noiseStandardDeviation: 0.5,
    tolerance: 1.5,
    inRange: set(0.995, 0.49),
    outOfRange: set(0.6, 3.2),
    complexity: { nodeCount: 9, depth: 4 },
  } as AnyWorldReport;
}

describe("SessionList", () => {
  it("shows each session and reports selection and deletion", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const sessions = [
      session(),
      session({ sessionId: "99999999-2222-4333-8444-555555555555", worldId: "drift-world", status: "theory_submitted" }),
    ];
    render(<SessionList sessions={sessions} selectedId={sessions[1]!.sessionId} onSelect={onSelect} onDelete={onDelete} />);
    const cards = within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.className).toContain("selected");
    expect(cards[0]!.textContent).toContain("drift-world");
    expect(screen.getByRole("button", { name: "Open drift-world session 99999999" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Theory submitted")).toBeTruthy();
    expect(screen.getAllByText("12/30")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Open ring-world session 11111111" }));
    expect(onSelect).toHaveBeenCalledWith(sessions[0]!.sessionId);
    fireEvent.click(screen.getByRole("button", { name: "Delete session 99999999" }));
    expect(onDelete).toHaveBeenCalledWith(sessions[1]!.sessionId);
  });

  it("has an empty state", () => {
    render(<SessionList sessions={[]} selectedId={null} onSelect={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
  });
});

describe("CreateSessionForm", () => {
  const worlds: PublicWorld[] = [
    { worldId: "glow-world", attributes: {}, outcome: { glows: "boolean" } },
    { worldId: "drift-world", attributes: {}, outcome: { level: "number" } },
  ];

  it("submits the chosen world and limits, with an optional noise seed", () => {
    const onCreate = vi.fn();
    render(<CreateSessionForm worlds={worlds} busy={false} onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("World"), { target: { value: "drift-world" } });
    fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "27" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).toHaveBeenLastCalledWith({ worldId: "drift-world", budget: 27, maxModelTurns: 16 });

    fireEvent.change(screen.getByLabelText(/Noise seed/), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).toHaveBeenLastCalledWith({ worldId: "drift-world", budget: 27, maxModelTurns: 16, noiseSeed: 7 });
  });

  it("disables submission for invalid numbers", () => {
    render(<CreateSessionForm worlds={worlds} busy={false} onCreate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Create session" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Noise seed/), { target: { value: "1.5" } });
    expect(screen.getByRole("button", { name: "Create session" })).toHaveProperty("disabled", true);
  });
});

describe("ExperimentTimeline", () => {
  const booleanObservations: AnyObservation[] = [1, 2, 3].map((step) => ({
    step,
    inputs: { p: step, q: 2 },
    outcome: { lit: step % 2 === 1 },
    remainingBudget: 3 - step,
  }));

  it("draws one mark per experiment in two lanes and lists the inputs", () => {
    const { container } = render(
      <ExperimentTimeline observations={booleanObservations} outcomeName="lit" outcomeKind="boolean" />,
    );
    expect(screen.getAllByTestId("timeline-mark")).toHaveLength(3);
    expect(container.querySelectorAll(".mark-true")).toHaveLength(2);
    expect(container.querySelectorAll(".mark-false")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("3 experiments");
    const rows = within(screen.getByRole("table", { name: "Experiments" })).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual(["Steppqlit", "112true", "222false", "332true"]);
  });

  it("draws a line for a numeric outcome", () => {
    const observations: AnyObservation[] = [
      { step: 1, inputs: { u: 1 }, outcome: { level: 4.25 }, remainingBudget: 1 },
      { step: 2, inputs: { u: 2 }, outcome: { level: -1.5 }, remainingBudget: 0 },
    ];
    const { container } = render(<ExperimentTimeline observations={observations} outcomeName="level" outcomeKind="number" />);
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(screen.getAllByTestId("timeline-mark")).toHaveLength(2);
    expect(screen.getByText("4.25", { selector: "td" })).toBeTruthy();
  });

  it("has an empty state", () => {
    render(<ExperimentTimeline observations={[]} outcomeName="lit" outcomeKind="boolean" />);
    expect(screen.getByText("No experiments yet.")).toBeTruthy();
  });
});

describe("TheoryTable", () => {
  const rows = [
    { session: session({ submittedTheory: booleanTheory, status: "theory_submitted" }), report: booleanReport(0.95, 0.7) },
    { session: session({ sessionId: "22222222-2222-4333-8444-555555555555" }) },
  ];

  it("lists only submitted theories and hides scores without operator access", () => {
    render(<TheoryTable rows={rows} showScores={false} />);
    const table = screen.getByRole("table", { name: "Theories" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("p − 5 > 0")).toBeTruthy();
    expect(table.textContent).not.toMatch(/%|In range/);
  });

  it("shows pass and fail scores for the operator", () => {
    render(<TheoryTable rows={rows} showScores />);
    expect(screen.getByText("95.0% ✓").className).toBe("pass");
    expect(screen.getByText("70.0% ✗").className).toBe("fail");
  });

  it("has an empty state", () => {
    render(<TheoryTable rows={[{ session: session() }]} showScores />);
    expect(screen.getByText("No theories submitted yet.")).toBeTruthy();
  });
});

describe("ScoreChart", () => {
  it("draws in-range and out-of-range bars with their thresholds", () => {
    const { container } = render(<ScoreChart report={booleanReport(0.95, 0.7)} />);
    expect(screen.getAllByTestId("score-bar")).toHaveLength(2);
    expect(container.querySelectorAll(".bar-pass")).toHaveLength(1);
    expect(container.querySelectorAll(".bar-fail")).toHaveLength(1);
    expect(container.querySelectorAll(".threshold")).toHaveLength(2);
    expect(screen.getByText(/In range: 95.0% passed \(needs 90.4%\)/)).toBeTruthy();
    expect(screen.getByText(/Out of range: 70.0% failed/)).toBeTruthy();
  });

  it("uses the within-tolerance rate and shows RMSE for numeric worlds", () => {
    render(<ScoreChart report={numericReport()} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("within tolerance");
    expect(screen.getByText(/In range: 99.5% passed/)).toBeTruthy();
    expect(screen.getByText(/RMSE 0.49 in range, 3.2 out of range/)).toBeTruthy();
  });
});

describe("Transcript views", () => {
  const entries: TranscriptEntry[] = [
    { type: "system_prompt", text: "…" },
    {
      type: "tool_calls",
      calls: [
        { id: "m1", name: "evaluate_measurement", arguments: { expression: { op: "mul", left: { var: "a" }, right: { var: "b" } } } },
        { id: "m2", name: "evaluate_measurement", arguments: { expression: '{"var":"z"}' } },
        { id: "t1", name: "submit_theory", arguments: { measurement: { var: "a" }, operator: "gt", threshold: 5 } },
      ],
    },
    { type: "tool_result", callId: "m1", name: "evaluate_measurement", output: { ok: true, rows: [{ step: 1, value: 2 }, { step: 2, value: 8 }] } },
    { type: "tool_result", callId: "m2", name: "evaluate_measurement", output: { ok: false, error: { code: "INVALID_EXPRESSION", message: "x" } } },
    { type: "tool_result", callId: "t1", name: "submit_theory", output: { ok: true, accepted: true } },
  ];

  it("pairs measurement calls with their results", () => {
    const measurements = extractMeasurements(entries);
    expect(measurements.map((m) => [m.callId, m.ok, m.errorCode])).toEqual([
      ["m1", true, null],
      ["m2", false, "INVALID_EXPRESSION"],
    ]);
    render(<MeasurementList measurements={measurements} />);
    expect(screen.getByText("(a × b)")).toBeTruthy();
    expect(screen.getByText("2 values, 2 to 8")).toBeTruthy();
    expect(screen.getByText("INVALID_EXPRESSION")).toBeTruthy();
  });

  it("finds theory attempts", () => {
    expect(extractTheoryAttempts(entries)).toEqual([
      { callId: "t1", theory: { measurement: { var: "a" }, operator: "gt", threshold: 5 }, accepted: true, errorCode: null },
    ]);
  });

  it("formats expressions and theories without evaluating them", () => {
    expect(formatExpression({ fn: "max", args: [{ var: "a" }, { const: 0.123456 }] })).toBe("max(a, 0.1235)");
    expect(formatExpression("not a node")).toBe("?");
    expect(formatTheory({ measurement: { op: "add", left: { var: "u" }, right: { const: 1 } } })).toBe("outcome = u + 1");
  });
});

describe("ExperimentSpace", () => {
  const observations: AnyObservation[] = [
    { step: 1, inputs: { p: 1, q: 9 }, outcome: { lit: true }, remainingBudget: 2 },
    { step: 2, inputs: { p: 4, q: 2 }, outcome: { lit: false }, remainingBudget: 1 },
  ];
  const attributes = { p: { min: 0, max: 10 }, q: { min: 0, max: 10 } };

  it("plots every probe coloured by outcome, with switchable axes and a readout", () => {
    const { container } = render(
      <ExperimentSpace observations={observations} attributes={attributes} outcomeName="lit" outcomeKind="boolean" />,
    );
    expect(screen.getAllByTestId("space-dot")).toHaveLength(2);
    expect(container.querySelectorAll(".dot-true")).toHaveLength(2);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("q against p");
    expect(screen.getByText(/Latest · step 2/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "q" } });
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("q against q");
    fireEvent.mouseEnter(screen.getAllByTestId("space-dot")[0]!);
    expect(screen.getByText("Step 1")).toBeTruthy();
  });

  it("uses a heat scale for a numeric outcome", () => {
    const numeric: AnyObservation[] = [
      { step: 1, inputs: { p: 1, q: 1 }, outcome: { level: 0 }, remainingBudget: 1 },
      { step: 2, inputs: { p: 2, q: 2 }, outcome: { level: 10 }, remainingBudget: 0 },
    ];
    const { container } = render(
      <ExperimentSpace observations={numeric} attributes={attributes} outcomeName="level" outcomeKind="number" />,
    );
    expect(container.querySelector(".dot-heat-0")).not.toBeNull();
    expect(container.querySelector(".dot-heat-5")).not.toBeNull();
  });
});

describe("AgentFeed", () => {
  it("turns the transcript into readable steps and shows model text as plain text", () => {
    const entries: TranscriptEntry[] = [
      { type: "system_prompt", text: "hidden from the feed" },
      { type: "model_text", text: "<b>I will probe the corners</b>" },
      { type: "tool_calls", calls: [{ id: "r1", name: "run_experiment", arguments: { p: 1.5, q: -2 } }] },
      { type: "tool_result", callId: "r1", name: "run_experiment", output: { ok: true, observation: { outcome: { lit: true } } } },
      { type: "tool_result", callId: "r2", name: "run_experiment", output: { ok: false, error: { code: "OUT_OF_RANGE" } } },
    ];
    const { container } = render(<AgentFeed entries={entries} />);
    const items = within(screen.getByRole("list", { name: "Agent activity" })).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(screen.getByText("<b>I will probe the corners</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("p 1.5")).toBeTruthy();
    expect(screen.getByText("Observed lit = true")).toBeTruthy();
    expect(screen.getByText("Rejected · OUT_OF_RANGE")).toBeTruthy();
    expect(container.textContent).not.toContain("hidden from the feed");
  });
});

describe("Dashboard isolation", () => {
  it("imports server code as types only", () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), "web", "src"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"(\.\.\/\.\.\/src\/[^"]+)"/gm)) {
        expect(match[2], `${file} must import ${match[3]} as a type`).toBe("type ");
      }
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML|eval\(/);
    }
  });
});
