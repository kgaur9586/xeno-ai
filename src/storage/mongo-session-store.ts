/**
 * MongoDB backend for session storage.
 *
 * One document per session in the `sessions` collection, keyed by session
 * id. Settings, counters, the observation log, and evaluator results are
 * stored as ordinary fields, so they can be queried. Content the model wrote
 * (the transcript, the provider conversation, and the submitted theory) can
 * contain any key, including `$`-prefixed or dotted keys and `__proto__`, so
 * it is stored as JSON text and parsed back exactly.
 */
import { MongoClient, MongoServerError, type Collection } from "mongodb";
import {
  DuplicateSessionError,
  pickProgress,
  type SessionProgress,
  type SessionRecord,
  type SessionStore,
  type StoredEvaluation,
} from "./session-store.js";

export const DEFAULT_MONGODB_DATABASE = "xeno";
export const SESSIONS_COLLECTION = "sessions";
const DUPLICATE_KEY = 11000;

interface SessionDocument {
  _id: string;
  worldId: string;
  provider: SessionRecord["provider"];
  createdAt: string;
  updatedAt: string;
  config: SessionRecord["config"];
  status: SessionRecord["status"];
  modelTurns: number;
  experimentCount: number;
  observations: SessionRecord["observations"];
  providerDiagnostic: SessionRecord["providerDiagnostic"];
  evaluations: StoredEvaluation[];
  transcriptJson: string;
  messagesJson: string;
  submittedTheoryJson: string;
}

export interface MongoSessionStoreOptions {
  uri: string;
  database?: string;
}

export async function createMongoSessionStore(options: MongoSessionStoreOptions): Promise<SessionStore> {
  const client = new MongoClient(options.uri, { ignoreUndefined: true, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const sessions: Collection<SessionDocument> = client
    .db(options.database ?? DEFAULT_MONGODB_DATABASE)
    .collection<SessionDocument>(SESSIONS_COLLECTION);
  await sessions.createIndex({ createdAt: 1, _id: 1 });

  return {
    kind: "mongodb",
    async insert(record) {
      try {
        await sessions.insertOne(toDocument(record));
      } catch (error) {
        if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
          throw new DuplicateSessionError();
        }
        throw error;
      }
    },
    async get(sessionId) {
      const document = await sessions.findOne({ _id: sessionId });
      return document === null ? null : fromDocument(document);
    },
    async list() {
      const documents = await sessions.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
      return documents.map(fromDocument);
    },
    async count() {
      return sessions.countDocuments({});
    },
    async saveProgress(sessionId, progress) {
      const result = await sessions.updateOne({ _id: sessionId }, { $set: progressFields(pickProgress(progress)) });
      return result.matchedCount === 1;
    },
    async appendEvaluation(sessionId, evaluation) {
      const result = await sessions.updateOne({ _id: sessionId }, { $push: { evaluations: structuredClone(evaluation) } });
      return result.matchedCount === 1;
    },
    async remove(sessionId) {
      const result = await sessions.deleteOne({ _id: sessionId });
      return result.deletedCount === 1;
    },
    async close() {
      await client.close();
    },
  };
}

function toDocument(record: SessionRecord): SessionDocument {
  return {
    _id: record.sessionId,
    worldId: record.worldId,
    provider: record.provider,
    createdAt: record.createdAt,
    config: structuredClone(record.config),
    evaluations: structuredClone(record.evaluations),
    ...progressFields(record),
  };
}

function progressFields(progress: SessionProgress) {
  return {
    status: progress.status,
    modelTurns: progress.modelTurns,
    experimentCount: progress.observations.length,
    observations: structuredClone(progress.observations),
    providerDiagnostic: structuredClone(progress.providerDiagnostic),
    updatedAt: progress.updatedAt,
    transcriptJson: JSON.stringify(progress.transcript),
    messagesJson: JSON.stringify(progress.messages),
    submittedTheoryJson: JSON.stringify(progress.submittedTheory),
  };
}

function fromDocument(document: SessionDocument): SessionRecord {
  return {
    sessionId: document._id,
    worldId: document.worldId,
    provider: document.provider,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    config: {
      budget: document.config.budget,
      maxModelTurns: document.config.maxModelTurns,
      timeoutMs: document.config.timeoutMs,
      maxRetries: document.config.maxRetries,
      noiseSeed: document.config.noiseSeed,
    },
    status: document.status,
    modelTurns: document.modelTurns,
    observations: document.observations,
    providerDiagnostic: document.providerDiagnostic,
    evaluations: document.evaluations,
    transcript: JSON.parse(document.transcriptJson) as SessionRecord["transcript"],
    messages: JSON.parse(document.messagesJson) as SessionRecord["messages"],
    submittedTheory: JSON.parse(document.submittedTheoryJson) as SessionRecord["submittedTheory"],
  };
}
