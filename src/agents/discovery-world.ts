/**
 * Reads the public facts the discovery agent needs from a world description:
 * attribute names, the outcome name, and its kind.
 */
import { createVariableSet, type VariableSet } from "../language/expression.js";
import type { AnyWorldDescription } from "../tools/public-types.js";
import type { DiscoveryToolShape } from "./discovery-tool-declarations.js";

export interface DiscoveryWorldShape extends DiscoveryToolShape {
  outcomeName: string;
  variables: VariableSet;
}

export function discoveryShapeOf(description: AnyWorldDescription): DiscoveryWorldShape {
  const variableNames = Object.keys(description.attributes);
  const outcomes = Object.entries(description.outcome);
  if (outcomes.length !== 1) {
    throw new Error("A world description must name exactly one outcome.");
  }
  const [outcomeName, outcomeKind] = outcomes[0]!;
  if (outcomeKind !== "boolean" && outcomeKind !== "number") {
    throw new Error("Unsupported outcome kind.");
  }
  return {
    variableNames,
    outcomeName,
    outcomeKind,
    variables: createVariableSet(variableNames),
  };
}
