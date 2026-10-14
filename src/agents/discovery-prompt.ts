/**
 * The only text the model is given before it starts calling tools.
 *
 * The text is built from the public world description and the documented tool
 * declarations. It does not read project documents or source files.
 */
import type { PublicDescription } from "../tools/schemas.js";
import { DISCOVERY_TOOL_DECLARATIONS } from "./discovery-tool-declarations.js";

export interface DiscoveryPrompt {
  systemInstruction: string;
  userMessage: string;
}

export function buildDiscoveryPrompt(description: PublicDescription): DiscoveryPrompt {
  const tools = DISCOVERY_TOOL_DECLARATIONS.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");

  const systemInstruction = [
    "You are investigating an unknown world. Predict its boolean outcome by running experiments, defining measurements, and submitting one theory.",
    "You may use only the public world description, your experiment budget, observations returned by the tools, and the tool descriptions.",
    "Measurements and theories are JSON data in the restricted language described by the tools. They are not JavaScript and must never be written as code.",
    "",
    "Public world description:",
    JSON.stringify(description),
    "",
    "Tools:",
    tools,
    "",
    "Call the tools to investigate. A valid submit_theory ends the investigation. You will not receive an evaluation score.",
  ].join("\n");

  const userMessage = [
    `The experiment budget is ${description.experimentBudget}.`,
    "No observations have been collected yet.",
    "Investigate the world using the tools.",
  ].join(" ");

  return { systemInstruction, userMessage };
}
