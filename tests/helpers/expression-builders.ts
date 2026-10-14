/** Small builders that keep expression trees readable in tests. */
import { LANGUAGE_ERROR_MESSAGES, type LanguageErrorCode } from "../../src/language/errors.js";

export const k = (value: unknown) => ({ const: value });
export const v = (name: unknown) => ({ var: name });
export const bin = (op: unknown, left: unknown, right: unknown) => ({ op, left, right });
export const call = (fn: unknown, ...args: unknown[]) => ({ fn, args });

/** The Glow World target measurement: (a - 5) * (b - 5). */
export const glowMeasurement = () => bin("mul", bin("sub", v("a"), k(5)), bin("sub", v("b"), k(5)));

/** `depth` levels of nested abs() around a constant: abs(abs(...abs(1))). */
export function nestedAbs(depth: number): unknown {
  let node: unknown = k(1);
  for (let level = 1; level < depth; level++) {
    node = call("abs", node);
  }
  return node;
}

/** A balanced addition tree over `leafCount` constants (2 * leafCount - 1 nodes). */
export function balancedSum(leafCount: number): unknown {
  let level: unknown[] = Array.from({ length: leafCount }, (_, i) => k(i));
  while (level.length > 1) {
    const next: unknown[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? bin("add", level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function failureOf(code: LanguageErrorCode) {
  return { ok: false, error: { code, message: LANGUAGE_ERROR_MESSAGES[code] } };
}
