import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/app.js";
import { createSessionManager } from "../src/api/session-manager.js";
import { createDummyProvider } from "../src/llm/dummy-provider.js";

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

function dashboardFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "xeno-dashboard-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(directory, "assets", "index-abc.js"), "console.info('app');");
  writeFileSync(join(directory, "assets", "index-abc.css"), "body{}");
  writeFileSync(join(directory, "secret.txt"), "outside assets");
  return directory;
}

async function start(dashboardDirectory?: string) {
  const sessions = createSessionManager({ providers: { dummy: createDummyProvider } });
  const server = createApiServer({ sessions, dashboardDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init?: RequestInit) => fetch(`${base}${path}`, { redirect: "manual", ...init });
}

describe("Dashboard hosting", () => {
  it("serves the page with a strict content security policy", async () => {
    const get = await start(dashboardFixture());
    const redirect = await get("/dashboard");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/dashboard/");

    const page = await get("/dashboard/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe");
    expect(await page.text()).toContain('id=root');
  });

  it("serves hashed assets with their types", async () => {
    const get = await start(dashboardFixture());
    const script = await get("/dashboard/assets/index-abc.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("/dashboard/assets/index-abc.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    const head = await get("/dashboard/assets/index-abc.js", { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it.each([
    "/dashboard/secret.txt",
    "/dashboard/assets/missing.js",
    "/dashboard/assets/..%2fsecret.txt",
    "/dashboard/assets/%2e%2e%2fsecret.txt",
    "/dashboard/assets/.hidden.js",
    "/dashboard/assets/index-abc.txt",
    "/dashboard/../package.json",
    "/dashboard/index.html",
  ])("refuses %s", async (path) => {
    const get = await start(dashboardFixture());
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("outside assets");
  });

  it("allows only GET and HEAD", async () => {
    const get = await start(dashboardFixture());
    const response = await get("/dashboard/", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("is absent when no dashboard directory is configured", async () => {
    const get = await start();
    expect((await get("/dashboard/")).status).toBe(404);
    expect((await get("/health")).status).toBe(200);
  });
});
