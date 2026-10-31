/**
 * Altered copies of a world, used to measure transfer.
 *
 * A variant wraps a base world through a list of steps applied in order.
 * Every step reads and writes the variant's current attribute names.
 * - `shift`: the rule now reacts to `attribute - offset`, so every boundary on
 *   that attribute moves by `offset`. The public range is unchanged.
 * - `rescale`: the attribute is reported in new units, `value * factor`. The
 *   public range is scaled with it.
 * - `rename`: the attribute gets a new public name.
 * - `add-distractors`: new attributes the outcome ignores.
 * - `change-rule`: the outcome follows a new rule written in the theory
 *   language, with the base world's noise level.
 *
 * Trusted code only, like every world. The variant id is supplied by the
 * caller and must not describe the transformation, because agents see it.
 */
import { createVariableSet, type VariableSet } from "../language/expression.js";
import { evaluateExpression } from "../language/interpreter.js";
import { validateNumericTheory } from "../language/numeric-theory.js";
import { validateTheory, type ComparisonOperator } from "../language/theory.js";
import { drawStandardNormal, type RandomSource } from "../shared/random.js";
import type { AttributeRange, BooleanWorld, ExtrapolationProfile, NumericWorld, World, WorldInputs, WorldSpec } from "./world.js";

export type VariantStep =
  | { kind: "shift"; attribute: string; offset: number }
  | { kind: "rescale"; attribute: string; factor: number }
  | { kind: "rename"; from: string; to: string }
  | { kind: "add-distractors"; names: readonly string[]; range?: AttributeRange }
  | { kind: "change-rule"; rule: unknown };

const VARIANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface VariantState {
  names: string[];
  ranges: Record<string, AttributeRange>;
  extrapolation: { outsideAttributes: string[]; extendedAttributes: string[] };
  trueOutcome: (inputs: WorldInputs) => boolean | number;
  observe: (inputs: WorldInputs, random: RandomSource) => boolean | number;
}

export function createVariantWorld(base: World, steps: readonly VariantStep[], variantId: string): World {
  if (!VARIANT_ID_PATTERN.test(variantId) || variantId === base.spec.worldId) {
    throw new Error("Variant id must be a new lowercase id.");
  }

  let state: VariantState = {
    names: [...base.spec.attributeNames],
    ranges: Object.fromEntries(base.spec.attributeNames.map((name) => [name, { ...base.spec.attributes[name]! }])),
    extrapolation: {
      outsideAttributes: [...base.extrapolation.outsideAttributes],
      extendedAttributes: [...base.extrapolation.extendedAttributes],
    },
    trueOutcome: (inputs) => base.trueOutcome(inputs),
    observe: (inputs, random) => base.observe(inputs, random),
  };
  for (const step of steps) {
    state = applyStep(state, step, base);
  }

  const attributes: Record<string, AttributeRange> = {};
  for (const name of state.names) {
    attributes[name] = Object.freeze({ ...state.ranges[name]! });
  }
  const spec: WorldSpec = Object.freeze({
    worldId: variantId,
    attributeNames: Object.freeze([...state.names]),
    attributes: Object.freeze(attributes),
    outcomeName: base.spec.outcomeName,
    outcomeKind: base.spec.outcomeKind,
    noisy: base.spec.noisy,
  });
  const extrapolation: ExtrapolationProfile = Object.freeze({
    outsideAttributes: Object.freeze([...state.extrapolation.outsideAttributes]),
    extendedAttributes: Object.freeze([...state.extrapolation.extendedAttributes]),
  });
  const { trueOutcome, observe } = state;

  if (base.kind === "boolean") {
    const world: BooleanWorld = {
      kind: "boolean",
      spec,
      trueOutcome: (inputs) => trueOutcome(inputs) as boolean,
      observe: (inputs, random) => observe(inputs, random) as boolean,
      flipRate: base.flipRate,
      extrapolation,
    };
    return Object.freeze(world);
  }
  const world: NumericWorld = {
    kind: "number",
    spec,
    trueOutcome: (inputs) => trueOutcome(inputs) as number,
    observe: (inputs, random) => observe(inputs, random) as number,
    noiseStandardDeviation: base.noiseStandardDeviation,
    extrapolation,
  };
  return Object.freeze(world);
}

function applyStep(state: VariantState, step: VariantStep, base: World): VariantState {
  switch (step.kind) {
    case "shift": {
      requireAttribute(state, step.attribute);
      requireFinite(step.offset);
      const { attribute, offset } = step;
      const map = (inputs: WorldInputs): WorldInputs => ({ ...inputs, [attribute]: inputs[attribute]! - offset });
      return remapInputs(state, map);
    }
    case "rescale": {
      requireAttribute(state, step.attribute);
      if (!Number.isFinite(step.factor) || step.factor <= 0) {
        throw new Error("Rescale factor must be a positive number.");
      }
      const { attribute, factor } = step;
      const range = state.ranges[attribute]!;
      const map = (inputs: WorldInputs): WorldInputs => ({ ...inputs, [attribute]: inputs[attribute]! / factor });
      return {
        ...remapInputs(state, map),
        ranges: { ...state.ranges, [attribute]: { min: range.min * factor, max: range.max * factor } },
      };
    }
    case "rename": {
      requireAttribute(state, step.from);
      requireNewName(state, step.to);
      const { from, to } = step;
      const rename = (name: string) => (name === from ? to : name);
      const map = (inputs: WorldInputs): WorldInputs => {
        const renamed: Record<string, number> = { ...inputs, [from]: inputs[to]! };
        delete renamed[to];
        return renamed;
      };
      const ranges = { ...state.ranges, [to]: state.ranges[from]! };
      delete ranges[from];
      return {
        ...remapInputs(state, map),
        names: state.names.map(rename),
        ranges,
        extrapolation: {
          outsideAttributes: state.extrapolation.outsideAttributes.map(rename),
          extendedAttributes: state.extrapolation.extendedAttributes.map(rename),
        },
      };
    }
    case "add-distractors": {
      if (step.names.length === 0) {
        throw new Error("Add at least one distractor.");
      }
      const range = step.range ?? state.ranges[state.names[0]!]!;
      const ranges = { ...state.ranges };
      const names = [...state.names];
      for (const name of step.names) {
        requireNewName({ ...state, names }, name);
        names.push(name);
        ranges[name] = { min: range.min, max: range.max };
      }
      const ignored = new Set(step.names);
      const map = (inputs: WorldInputs): WorldInputs =>
        Object.fromEntries(Object.entries(inputs).filter(([name]) => !ignored.has(name)));
      return { ...remapInputs(state, map), names, ranges };
    }
    case "change-rule":
      return { ...state, ...ruleFunctions(step.rule, state.names, base) };
  }
}

function remapInputs(state: VariantState, map: (inputs: WorldInputs) => WorldInputs): VariantState {
  const { trueOutcome, observe } = state;
  return {
    ...state,
    trueOutcome: (inputs) => trueOutcome(map(inputs)),
    observe: (inputs, random) => observe(map(inputs), random),
  };
}

function ruleFunctions(
  rule: unknown,
  names: readonly string[],
  base: World,
): Pick<VariantState, "trueOutcome" | "observe"> {
  const variables = createVariableSet(names);
  if (base.kind === "boolean") {
    const validated = validateTheory(rule, variables);
    if (!validated.ok) {
      throw new Error("Changed rule must be a boolean theory over the variant's attributes.");
    }
    const { measurement, operator, threshold } = validated.theory;
    const truth = (inputs: WorldInputs) => compare(measure(measurement, inputs, variables), operator, threshold);
    const flipRate = base.flipRate;
    return {
      trueOutcome: truth,
      observe: (inputs, random) => {
        const value = truth(inputs);
        return base.spec.noisy && random() < flipRate ? !value : value;
      },
    };
  }
  const validated = validateNumericTheory(rule, variables);
  if (!validated.ok) {
    throw new Error("Changed rule must be a numeric theory over the variant's attributes.");
  }
  const { measurement } = validated.theory;
  const deviation = base.noiseStandardDeviation;
  const truth = (inputs: WorldInputs) => measure(measurement, inputs, variables);
  return {
    trueOutcome: truth,
    observe: (inputs, random) => {
      const value = truth(inputs);
      return base.spec.noisy ? value + deviation * drawStandardNormal(random) : value;
    },
  };
}

function measure(measurement: unknown, inputs: WorldInputs, variables: VariableSet): number {
  const values: Record<string, number> = {};
  for (const name of variables.names) {
    values[name] = inputs[name]!;
  }
  const result = evaluateExpression(measurement, values, variables);
  if (!result.ok) {
    throw new Error("Changed rule could not be evaluated.");
  }
  return result.value;
}

function compare(value: number, operator: ComparisonOperator, threshold: number): boolean {
  switch (operator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

function requireAttribute(state: VariantState, name: string): void {
  if (!state.names.includes(name)) {
    throw new Error("Unknown attribute in variant step.");
  }
}

function requireNewName(state: Pick<VariantState, "names">, name: string): void {
  if (state.names.includes(name)) {
    throw new Error("Attribute name already exists.");
  }
  createVariableSet([...state.names, name]);
}

function requireFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error("Variant step values must be finite.");
  }
}
