import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_EXPRESSION_JSON_LENGTH,
  MAX_FUNCTION_ARGS,
  MAX_NODES,
} from "../src/language/expression.js";
import { parseExpressionJson, validateExpression } from "../src/language/validate.js";
import {
  balancedSum,
  bin,
  call,
  deepFreeze,
  failureOf,
  glowMeasurement,
  k,
  nestedAbs,
  v,
} from "./helpers/expression-builders.js";

function expectValid(input: unknown): void {
  const result = validateExpression(input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

describe("Valid expressions", () => {
  it.each([
    ["a constant", k(5)],
    ["a negative decimal constant", k(-3.25)],
    ["zero", k(0)],
    ["a very large finite constant", k(Number.MAX_VALUE)],
    ["each variable", v("a")],
    ["variable b", v("b")],
    ["variable c", v("c")],
    ["each operator", bin("add", k(1), k(2))],
    ["sub", bin("sub", v("a"), k(5))],
    ["mul", bin("mul", v("a"), v("b"))],
    ["div", bin("div", v("a"), k(2))],
    ["abs", call("abs", v("a"))],
    ["sqrt", call("sqrt", v("a"))],
    ["log", call("log", v("a"))],
    ["min with 2 arguments", call("min", v("a"), v("b"))],
    ["max with the maximum number of arguments", call("max", v("a"), v("b"), v("c"), k(1))],
    ["the Glow World measurement", glowMeasurement()],
  ])("accepts %s", (_label, expression) => {
    expectValid(expression);
  });

  it("returns a fresh copy equal to the input", () => {
    const input = glowMeasurement();
    const result = validateExpression(input);
    if (!result.ok) throw new Error("expected valid");
    expect(result.expression).toStrictEqual(input);
    expect(result.expression).not.toBe(input);
    expect((result.expression as { left: unknown }).left).not.toBe(input.left);
  });

  it("accepts objects without a prototype", () => {
    const node = Object.assign(Object.create(null) as object, { const: 1 });
    expectValid(node);
  });
});

describe("Unknown names", () => {
  it.each(["d", "A", "", "constructor", "__proto__", "toString", "threshold"])(
    "rejects unknown variable %j",
    (name) => {
      expect(validateExpression(v(name))).toEqual(failureOf("UNKNOWN_VARIABLE"));
    },
  );

  it.each(["pow", "mod", "eval", "plus", "ADD", "constructor"])("rejects unknown operator %j", (op) => {
    expect(validateExpression(bin(op, k(1), k(2)))).toEqual(failureOf("UNKNOWN_OPERATOR"));
  });

  it.each(["exp", "eval", "require", "Function", "fetch", "constructor", "sin"])(
    "rejects unknown function %j",
    (fn) => {
      expect(validateExpression(call(fn, k(1)))).toEqual(failureOf("UNKNOWN_FUNCTION"));
    },
  );

  it("does not echo the unknown name in the error message", () => {
    const result = validateExpression(v("secretName"));
    expect(JSON.stringify(result)).not.toContain("secretName");
  });
});

describe("Missing, extra, and wrongly typed fields", () => {
  it.each([
    ["an empty object", {}],
    ["an operation without right", { op: "add", left: k(1) }],
    ["an operation without left or right", { op: "add" }],
    ["left and right without op", { left: k(1), right: k(2) }],
    ["a function without args", { fn: "abs" }],
    ["args without fn", { args: [k(1)] }],
    ["abs with no arguments", call("abs")],
    ["abs with two arguments", call("abs", k(1), k(2))],
    ["min with one argument", call("min", k(1))],
    ["max with no arguments", call("max")],
    ["a constant mixed with a variable", { const: 1, var: "a" }],
    ["an operation mixed with a function", { op: "add", left: k(1), right: k(2), fn: "abs" }],
    ["a numeric operator", bin(5, k(1), k(2))],
    ["a numeric variable name", v(1)],
    ["args that are not an array", { fn: "abs", args: "a" }],
    ["a primitive child", bin("add", 5, k(2))],
    ["a null child", bin("add", null, k(2))],
    ["an array child", bin("add", [k(1)], k(2))],
    ["a hole in args", { fn: "min", args: [k(1), , k(2)] }],
  ])("rejects %s", (_label, input) => {
    expect(validateExpression(input)).toEqual(failureOf("INVALID_EXPRESSION"));
  });

  it.each([
    ["an extra field on a constant", { const: 1, extra: 2 }],
    ["an extra field on a nested node", bin("add", { var: "a", note: "x" }, k(1))],
    ["a field named like an application object", { const: 1, tools: {} }],
    ["an own __proto__ field", JSON.parse('{"const":1,"__proto__":{"var":"a"}}')],
  ])("rejects %s", (_label, input) => {
    expect(validateExpression(input)).toEqual(failureOf("UNEXPECTED_FIELD"));
  });

  it("does not read fields inherited from a prototype", () => {
    const node = Object.assign(Object.create({ left: k(1), right: k(2) }) as object, { op: "add" });
    expect(validateExpression(node)).toEqual(failureOf("INVALID_EXPRESSION"));
  });

  it.each([null, undefined, 5, "a", true, [], [k(1)], () => 1, new Date(0), new Map()])(
    "rejects the non-expression root value %#",
    (input) => {
      expect(validateExpression(input)).toEqual(failureOf("INVALID_EXPRESSION"));
    },
  );
});

describe("Numeric constants", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a numeric string", "5"],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an object", { value: 5 }],
    ["an array", [5]],
    ["a bigint", 5n],
  ])("rejects %s as a constant", (_label, value) => {
    expect(validateExpression(k(value))).toEqual(failureOf("INVALID_EXPRESSION"));
  });

  it("rejects an invalid constant deep inside a valid tree", () => {
    const expression = bin("mul", bin("sub", v("a"), k(5)), bin("sub", v("b"), k(Number.NaN)));
    expect(validateExpression(expression)).toEqual(failureOf("INVALID_EXPRESSION"));
  });
});

describe("Complexity limits", () => {
  it("uses the documented conservative limits", () => {
    expect(MAX_DEPTH).toBe(12);
    expect(MAX_NODES).toBe(64);
    expect(MAX_FUNCTION_ARGS).toBe(4);
    expect(MAX_EXPRESSION_JSON_LENGTH).toBe(4096);
  });

  it("accepts depth 12 and rejects depth 13", () => {
    expectValid(nestedAbs(MAX_DEPTH));
    expect(validateExpression(nestedAbs(MAX_DEPTH + 1))).toEqual(failureOf("EXPRESSION_TOO_DEEP"));
  });

  it("rejects a 100,000-level expression without a stack overflow", () => {
    expect(validateExpression(nestedAbs(100_000))).toEqual(failureOf("EXPRESSION_TOO_DEEP"));
    let chain: unknown = k(1);
    for (let i = 0; i < 100_000; i++) {
      chain = bin("add", chain, k(1));
    }
    expect(validateExpression(chain)).toEqual(failureOf("EXPRESSION_TOO_DEEP"));
  });

  it("accepts 64 nodes and rejects 65 nodes", () => {
    const sixtyThree = balancedSum(32);
    expectValid(call("abs", sixtyThree));
    expect(validateExpression(call("abs", call("abs", balancedSum(32))))).toEqual(
      failureOf("EXPRESSION_TOO_LARGE"),
    );
  });

  it("rejects a very large but shallow tree", () => {
    expect(validateExpression(balancedSum(50_000))).toEqual(failureOf("EXPRESSION_TOO_LARGE"));
  });

  it("accepts 4 function arguments and rejects 5", () => {
    expectValid(call("min", k(1), k(2), k(3), k(4)));
    expect(validateExpression(call("min", k(1), k(2), k(3), k(4), k(5)))).toEqual(
      failureOf("TOO_MANY_ARGUMENTS"),
    );
    expect(validateExpression(call("abs", k(1), k(2), k(3), k(4), k(5)))).toEqual(
      failureOf("TOO_MANY_ARGUMENTS"),
    );
  });

  it("rejects a huge argument array without walking it", () => {
    const huge = { fn: "max", args: new Array(10_000_000) };
    expect(validateExpression(huge)).toEqual(failureOf("TOO_MANY_ARGUMENTS"));
  });
});

describe("Cyclic and malformed objects", () => {
  it("rejects a node that contains itself", () => {
    const node: Record<string, unknown> = { op: "add", right: k(1) };
    node.left = node;
    expect(validateExpression(node)).toEqual(failureOf("CYCLIC_EXPRESSION"));
  });

  it("rejects a cycle through function arguments", () => {
    const node = { fn: "min", args: [k(1)] as unknown[] };
    node.args.push(node);
    expect(validateExpression(node)).toEqual(failureOf("CYCLIC_EXPRESSION"));
  });

  it("rejects a deeper cycle", () => {
    const inner: Record<string, unknown> = { op: "sub", left: v("a") };
    const outer = bin("mul", inner, k(2));
    inner.right = outer;
    expect(validateExpression(outer)).toEqual(failureOf("CYCLIC_EXPRESSION"));
  });

  it("rejects a node object reused in two places", () => {
    const shared = k(1);
    expect(validateExpression(bin("add", shared, shared))).toEqual(failureOf("CYCLIC_EXPRESSION"));
  });

  it("rejects an args array reused by two calls", () => {
    const args = [k(1), k(2)];
    const expression = bin("add", { fn: "min", args }, { fn: "max", args });
    expect(validateExpression(expression)).toEqual(failureOf("CYCLIC_EXPRESSION"));
  });

  it("fails safely when a property getter throws", () => {
    const hostile = {
      op: "add",
      get left(): unknown {
        throw new Error("internal detail");
      },
      right: k(1),
    };
    const result = validateExpression(hostile);
    expect(result).toEqual(failureOf("INVALID_EXPRESSION"));
    expect(JSON.stringify(result)).not.toContain("internal detail");
  });

  it("fails safely when a proxy throws while listing keys", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    expect(validateExpression(hostile)).toEqual(failureOf("INVALID_EXPRESSION"));
  });

  it("stops a proxy that invents a new child on every read", () => {
    const endless: object = new Proxy(
      {},
      {
        ownKeys: () => ["op", "left", "right"],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        get: (_target, key) => (key === "op" ? "add" : new Proxy({}, endlessHandler())),
      },
    );
    function endlessHandler(): ProxyHandler<object> {
      return {
        ownKeys: () => ["op", "left", "right"],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        get: (_target, key) => (key === "op" ? "add" : new Proxy({}, endlessHandler())),
      };
    }
    const result = validateExpression(endless);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["EXPRESSION_TOO_DEEP", "EXPRESSION_TOO_LARGE"]).toContain(result.error.code);
  });

  it("validates a snapshot, so a getter cannot change its answer between checks", () => {
    let reads = 0;
    const tricky = {
      get const(): unknown {
        reads++;
        return reads === 1 ? 5 : Number.NaN;
      },
    };
    const result = validateExpression(tricky);
    expect(reads).toBe(1);
    expect(result).toEqual({ ok: true, expression: { const: 5 } });
  });
});

describe("JSON text input", () => {
  it("accepts a valid expression as JSON text", () => {
    const result = parseExpressionJson(JSON.stringify(glowMeasurement()));
    expect(result).toEqual({ ok: true, expression: glowMeasurement() });
  });

  it("accepts text of exactly the maximum length and rejects one character more", () => {
    const base = JSON.stringify(k(1));
    const atLimit = base + " ".repeat(MAX_EXPRESSION_JSON_LENGTH - base.length);
    expect(parseExpressionJson(atLimit).ok).toBe(true);
    expect(parseExpressionJson(atLimit + " ")).toEqual(failureOf("INPUT_TOO_LONG"));
  });

  it("rejects very long text before parsing it", () => {
    expect(parseExpressionJson("[".repeat(1_000_000))).toEqual(failureOf("INPUT_TOO_LONG"));
  });

  it.each(["", "{", "{const: 1}", "undefined", "NaN", "{'const': 1}", '{"const": 1,}'])(
    "rejects invalid JSON %j",
    (text) => {
      expect(parseExpressionJson(text)).toEqual(failureOf("INVALID_JSON"));
    },
  );

  it.each([null, undefined, 5, {}, k(1)])("rejects non-text input %#", (input) => {
    expect(parseExpressionJson(input)).toEqual(failureOf("INVALID_JSON"));
  });

  it("applies every structural rule to parsed text", () => {
    expect(parseExpressionJson("[".repeat(2000) + "]".repeat(2000))).toEqual(failureOf("INVALID_EXPRESSION"));
    expect(parseExpressionJson('{"var":"d"}')).toEqual(failureOf("UNKNOWN_VARIABLE"));
    expect(parseExpressionJson('{"const":1e999}')).toEqual(failureOf("INVALID_EXPRESSION"));
    expect(parseExpressionJson(JSON.stringify(nestedAbs(MAX_DEPTH + 1)))).toEqual(
      failureOf("EXPRESSION_TOO_DEEP"),
    );
  });
});

describe("Immutability", () => {
  it("validates a deeply frozen expression without modifying it", () => {
    const input = deepFreeze(glowMeasurement());
    const before = structuredClone(input);
    expectValid(input);
    expect(input).toStrictEqual(before);
  });

  it("changing the returned expression does not change the input, and vice versa", () => {
    const input = glowMeasurement() as { op: string; left: { op: string } };
    const result = validateExpression(input);
    if (!result.ok) throw new Error("expected valid");
    (result.expression as { op: string }).op = "add";
    expect(input.op).toBe("mul");
    input.left.op = "div";
    expect((result.expression as { left: { op: string } }).left.op).toBe("sub");
  });
});

describe("Language module isolation", () => {
  const languageDirectory = new URL("../src/language/", import.meta.url);
  const files = readdirSync(languageDirectory).filter((name) => name.endsWith(".ts"));

  it("contains the expected files", () => {
    expect(files.sort()).toEqual([
      "errors.ts",
      "expression.ts",
      "interpreter.ts",
      "preflight.ts",
      "theory.ts",
      "validate.ts",
    ]);
  });

  it.each(files)("%s imports only zod and other language files", (file) => {
    const source = readFileSync(new URL(file, languageDirectory), "utf8");
    const specifiers = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!);
    for (const specifier of specifiers) {
      expect(specifier === "zod" || /^\.\/[a-z-]+\.js$/.test(specifier), specifier).toBe(true);
    }
  });

  it.each(files)("%s contains no dynamic code execution or system access", (file) => {
    const source = readFileSync(new URL(file, languageDirectory), "utf8");
    expect(source).not.toMatch(/\beval\s*\(|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|\bprocess\.|["']node:/);
  });
});
