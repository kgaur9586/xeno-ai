/**
 * The restricted measurement language: node types, the whitelist of allowed
 * names, the complexity limits, and the Zod schema for one expression.
 *
 * An expression is a JSON tree (an "abstract syntax tree"). It is data, not
 * code: the only way to compute with it is the interpreter in
 * `interpreter.ts`, which supports exactly the operations listed here.
 */
import { z } from "zod";

export const VARIABLE_NAMES = ["a", "b", "c"] as const;
export const BINARY_OPERATORS = ["add", "sub", "mul", "div"] as const;
export const UNARY_FUNCTIONS = ["abs", "sqrt", "log"] as const;
export const VARIADIC_FUNCTIONS = ["min", "max"] as const;
export const FUNCTION_NAMES = [...UNARY_FUNCTIONS, ...VARIADIC_FUNCTIONS] as const;

/** The only field names a node may have. */
export const NODE_FIELDS = ["const", "var", "op", "left", "right", "fn", "args"] as const;

/** Longest path from the root to a leaf, counting both ends (a single constant has depth 1). */
export const MAX_DEPTH = 12;
/** Total number of nodes (constants, variables, operations, and function calls). */
export const MAX_NODES = 64;
/** Most arguments any function call may have (`min` and `max` need at least 2). */
export const MAX_FUNCTION_ARGS = 4;
/** Longest JSON text accepted by `parseExpressionJson`. */
export const MAX_EXPRESSION_JSON_LENGTH = 4096;

export type VariableName = (typeof VARIABLE_NAMES)[number];
export type BinaryOperator = (typeof BINARY_OPERATORS)[number];
export type UnaryFunction = (typeof UNARY_FUNCTIONS)[number];
export type VariadicFunction = (typeof VARIADIC_FUNCTIONS)[number];

export interface ConstantNode {
  const: number;
}

export interface VariableNode {
  var: VariableName;
}

export interface BinaryNode {
  op: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface UnaryCallNode {
  fn: UnaryFunction;
  args: [Expression];
}

export interface VariadicCallNode {
  fn: VariadicFunction;
  args: Expression[];
}

export type Expression = ConstantNode | VariableNode | BinaryNode | UnaryCallNode | VariadicCallNode;

/** Values for the observed variables, e.g. the inputs of one observation. */
export type VariableValues = Record<VariableName, number>;

// z.number() rejects NaN and Infinity in Zod 4.
export const ExpressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.strictObject({ const: z.number() }),
    z.strictObject({ var: z.enum(VARIABLE_NAMES) }),
    z.strictObject({
      op: z.enum(BINARY_OPERATORS),
      left: ExpressionSchema,
      right: ExpressionSchema,
    }),
    z.strictObject({
      fn: z.enum(UNARY_FUNCTIONS),
      args: z.tuple([ExpressionSchema]),
    }),
    z.strictObject({
      fn: z.enum(VARIADIC_FUNCTIONS),
      args: z.array(ExpressionSchema).min(2).max(MAX_FUNCTION_ARGS),
    }),
  ]),
);

export const VariableValuesSchema = z.strictObject({
  a: z.number(),
  b: z.number(),
  c: z.number(),
});
