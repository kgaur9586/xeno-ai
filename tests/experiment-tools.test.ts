import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPERIMENT_BUDGET,
  createExperimentTools,
  type ExperimentTools,
} from "../src/tools/experiment-tools.js";
import {
  ERROR_MESSAGES,
  ExperimentErrorSchema,
  ExperimentSuccessSchema,
  ObservationSchema,
  PublicDescriptionSchema,
  type ExperimentResult,
  type ExperimentSuccess,
} from "../src/tools/schemas.js";

const DOCUMENTED_DESCRIPTION = {
  worldId: "glow-world",
  attributes: {
    a: { min: 0, max: 10 },
    b: { min: 0, max: 10 },
    c: { min: 0, max: 10 },
  },
  outcome: { glows: "boolean" },
  experimentBudget: 30,
};

function expectSuccess(result: ExperimentResult): ExperimentSuccess {
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.error.code}`);
  }
  return result;
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function useWholeBudget(tools: ExperimentTools): void {
  for (let i = 0; i < DEFAULT_EXPERIMENT_BUDGET; i++) {
    expectSuccess(tools.runExperiment({ a: 1, b: 9, c: 0 }));
  }
}

describe("[AT-1] Reproducibility through the tools", () => {
  it("produces identical logs for identical request sequences", () => {
    const requests = [
      { a: 8, b: 2, c: 1 },
      { a: 3, b: 4, c: 9 },
      { a: 5, b: 0, c: 5 },
    ];
    const first = createExperimentTools();
    const second = createExperimentTools();
    for (const request of requests) {
      first.runExperiment(request);
      second.runExperiment(request);
    }
    expect(second.getObservationLog()).toEqual(first.getObservationLog());
  });
});

describe("[AT-4] Input validation", () => {
  it("accepts the inclusive range limits 0 and 10", () => {
    const tools = createExperimentTools();
    expect(tools.runExperiment({ a: 0, b: 0, c: 0 }).ok).toBe(true);
    expect(tools.runExperiment({ a: 10, b: 10, c: 10 }).ok).toBe(true);
    expect(tools.runExperiment({ a: 0, b: 10, c: 5 }).ok).toBe(true);
  });

  const invalidRequests: Array<[string, unknown]> = [
    ["a below 0", { a: -0.01, b: 1, c: 1 }],
    ["b above 10", { a: 1, b: 10.01, c: 1 }],
    ["c far out of range", { a: 1, b: 1, c: 1000 }],
    ["missing c", { a: 1, b: 1 }],
    ["empty object", {}],
    ["extra field", { a: 1, b: 1, c: 1, d: 1 }],
    ["string value", { a: "5", b: 1, c: 1 }],
    ["boolean value", { a: true, b: 1, c: 1 }],
    ["null value", { a: null, b: 1, c: 1 }],
    ["undefined value", { a: undefined, b: 1, c: 1 }],
    ["NaN", { a: Number.NaN, b: 1, c: 1 }],
    ["Infinity", { a: 1, b: Number.POSITIVE_INFINITY, c: 1 }],
    ["-Infinity", { a: 1, b: 1, c: Number.NEGATIVE_INFINITY }],
    ["null request", null],
    ["undefined request", undefined],
    ["array request", [1, 2, 3]],
    ["string request", "a=1,b=1,c=1"],
    ["number request", 5],
  ];

  it.each(invalidRequests)("rejects %s", (_label, request) => {
    const tools = createExperimentTools();
    const result = tools.runExperiment(request);
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT },
    });
  });

  it("rejects a request whose property access throws, without leaking the error", () => {
    const tools = createExperimentTools();
    const hostile = {
      get a(): number {
        throw new Error("internal detail");
      },
      b: 1,
      c: 1,
    };
    expect(tools.runExperiment(hostile)).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: ERROR_MESSAGES.INVALID_INPUT },
    });
    expect(tools.getObservationLog()).toEqual([]);
  });
});

describe("[AT-5] Budget", () => {
  it("defaults to 30 experiments", () => {
    const tools = createExperimentTools();
    expect(tools.getRemainingBudget()).toBe(30);
    expect(tools.describeWorld().experimentBudget).toBe(30);
  });

  it("counts remainingBudget down from 29 to 0, then refuses the 31st experiment", () => {
    const tools = createExperimentTools();
    for (let i = 1; i <= 30; i++) {
      const result = expectSuccess(tools.runExperiment({ a: 8, b: 2, c: 1 }));
      expect(result.observation.step).toBe(i);
      expect(result.observation.remainingBudget).toBe(30 - i);
    }
    expect(tools.runExperiment({ a: 8, b: 2, c: 1 })).toEqual({
      ok: false,
      error: { code: "BUDGET_EXHAUSTED", message: ERROR_MESSAGES.BUDGET_EXHAUSTED },
    });
    expect(tools.getRemainingBudget()).toBe(0);
    expect(tools.getObservationLog()).toHaveLength(30);
  });

  it("keeps refusing after exhaustion and does not log refused requests", () => {
    const tools = createExperimentTools();
    useWholeBudget(tools);
    for (let i = 0; i < 3; i++) {
      const result = tools.runExperiment({ a: 8, b: 2, c: 1 });
      expect(result.ok).toBe(false);
    }
    expect(tools.getObservationLog()).toHaveLength(30);
  });

  it("accepts a custom budget", () => {
    const tools = createExperimentTools({ budget: 2 });
    expect(tools.runExperiment({ a: 1, b: 1, c: 1 }).ok).toBe(true);
    expect(tools.runExperiment({ a: 1, b: 1, c: 1 }).ok).toBe(true);
    const third = tools.runExperiment({ a: 1, b: 1, c: 1 });
    expect(third.ok ? null : third.error.code).toBe("BUDGET_EXHAUSTED");
  });

  it.each([0, -1, 2.5, Number.NaN])("rejects an invalid budget configuration (%s)", (budget) => {
    expect(() => createExperimentTools({ budget })).toThrow();
  });
});

describe("[AT-6] Exact response fields", () => {
  it("public description matches the documented object exactly", () => {
    const description = createExperimentTools().describeWorld();
    expect(description).toStrictEqual(DOCUMENTED_DESCRIPTION);
    expect(PublicDescriptionSchema.safeParse(description).success).toBe(true);
  });

  it("success responses contain exactly the documented fields at every level", () => {
    const tools = createExperimentTools();
    const result = expectSuccess(tools.runExperiment({ a: 8, b: 2, c: 1 }));

    expect(ExperimentSuccessSchema.safeParse(result).success).toBe(true);
    expect(sortedKeys(result)).toEqual(["observation", "ok"]);
    expect(sortedKeys(result.observation)).toEqual(["inputs", "outcome", "remainingBudget", "step"]);
    expect(sortedKeys(result.observation.inputs)).toEqual(["a", "b", "c"]);
    expect(sortedKeys(result.observation.outcome)).toEqual(["glows"]);
    expect(result).toStrictEqual({
      ok: true,
      observation: {
        step: 1,
        inputs: { a: 8, b: 2, c: 1 },
        outcome: { glows: true },
        remainingBudget: 29,
      },
    });
  });

  it("log entries contain exactly the observation fields", () => {
    const tools = createExperimentTools();
    tools.runExperiment({ a: 8, b: 2, c: 1 });
    for (const entry of tools.getObservationLog()) {
      expect(ObservationSchema.safeParse(entry).success).toBe(true);
      expect(sortedKeys(entry)).toEqual(["inputs", "outcome", "remainingBudget", "step"]);
    }
  });

  it("the tools object exposes only its four methods", () => {
    const tools = createExperimentTools();
    expect(sortedKeys(tools)).toEqual(
      ["describeWorld", "getObservationLog", "getRemainingBudget", "runExperiment"].sort(),
    );
  });
});

describe("[AT-7] Safe errors", () => {
  function collectErrors(): ExperimentResult[] {
    const tools = createExperimentTools({ budget: 1 });
    const invalid = tools.runExperiment({ a: -1, b: 1, c: 1 });
    tools.runExperiment({ a: 1, b: 1, c: 1 });
    const exhausted = tools.runExperiment({ a: 1, b: 1, c: 1 });
    return [invalid, exhausted];
  }

  it("errors contain exactly ok and error, with exactly code and message", () => {
    for (const result of collectErrors()) {
      expect(ExperimentErrorSchema.safeParse(result).success).toBe(true);
      expect(sortedKeys(result)).toEqual(["error", "ok"]);
      if (result.ok) throw new Error("Expected an error result");
      expect(sortedKeys(result.error)).toEqual(["code", "message"]);
    }
  });

  it("each code carries its one fixed message", () => {
    for (const result of collectErrors()) {
      if (result.ok) throw new Error("Expected an error result");
      expect(result.error.message).toBe(ERROR_MESSAGES[result.error.code]);
    }
  });

  it("the error message does not depend on what was wrong with the input", () => {
    const tools = createExperimentTools();
    const messages = new Set(
      [{ a: -1, b: 1, c: 1 }, { a: 1 }, { a: 1, b: 1, c: 1, secret: 5 }, "junk"].map((request) => {
        const result = tools.runExperiment(request);
        return result.ok ? "unexpected success" : result.error.message;
      }),
    );
    expect([...messages]).toEqual([ERROR_MESSAGES.INVALID_INPUT]);
  });
});

describe("[AT-8] No shared state", () => {
  it("changing a returned observation does not change the log, budget, or later outcomes", () => {
    const tools = createExperimentTools();
    const result = expectSuccess(tools.runExperiment({ a: 8, b: 2, c: 1 }));

    result.observation.inputs.a = 999;
    result.observation.outcome.glows = false;
    result.observation.remainingBudget = 1000;
    result.observation.step = 42;

    expect(tools.getObservationLog()).toStrictEqual([
      { step: 1, inputs: { a: 8, b: 2, c: 1 }, outcome: { glows: true }, remainingBudget: 29 },
    ]);
    expect(tools.getRemainingBudget()).toBe(29);
    const next = expectSuccess(tools.runExperiment({ a: 8, b: 2, c: 1 }));
    expect(next.observation.outcome.glows).toBe(true);
    expect(next.observation.remainingBudget).toBe(28);
  });

  it("changing the public description does not change the budget", () => {
    const tools = createExperimentTools();
    const description = tools.describeWorld();
    description.experimentBudget = 1;
    description.attributes.a.max = 1000;

    expect(tools.describeWorld()).toStrictEqual(DOCUMENTED_DESCRIPTION);
    expect(tools.getRemainingBudget()).toBe(30);
    expect(tools.runExperiment({ a: 10, b: 1, c: 1 }).ok).toBe(true);
  });

  it("changing a copy of the log does not change the stored log", () => {
    const tools = createExperimentTools();
    tools.runExperiment({ a: 8, b: 2, c: 1 });
    const copy = tools.getObservationLog();
    copy.push({ step: 2, inputs: { a: 1, b: 1, c: 1 }, outcome: { glows: true }, remainingBudget: 0 });
    copy[0]!.outcome.glows = false;
    copy[0]!.inputs.b = 7;

    expect(tools.getObservationLog()).toStrictEqual([
      { step: 1, inputs: { a: 8, b: 2, c: 1 }, outcome: { glows: true }, remainingBudget: 29 },
    ]);
    expect(tools.getRemainingBudget()).toBe(29);
  });

  it("changing the request object after submission does not change the log", () => {
    const tools = createExperimentTools();
    const request = { a: 8, b: 2, c: 1 };
    tools.runExperiment(request);
    request.a = 3;

    expect(tools.getObservationLog()[0]!.inputs).toStrictEqual({ a: 8, b: 2, c: 1 });
  });
});

describe("[AT-9] Observation log", () => {
  it("logs accepted experiments in order with correct step numbers", () => {
    const tools = createExperimentTools();
    tools.runExperiment({ a: 8, b: 2, c: 1 });
    tools.runExperiment({ a: 2, b: 2, c: 3 });
    tools.runExperiment({ a: 5, b: 9, c: 10 });

    expect(tools.getObservationLog()).toStrictEqual([
      { step: 1, inputs: { a: 8, b: 2, c: 1 }, outcome: { glows: true }, remainingBudget: 29 },
      { step: 2, inputs: { a: 2, b: 2, c: 3 }, outcome: { glows: false }, remainingBudget: 28 },
      { step: 3, inputs: { a: 5, b: 9, c: 10 }, outcome: { glows: false }, remainingBudget: 27 },
    ]);
  });

  it("does not log rejected requests or charge budget for them", () => {
    const tools = createExperimentTools();
    tools.runExperiment({ a: 8, b: 2, c: 1 });
    tools.runExperiment({ a: -1, b: 2, c: 1 });
    tools.runExperiment({ a: 8, b: 2 });
    tools.runExperiment({ a: 8, b: 2, c: 1, d: 0 });
    const result = expectSuccess(tools.runExperiment({ a: 2, b: 8, c: 1 }));

    expect(result.observation.step).toBe(2);
    expect(result.observation.remainingBudget).toBe(28);
    expect(tools.getRemainingBudget()).toBe(28);
    expect(tools.getObservationLog().map((entry) => entry.step)).toEqual([1, 2]);
  });

  it("starts empty", () => {
    expect(createExperimentTools().getObservationLog()).toEqual([]);
  });
});
