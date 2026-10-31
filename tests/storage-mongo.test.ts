/**
 * Runs the storage contract against a real MongoDB server. By default an
 * in-process `mongod` is started with mongodb-memory-server (downloaded on
 * first use). Set XENO_TEST_MONGO_URI to use an existing server instead.
 * Each test gets its own database, which is dropped afterwards.
 */
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongoSessionStore, SESSIONS_COLLECTION } from "../src/storage/mongo-session-store.js";
import type { SessionStore } from "../src/storage/session-store.js";
import { describeSessionStoreContract, sampleRecord } from "./storage-contract.js";

let server: MongoMemoryServer | undefined;
let uri = "";
const databases: string[] = [];

beforeAll(async () => {
  const external = process.env.XENO_TEST_MONGO_URI?.trim() ?? "";
  if (external !== "") {
    uri = external;
  } else {
    server = await MongoMemoryServer.create();
    uri = server.getUri();
  }
}, 180_000);

afterAll(async () => {
  if (databases.length > 0) {
    const client = await MongoClient.connect(uri);
    for (const name of databases) {
      await client.db(name).dropDatabase();
    }
    await client.close();
  }
  await server?.stop();
}, 60_000);

async function freshStore(): Promise<{ store: SessionStore; database: string }> {
  const database = `xeno-test-${randomUUID().slice(0, 8)}`;
  databases.push(database);
  return { store: await createMongoSessionStore({ uri, database }), database };
}

describeSessionStoreContract("mongodb", async () => (await freshStore()).store);

describe("mongodb session store layout", () => {
  it("stores one queryable document per session with model content as JSON text", async () => {
    const { store, database } = await freshStore();
    try {
      await store.insert(sampleRecord("a"));
      const client = await MongoClient.connect(uri);
      try {
        const document = await client.db(database).collection(SESSIONS_COLLECTION).findOne({ _id: "a" as never });
        expect(document).toMatchObject({ worldId: "ring-world", status: "running", experimentCount: 1, modelTurns: 1 });
        expect(typeof document!.transcriptJson).toBe("string");
        expect(typeof document!.messagesJson).toBe("string");
        expect(document!.config.noiseSeed).toBe(41);
        const indexes = await client.db(database).collection(SESSIONS_COLLECTION).indexes();
        expect(indexes.some((index) => index.key.createdAt === 1)).toBe(true);
      } finally {
        await client.close();
      }
    } finally {
      await store.close();
    }
  });

  it("keeps records across a reconnect", async () => {
    const { store, database } = await freshStore();
    await store.insert(sampleRecord("a"));
    await store.close();
    const reopened = await createMongoSessionStore({ uri, database });
    try {
      expect(await reopened.get("a")).toEqual(sampleRecord("a"));
    } finally {
      await reopened.close();
    }
  });
});
