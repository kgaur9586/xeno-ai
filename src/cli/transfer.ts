/** Entry point for `npm run transfer`. Runs the hand-built transfer cases and saves the report. */
import { pathToFileURL } from "node:url";
import { discoveryRunFileName, saveRunFile } from "../agents/discovery-run-log.js";
import { buildTransferScenarios } from "../transfer/scenarios.js";
import { runTransfer, type TransferReport } from "../transfer/transfer.js";

export const TRANSFER_EVALUATION = { inRangeSeed: 515151, outOfRangeSeed: 626262, caseCount: 200 } as const;

export const TRANSFER_NOTE =
  "Hand-built source theories, not agent discoveries. Adaptation keeps the theory's form: it may rename variables and retune constants and the threshold, nothing else.";

export function formatTransferReports(results: ReadonlyArray<{ name: string; expected: string; report: TransferReport }>): string {
  const rows = [
    ["Case", "Expected", "Source", "Unchanged", "Experiments to adapt"],
    ...results.map(({ name, expected, report }) => [
      name,
      expected,
      report.sourcePassed ? "pass" : "fail",
      report.unchanged === null ? `n/a (${report.unchangedReason})` : report.transfersUnchanged ? "pass" : "fail",
      report.experimentsToAdapt === null ? `not within ${report.adaptationOptions.maxExperiments}` : String(report.experimentsToAdapt),
    ]),
  ];
  const widths = rows[0]!.map((_cell, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  return [
    "XENO transfer to altered worlds",
    TRANSFER_NOTE,
    "",
    lines[0]!,
    widths.map((width) => "-".repeat(width)).join("  "),
    ...lines.slice(1),
  ].join("\n");
}

function main(): void {
  const savedAt = new Date();
  const results = buildTransferScenarios().map((scenario) => ({
    name: scenario.name,
    expected: scenario.expected,
    report: runTransfer(scenario.source, scenario.target, scenario.theory, { evaluation: TRANSFER_EVALUATION }),
  }));
  const savedTo = saveRunFile({
    directory: "runs",
    fileName: discoveryRunFileName(savedAt, "transfer", "cases"),
    body: { savedAt: savedAt.toISOString(), note: TRANSFER_NOTE, results },
  });
  process.stdout.write(`${formatTransferReports(results)}\n\nSaved to ${savedTo}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
