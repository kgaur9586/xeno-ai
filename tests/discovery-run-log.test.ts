import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoveryRunFileName, saveRunFile } from "../src/agents/discovery-run-log.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xeno-run-"));
  directories.push(directory);
  return directory;
}

describe("Discovery run log", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds a file name that is safe on Windows", () => {
    const name = discoveryRunFileName(new Date("2026-10-31T16:30:45.123Z"), "dummy", "theory_submitted");
    expect(name).toBe("discovery-20261031T163045Z-dummy-theory_submitted.json");
    expect(name).not.toContain(":");
    expect(discoveryRunFileName(new Date("2026-10-31T16:30:45.123Z"), "gemini:flash", "theory_submitted")).toBe(
      "discovery-20261031T163045Z-geminiflash-theory_submitted.json",
    );
  });

  it("writes a JSON copy and refuses to overwrite an existing file name", () => {
    const directory = temporaryDirectory();
    const first = saveRunFile({ directory, fileName: "discovery-test.json", body: { n: 1 } });
    const second = saveRunFile({ directory, fileName: "discovery-test.json", body: { n: 2 } });
    expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ n: 1 });
    expect(path.basename(second)).toBe("discovery-test-2.json");
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({ n: 2 });
  });

  it("refuses to save a known secret and leaves no file behind", () => {
    const directory = temporaryDirectory();
    const secret = "super-secret-value";
    expect(() =>
      saveRunFile({
        directory,
        fileName: "leak.json",
        body: { transcript: `token ${secret}` },
        secrets: [secret],
      }),
    ).toThrow(/secret/);
    expect(existsSync(path.join(directory, "leak.json"))).toBe(false);
  });

  it("keeps saved runs out of Git", () => {
    const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    expect(ignore).toMatch(/^runs\/$/m);
  });
});
