/**
 * Phase 4 in-memory theory storage.
 *
 * Persistence is deliberately deferred: this registry owns plain defensive
 * copies and has no database or agent-tool dependency.
 */
import type { Theory, ValidatedTheory } from "../language/theory.js";
import { isValidatedTheory } from "../language/theory.js";
import type { TheoryEvaluationReport } from "./evaluator.js";

export interface TheoryRecord {
  id: number;
  theory: Theory;
  evaluation: TheoryEvaluationReport;
}

export interface TheoryRegistry {
  register(theory: ValidatedTheory, evaluation: TheoryEvaluationReport): TheoryRecord;
  get(id: number): TheoryRecord | undefined;
  list(): TheoryRecord[];
}

export function createTheoryRegistry(): TheoryRegistry {
  const records: TheoryRecord[] = [];

  return {
    register(theory, evaluation) {
      if (!isValidatedTheory(theory)) {
        throw new Error("Theory must be validated before registration.");
      }
      const record: TheoryRecord = {
        id: records.length + 1,
        theory: copyTheory(theory),
        evaluation: copyEvaluation(evaluation),
      };
      records.push(record);
      return copyRecord(record);
    },

    get(id) {
      const record = records.find((candidate) => candidate.id === id);
      return record === undefined ? undefined : copyRecord(record);
    },

    list() {
      return records.map(copyRecord);
    },
  };
}

function copyRecord(record: TheoryRecord): TheoryRecord {
  return {
    id: record.id,
    theory: copyTheory(record.theory),
    evaluation: copyEvaluation(record.evaluation),
  };
}

function copyTheory(theory: Theory): Theory {
  return {
    measurement: structuredClone(theory.measurement),
    operator: theory.operator,
    threshold: theory.threshold,
  };
}

function copyEvaluation(evaluation: TheoryEvaluationReport): TheoryEvaluationReport {
  return {
    inRange: {
      ...evaluation.inRange,
      evaluationErrors: { ...evaluation.inRange.evaluationErrors },
    },
    outOfRange: {
      ...evaluation.outOfRange,
      evaluationErrors: { ...evaluation.outOfRange.evaluationErrors },
    },
    complexity: { ...evaluation.complexity },
  };
}
