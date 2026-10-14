/**
 * Loads only the Gemini settings from a local .env file.
 *
 * Other variables in the file are ignored, existing environment values are
 * kept, and the file contents are never logged.
 */
import { readFileSync } from "node:fs";

const GEMINI_ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_MODEL"] as const;

export function loadProjectEnv(filePath = ".env", env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed === undefined) {
      continue;
    }
    const current = env[parsed.key];
    if (current !== undefined && current !== "") {
      continue;
    }
    env[parsed.key] = parsed.value;
  }
}

export function readGeminiConfig(env: NodeJS.ProcessEnv): { apiKey: string; model: string } {
  const apiKey = env.GEMINI_API_KEY?.trim() ?? "";
  const model = env.GEMINI_MODEL?.trim() ?? "";
  return { apiKey, model };
}

function parseEnvLine(line: string): { key: (typeof GEMINI_ENV_KEYS)[number]; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }
  const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const separator = body.indexOf("=");
  if (separator === -1) {
    return undefined;
  }
  const key = body.slice(0, separator).trim();
  if (!isGeminiEnvKey(key)) {
    return undefined;
  }
  return { key, value: unquote(body.slice(separator + 1).trim()) };
}

function isGeminiEnvKey(key: string): key is (typeof GEMINI_ENV_KEYS)[number] {
  return (GEMINI_ENV_KEYS as readonly string[]).includes(key);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
