/**
 * Writes an operator copy of a finished run to disk.
 *
 * The file is for later inspection. It is not sent back to a provider.
 * A known secret blocks the write.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function discoveryRunFileName(savedAt: Date, providerKind: string, status: string): string {
  const stamp = savedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `discovery-${stamp}-${sanitize(providerKind)}-${sanitize(status)}.json`;
}

export function saveRunFile(options: {
  directory: string;
  fileName: string;
  body: unknown;
  secrets?: readonly string[];
}): string {
  const text = `${JSON.stringify(options.body, null, 2)}\n`;
  for (const secret of options.secrets ?? []) {
    if (secret !== "" && text.includes(secret)) {
      throw new Error("Refusing to save a run that still contains a secret.");
    }
  }

  mkdirSync(options.directory, { recursive: true });
  const fileName = uniqueFileName(options.directory, path.basename(options.fileName));
  const filePath = path.join(options.directory, fileName);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

function uniqueFileName(directory: string, fileName: string): string {
  if (!existsSync(path.join(directory, fileName))) {
    return fileName;
  }
  const dot = fileName.lastIndexOf(".");
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const extension = dot === -1 ? "" : fileName.slice(dot);
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!existsSync(path.join(directory, candidate))) {
      return candidate;
    }
  }
  throw new Error("Refusing to save a run because the file name is already in use.");
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_-]/gi, "");
  return cleaned === "" ? "run" : cleaned;
}
