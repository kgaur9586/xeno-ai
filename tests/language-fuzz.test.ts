/**
 * Deterministic fuzz tests: thousands of generated inputs from a fixed seed.
 * The same seed always generates the same inputs, so any failure is
 * reproducible.
 */
import { describe, expect, it } from "vitest";
import { LANGUAGE_ERROR_MESSAGES, type LanguageErrorCode } from "../src/language/errors.js";
import { MAX_FUNCTION_ARGS } from "../src/language/expression.js";
import { evaluateExpression } from "../src/language/interpreter.js";
import { parseExpressionJson, validateExpression } from "../src/language/validate.js";
import { createSeededRandom, type RandomSource } from "../src/shared/random.js";

const KNOWN_CODES = new Set(Object.keys(LANGUAGE_ERROR_MESSAGES));
const EVALUATION_CODES = new Set(["DIVISION_BY_ZERO", "SQRT_OF_NEGATIVE", "LOG_OF_NON_POSITIVE", "NON_FINITE_RESULT"]);

function pick<T>(random: RandomSource, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function integer(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

const JUNK_PRIMITIVES: readonly unknown[] = [
  0, -0, 1, -1, 5, 0.5, 1e308, -1e308, 5e-324, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  "", "a", "b", "c", "d", "add", "sub", "mul", "div", "pow", "abs", "sqrt", "log", "min", "max", "exp", "eval",
  true, false, null, undefined,
];
const JUNK_KEYS = ["const", "var", "op", "left", "right", "fn", "args", "x", "constructor", "toString", "__proto__"];

/** Any JavaScript-like value, biased toward things that look almost like expressions. */
function junk(random: RandomSource, depth: number): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.35) {
    return pick(random, JUNK_PRIMITIVES);
  }
  if (roll < 0.5) {
    return Array.from({ length: integer(random, 0, 6) }, () => junk(random, depth - 1));
  }
  const object: Record<string, unknown> = {};
  const keyCount = integer(random, 0, 4);
  for (let i = 0; i < keyCount; i++) {
    Object.defineProperty(object, pick(random, JUNK_KEYS), {
      value: junk(random, depth - 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return object;
}

/**
 * A random expression that obeys every rule of the language. With depth at
 * most 5 and leaf-only min/max arguments, a tree has at most 47 nodes.
 */
function validTree(random: RandomSource, depth: number): unknown {
  const roll = random();
  if (depth <= 1 || roll < 0.3) {
    return random() < 0.5
      ? { const: pick(random, [0, 1, -1, 2, 5, 0.5, 10, 1e6]) }
      : { var: pick(random, ["a", "b", "c"]) };
  }
  if (roll < 0.7) {
    return {
      op: pick(random, ["add", "sub", "mul", "div"]),
      left: validTree(random, depth - 1),
      right: validTree(random, depth - 1),
    };
  }
  if (roll < 0.85) {
    return { fn: pick(random, ["abs", "sqrt", "log"]), args: [validTree(random, depth - 1)] };
  }
  const argCount = integer(random, 2, MAX_FUNCTION_ARGS);
  return {
    fn: pick(random, ["min", "max"]),
    args: Array.from({ length: argCount }, () => validTree(random, 1)),
  };
}

function randomVariables(random: RandomSource) {
  return { a: random() * 20 - 5, b: random() * 20 - 5, c: random() * 20 - 5 };
}

function expectWellFormedFailure(result: unknown): void {
  const failure = result as { ok: boolean; error: { code: LanguageErrorCode; message: string } };
  expect(Object.keys(failure).sort()).toEqual(["error", "ok"]);
  expect(Object.keys(failure.error).sort()).toEqual(["code", "message"]);
  expect(KNOWN_CODES.has(failure.error.code)).toBe(true);
  expect(failure.error.message).toBe(LANGUAGE_ERROR_MESSAGES[failure.error.code]);
}

function allNodes(tree: unknown): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    const record = node as Record<string, unknown>;
    nodes.push(record);
    if ("left" in record) visit(record.left);
    if ("right" in record) visit(record.right);
    if (Array.isArray(record.args)) record.args.forEach(visit);
  };
  visit(tree);
  return nodes;
}

describe("Fuzz: generated junk never crashes and always fails safely", () => {
  it("validates and evaluates 5,000 junk values without throwing", () => {
    const random = createSeededRandom(20261014);
    let rejected = 0;
    for (let i = 0; i < 5000; i++) {
      const input = junk(random, 5);
      const validation = validateExpression(input);
      const evaluation = evaluateExpression(input, randomVariables(random));
      if (validation.ok) {
        expect(evaluation.ok || EVALUATION_CODES.has(evaluation.error.code)).toBe(true);
      } else {
        rejected++;
        expectWellFormedFailure(validation);
        expect(evaluation).toStrictEqual(validation);
      }
      if (evaluation.ok) {
        expect(Number.isFinite(evaluation.value)).toBe(true);
      } else {
        expectWellFormedFailure(evaluation);
      }
    }
    // Almost everything random should be rejected.
    expect(rejected).toBeGreaterThan(4500);
  });

  it("handles 2,000 random JSON-like strings without throwing", () => {
    const random = createSeededRandom(7);
    const alphabet = ['{', '}', '[', ']', '"', ':', ',', '1', 'e', '-', 'a', 'v', 'r', 'const', 'var', 'op', ' '];
    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: integer(random, 0, 40) }, () => pick(random, alphabet)).join("");
      const result = parseExpressionJson(text);
      if (!result.ok) {
        expectWellFormedFailure(result);
      }
    }
  });
});

describe("Fuzz: generated valid expressions", () => {
  it("accepts 2,000 random valid trees and evaluates them to a finite value or a documented error", () => {
    const random = createSeededRandom(99);
    const seenCodes = new Set<string>();
    let successes = 0;
    for (let i = 0; i < 2000; i++) {
      const tree = validTree(random, integer(random, 1, 5));
      expect(validateExpression(tree).ok).toBe(true);

      const variables = randomVariables(random);
      const result = evaluateExpression(tree, variables);
      if (result.ok) {
        successes++;
        expect(Number.isFinite(result.value)).toBe(true);
      } else {
        expect(EVALUATION_CODES.has(result.error.code)).toBe(true);
        seenCodes.add(result.error.code);
      }
      // Sending the same tree as JSON text gives the same answer.
      const fromText = parseExpressionJson(JSON.stringify(tree));
      expect(fromText.ok).toBe(true);
      if (fromText.ok) {
        expect(evaluateExpression(fromText.expression, variables)).toStrictEqual(result);
      }
    }
    expect(successes).toBeGreaterThan(1000);
    expect(seenCodes.has("SQRT_OF_NEGATIVE") || seenCodes.has("LOG_OF_NON_POSITIVE")).toBe(true);
  });

  it("produces the same results for the same seed", () => {
    const run = () => {
      const random = createSeededRandom(1234);
      return Array.from({ length: 300 }, () =>
        evaluateExpression(validTree(random, 5), randomVariables(random)),
      );
    };
    expect(run()).toStrictEqual(run());
  });
});

describe("Fuzz: one deliberate corruption always produces the matching error", () => {
  type Corruption = { applies: (node: Record<string, unknown>) => boolean; apply: (node: Record<string, unknown>) => void; code: LanguageErrorCode };

  const corruptions: Corruption[] = [
    { applies: (node) => "var" in node, apply: (node) => (node.var = "d"), code: "UNKNOWN_VARIABLE" },
    { applies: (node) => "op" in node, apply: (node) => (node.op = "pow"), code: "UNKNOWN_OPERATOR" },
    { applies: (node) => "fn" in node, apply: (node) => (node.fn = "exp"), code: "UNKNOWN_FUNCTION" },
    { applies: () => true, apply: (node) => (node.extra = 1), code: "UNEXPECTED_FIELD" },
    { applies: (node) => "op" in node, apply: (node) => delete node.right, code: "INVALID_EXPRESSION" },
    { applies: (node) => "const" in node, apply: (node) => (node.const = Number.NaN), code: "INVALID_EXPRESSION" },
    { applies: (node) => "const" in node, apply: (node) => (node.const = Number.POSITIVE_INFINITY), code: "INVALID_EXPRESSION" },
    { applies: (node) => "const" in node, apply: (node) => (node.const = "1"), code: "INVALID_EXPRESSION" },
  ];

  it("rejects 2,000 corrupted valid trees with the expected code", () => {
    const random = createSeededRandom(4242);
    let applied = 0;
    for (let i = 0; i < 2000; i++) {
      const tree = validTree(random, integer(random, 1, 5));
      const node = pick(random, allNodes(tree));
      const options = corruptions.filter((corruption) => corruption.applies(node));
      const corruption = pick(random, options);
      corruption.apply(node);
      applied++;

      const result = validateExpression(tree);
      expect(result).toEqual({
        ok: false,
        error: { code: corruption.code, message: LANGUAGE_ERROR_MESSAGES[corruption.code] },
      });
    }
    expect(applied).toBe(2000);
  });
});
