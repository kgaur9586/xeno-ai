/**
 * Reproducible side-by-side comparison of the scripted baselines.
 *
 * Both strategies get the same budget, and the random explorer uses a fixed
 * seed, so the comparison is identical every time it runs. The output
 * describes exploration only; it is not a measure of rule discovery.
 */
import { runBaseline, type AttributeSummary, type BaselineReport } from "./baseline-runner.js";
import { createRandomExplorer } from "./random-explorer.js";
import { createSystematicExplorer } from "./systematic-explorer.js";

/** Equal to the systematic grid size, so both strategies can use their full budget. */
export const BASELINE_COMPARISON_BUDGET = 27;
export const BASELINE_COMPARISON_SEED = 42;

export function runBaselineComparison(): BaselineReport[] {
  return [
    runBaseline(createRandomExplorer({ seed: BASELINE_COMPARISON_SEED }), {
      budget: BASELINE_COMPARISON_BUDGET,
    }),
    runBaseline(createSystematicExplorer(), { budget: BASELINE_COMPARISON_BUDGET }),
  ];
}

export function formatBaselineComparison(reports: readonly BaselineReport[]): string {
  const rows: string[][] = [
    ["Metric", ...reports.map((report) => report.experimenter)],
    ["Experiments run", ...reports.map((report) => String(report.experimentCount))],
    ["Budget remaining", ...reports.map((report) => String(report.remainingBudget))],
    ["Rejected requests", ...reports.map((report) => String(rejectedCount(report)))],
    ["Unique inputs", ...reports.map((report) => String(report.uniqueInputCount))],
    ["Repeated inputs", ...reports.map((report) => String(report.repeatedExperimentCount))],
    ["Glowing outcomes", ...reports.map((report) => String(report.outcomeCounts.glowing))],
    ["Non-glowing outcomes", ...reports.map((report) => String(report.outcomeCounts.notGlowing))],
    ...(["a", "b", "c"] as const).map((attribute) => [
      `Coverage of ${attribute}`,
      ...reports.map((report) => describeCoverage(report.attributes[attribute])),
    ]),
  ];

  return [
    "XENO baseline comparison: EXPLORATION METRICS ONLY",
    "These numbers describe which inputs each strategy tried. They do NOT measure",
    "rule-discovery accuracy, which requires theories scored by the evaluator (Phase 4).",
    "",
    `Budget per strategy: ${BASELINE_COMPARISON_BUDGET} | Random explorer seed: ${BASELINE_COMPARISON_SEED}`,
    "",
    ...formatTable(rows),
    "",
    "Coverage = distinct values, observed min to max, and how many of the 5 equal-width",
    "range bins contain at least one value.",
    "Known benchmark limitations: see docs/ARCHITECTURE.md, section 7.",
  ].join("\n");
}

function rejectedCount(report: BaselineReport): number {
  return report.rejectedRequests.INVALID_INPUT + report.rejectedRequests.BUDGET_EXHAUSTED;
}

function describeCoverage(summary: AttributeSummary): string {
  if (summary.min === null || summary.max === null) {
    return "no values";
  }
  const occupiedBins = summary.histogram.filter((bin) => bin.count > 0).length;
  return (
    `${summary.distinctValueCount} distinct, ${round(summary.min)} to ${round(summary.max)}, ` +
    `${occupiedBins}/${summary.histogram.length} bins`
  );
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatTable(rows: string[][]): string[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const lines = rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd(),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [lines[0]!, separator, ...lines.slice(1)];
}
