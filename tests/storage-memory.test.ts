import { describe, expect, it } from "vitest";
import { createMemorySessionStore } from "../src/storage/session-store.js";
import { describeSessionStoreContract, sampleRecord } from "./storage-contract.js";

describeSessionStoreContract("memory", async () => createMemorySessionStore());

describe("memory session store", () => {
  it("refuses use after close", async () => {
    const store = createMemorySessionStore();
    await store.insert(sampleRecord("a"));
    await store.close();
    await expect(store.get("a")).rejects.toThrow(/closed/);
  });
});
