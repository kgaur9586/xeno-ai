/** Entry point for `npm run baselines`. */
import { formatBaselineComparison, runBaselineComparison } from "../agents/baseline-comparison.js";

console.log(formatBaselineComparison(runBaselineComparison()));
