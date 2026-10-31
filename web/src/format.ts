/** Display helpers. They only format; they never evaluate anything. */

const OPERATOR_SYMBOL: Record<string, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥" };
const EXPRESSION_SYMBOL: Record<string, string> = { add: "+", sub: "−", mul: "×", div: "÷" };

export function formatExpression(expression: unknown, depth = 0): string {
  if (depth > 32 || typeof expression !== "object" || expression === null) {
    return "?";
  }
  const node = expression as Record<string, unknown>;
  if (typeof node.const === "number") {
    return formatNumber(node.const);
  }
  if (typeof node.var === "string") {
    return node.var;
  }
  if (typeof node.op === "string") {
    const symbol = EXPRESSION_SYMBOL[node.op] ?? node.op;
    return `(${formatExpression(node.left, depth + 1)} ${symbol} ${formatExpression(node.right, depth + 1)})`;
  }
  if (typeof node.fn === "string" && Array.isArray(node.args)) {
    return `${node.fn}(${node.args.map((arg) => formatExpression(arg, depth + 1)).join(", ")})`;
  }
  return "?";
}

export function formatTheory(theory: { measurement: unknown; operator?: string; threshold?: number } | null): string {
  if (theory === null) {
    return "—";
  }
  const measurement = stripOuterParentheses(formatExpression(theory.measurement));
  if (theory.operator === undefined || theory.threshold === undefined) {
    return `outcome = ${measurement}`;
  }
  return `${measurement} ${OPERATOR_SYMBOL[theory.operator] ?? theory.operator} ${formatNumber(theory.threshold)}`;
}

export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Number(value.toPrecision(digits)));
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function stripOuterParentheses(text: string): string {
  if (!text.startsWith("(") || !text.endsWith(")")) {
    return text;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")") depth--;
    if (depth === 0 && index < text.length - 1) {
      return text;
    }
  }
  return text.slice(1, -1);
}
