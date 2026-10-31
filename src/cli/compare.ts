/** Entry point for `npm run compare`. Always uses the scripted dummy provider. */
import { formatDiscoveryComparison, runDiscoveryComparison } from "../agents/discovery-comparison.js";
import { discoveryRunFileName, saveRunFile } from "../agents/discovery-run-log.js";

const savedAt = new Date();
const report = await runDiscoveryComparison();
const savedTo = saveRunFile({
  directory: "runs",
  fileName: discoveryRunFileName(savedAt, "dummy", "comparison"),
  body: { savedAt: savedAt.toISOString(), report },
});
process.stdout.write(`${formatDiscoveryComparison(report)}\n\nSaved to ${savedTo}\n`);
