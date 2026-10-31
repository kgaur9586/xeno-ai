// @vitest-environment jsdom
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../../src/api/app.js";
import { createSessionManager } from "../../src/api/session-manager.js";
import { createDummyProvider } from "../../src/llm/dummy-provider.js";
import { createApiClient } from "../src/api.js";
import { App } from "../src/App.js";

const TOKEN = "dashboard-test-token-0123456789";
const NOISE_SEED = "918273645";

let server: Server;
let base: string;

beforeEach(async () => {
  const sessions = createSessionManager({ providers: { dummy: createDummyProvider } });
  server = createApiServer({ sessions, operatorToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createAndFinish(worldId: string) {
  await screen.findByRole("option", { name: worldId });
  fireEvent.change(screen.getByLabelText("World"), { target: { value: worldId } });
  fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "27" } });
  fireEvent.change(screen.getByLabelText(/Noise seed/), { target: { value: NOISE_SEED } });
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  const detail = await screen.findByRole("region", { name: "Session detail" });
  fireEvent.click(within(detail).getByRole("button", { name: "Run to end" }));
  await within(detail).findByText("Theory submitted", {}, { timeout: 5000 });
  await waitFor(() => expect(within(detail).getAllByTestId("timeline-mark")).toHaveLength(27));
  return detail;
}

describe("Dashboard against the real API", () => {
  it("creates a session, runs it, and shows its timeline and theory without scores", async () => {
    render(<App client={createApiClient(base)} />);
    const detail = await createAndFinish("drift-world");

    expect(within(detail).getByText(/^outcome = /, { selector: "p" })).toBeTruthy();
    expect((await within(detail).findByRole("table", { name: "Theory attempts" })).textContent).toContain("accepted");
    expect(within(screen.getByRole("list", { name: "Sessions" })).getByText("27/27")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Theories" })).getByText("drift-world")).toBeTruthy();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain(NOISE_SEED);
    expect(text).not.toMatch(/Held-out scores|Score charts|RMSE|Evaluate theory/);
  });

  it("shows held-out scores only after the operator token is entered", async () => {
    render(<App client={createApiClient(base)} />);
    const detail = await createAndFinish("ring-world");

    fireEvent.change(screen.getByLabelText("Operator token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Show scores" }));
    await screen.findByText(/Operator mode/);
    fireEvent.click(within(detail).getByRole("button", { name: "Evaluate theory" }));

    const charts = await screen.findByRole("region", { name: "Score charts" });
    expect(within(charts).getAllByTestId("score-bar")).toHaveLength(2);
    expect(within(detail).getByText(/Held-out scores/)).toBeTruthy();
    const theories = screen.getByRole("table", { name: "Theories" });
    expect(within(theories).getByText("In range")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide scores" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Score charts" })).toBeNull());
    expect(within(screen.getByRole("table", { name: "Theories" })).queryByText("In range")).toBeNull();
  });

  it("drops a rejected token and reports the error", async () => {
    render(<App client={createApiClient(base)} />);
    await createAndFinish("glow-world");
    fireEvent.change(screen.getByLabelText("Operator token"), { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Show scores" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("UNAUTHORIZED");
    expect(screen.getByLabelText("Operator token")).toBeTruthy();
    expect(document.body.textContent).not.toContain("wrong-token");
  });

  it("deletes a session", async () => {
    render(<App client={createApiClient(base)} />);
    await createAndFinish("glow-world");
    fireEvent.click(screen.getByRole("button", { name: /^Delete session/ }));
    await screen.findByText(/No sessions yet/);
    expect(screen.queryByRole("region", { name: "Session detail" })).toBeNull();
  });

  it("reports an unreachable API", async () => {
    render(<App client={createApiClient("http://127.0.0.1:1")} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the XENO API.");
  });
});
