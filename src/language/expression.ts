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
  /** One of the variable names allowed by the active variable set. */
  var: string;
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
export type VariableValues = Record<string, number>;

/** Most variables one world may declare. */
export const MAX_VARIABLES = 16;
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9]{0,15}$/;

/**
 * A checked list of variable names. Glow World uses `a`, `b`, `c`; other
 * worlds supply their own list. Only trusted code creates variable sets.
 */
export interface VariableSet {
  readonly names: readonly string[];
  readonly key: string;
}

export const DEFAULT_VARIABLE_SET: VariableSet = createVariableSet(VARIABLE_NAMES);

export function createVariableSet(names: readonly string[]): VariableSet {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_VARIABLES) {
    throw new Error("A variable set needs between 1 and 16 names.");
  }
  const unique = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !VARIABLE_NAME_PATTERN.test(name) || (NODE_FIELDS as readonly string[]).includes(name)) {
      throw new Error("Variable names must be short lowercase identifiers.");
    }
    unique.add(name);
  }
  if (unique.size !== names.length) {
    throw new Error("Variable names must be unique.");
  }
  const frozen = Object.freeze([...names]);
  return Object.freeze({ names: frozen, key: frozen.join(",") });
}

function buildExpressionSchema(variables: VariableSet): z.ZodType<Expression> {
  const names = variables.names as [string, ...string[]];
  // z.number() rejects NaN and Infinity in Zod 4.
  const schema: z.ZodType<Expression> = z.lazy(() =>
    z.union([
      z.strictObject({ const: z.number() }),
      z.strictObject({ var: z.enum(names) }),
      z.strictObject({
        op: z.enum(BINARY_OPERATORS),
        left: schema,
        right: schema,
      }),
      z.strictObject({
        fn: z.enum(UNARY_FUNCTIONS),
        args: z.tuple([schema]),
      }),
      z.strictObject({
        fn: z.enum(VARIADIC_FUNCTIONS),
        args: z.array(schema).min(2).max(MAX_FUNCTION_ARGS),
      }),
    ]),
  );
  return schema;
}

function buildValuesSchema(variables: VariableSet): z.ZodType<VariableValues> {
  const shape: Record<string, z.ZodNumber> = {};
  for (const name of variables.names) {
    shape[name] = z.number();
  }
  return z.strictObject(shape) as unknown as z.ZodType<VariableValues>;
}

const expressionSchemas = new Map<string, z.ZodType<Expression>>();
const valuesSchemas = new Map<string, z.ZodType<VariableValues>>();

export function expressionSchemaFor(variables: VariableSet): z.ZodType<Expression> {
  let schema = expressionSchemas.get(variables.key);
  if (schema === undefined) {
    schema = buildExpressionSchema(variables);
    expressionSchemas.set(variables.key, schema);
  }
  return schema;
}

export function variableValuesSchemaFor(variables: VariableSet): z.ZodType<VariableValues> {
  let schema = valuesSchemas.get(variables.key);
  if (schema === undefined) {
    schema = buildValuesSchema(variables);
    valuesSchemas.set(variables.key, schema);
  }
  return schema;
}

export const ExpressionSchema: z.ZodType<Expression> = expressionSchemaFor(DEFAULT_VARIABLE_SET);

export const VariableValuesSchema = z.strictObject({
  a: z.number(),
  b: z.number(),
  c: z.number(),
});
