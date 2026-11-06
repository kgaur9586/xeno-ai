# XENO — Architecture

This document explains each component of XENO, what it is allowed to know,
and how the components talk to each other. The most important idea is
**information hiding**: the component that knows the hidden rule must never
hand it to the component that is trying to discover it.

---

## 1. The big picture

```
                 ┌────────────────────────────────────────────┐
                 │                 EVALUATOR                  │
                 │  knows the hidden rule; generates unseen   │
                 │  test cases; scores theories               │
                 └───────────────▲────────────────────────────┘
                                 │ ground truth (private)
                                 │
┌──────────────┐  safe calls  ┌──┴───────────────┐   private   ┌────────────────┐
│    AGENT     │ ───────────▶ │ EXPERIMENT TOOLS │ ──────────▶ │  WORLD ENGINE  │
│ (scripted,   │ ◀─────────── │ validate input,  │ ◀────────── │ holds hidden   │
│  later LLM)  │  observations│ enforce budget,  │  raw result │ rule, computes │
└──────┬───────┘   only       │ strip secrets    │             │ outcomes       │
       │                      └──────┬───────────┘             └────────────────┘
       │ measurements & theories     │ records
       │ (restricted language)       ▼
       │                      ┌──────────────────┐
       └────────────────────▶ │ OBSERVATION LOG  │
                              │ (lab notebook)   │
                              └──────────────────┘
```

The experiment tools are the trust boundary: everything on the **left**
(the agent) is untrusted. Everything on the **right** (world engine,
evaluator) is trusted and private.

---

## 2. Components

### 2.1 World engine (`src/worlds/`)

**What it is:** A simulation of a small universe with a secret rule. For
example: "an object glows when attributes `a` and `b` are on opposite sides
of a hidden threshold" (see section 5).

**What it knows:** Everything, including the hidden rule and its private
configuration (such as the threshold value).

**What it does:**
- Given experiment inputs, computes the outcome using the hidden rule.
- In Phase 1 the rule is **fixed** and the world has no randomness: the
  outcome is a pure function of the inputs, so the same inputs always give
  the same outcome. The rule does not depend on any seed.

**Who may call it:** Only the experiment tools and the evaluator. The agent
never receives a reference to the world engine, and the private rule
configuration never appears in any public output.

### 2.2 Experiment tools (`src/tools/`)

**What it is:** The only door between the agent and the world. Think of it as
a lab technician: you hand them a request form, they run the experiment, and
they hand back only the measurement readout.

**What it does:**
- **Validates inputs** with Zod (a library that checks data has the right
  shape and ranges). Bad input is rejected with a safe error: a fixed error
  code and a fixed message, never a stack trace or internal values.
- **Enforces a budget** (maximum number of experiments), because a real
  scientist has limited resources and unlimited trials would make discovery
  trivial.
- **Returns only allowed fields:** builds a fresh output object with an
  exact, fixed set of fields. It never forwards the world's internal objects.
- **Records** every accepted experiment in the observation log.

**Why separate from the world:** If the agent talked to the world directly, a
single careless field (for example `world.threshold`) could leak the answer.
A narrow, explicit output format makes leaks easy to test for: we check that
responses contain exactly the allowed fields, rather than searching the
output for "secret-looking" numbers. (Searching for a number like `5` would
not work, because `5` is also a perfectly legal input value.)

### 2.3 Observation log (`src/tools/` in Phase 1, its own module later)

**What it is:** A lab notebook. An ordered list of every experiment: inputs,
observed outcome, and step number.

**Why it is needed:** The agent reasons from it, the dashboard displays it,
and later MongoDB stores it. It is also how we audit what the agent actually
saw.

### 2.4 Expression and theory language (`src/language/`, Phases 3 and 4)

**What it is:** A tiny, restricted math language used for two things:
- **Measurements:** new quantities built from raw attributes, e.g.
  `m = (a - 5) * (b - 5)`.
- **Theories:** prediction rules, e.g. "glows when `m < 0`".

**Why not just run JavaScript?** An LLM could write code that reads files,
calls the network, or simply reads the hidden rule from memory. Instead,
expressions are JSON trees like this one for `(a - 5) * (b - 5)`:

```json
{
  "op": "mul",
  "left":  { "op": "sub", "left": { "var": "a" }, "right": { "const": 5 } },
  "right": { "op": "sub", "left": { "var": "b" }, "right": { "const": 5 } }
}
```

Zod checks the tree, and our own interpreter walks it. Only whitelisted
operations exist, so nothing dangerous can be expressed.

**Node shapes (Phase 3, implemented):**

| Node            | JSON form                                       | Meaning                    |
| --------------- | ----------------------------------------------- | -------------------------- |
| Constant        | `{ "const": 5 }`                                | a finite number            |
| Variable        | `{ "var": "a" }`                                | `a`, `b`, or `c` only      |
| Operation       | `{ "op": "sub", "left": ..., "right": ... }`    | `add`, `sub`, `mul`, `div` |
| Function call   | `{ "fn": "sqrt", "args": [ ... ] }`             | `abs`, `sqrt`, `log` take exactly 1 argument; `min`, `max` take 2 to 4 |

`log` is the natural logarithm. Every node must have exactly the fields of
one shape; anything else is rejected.

**Limits (conservative; the target measurement uses 7 nodes and depth 3):**

| Limit                       | Value | Why                                           |
| --------------------------- | ----- | --------------------------------------------- |
| Maximum depth               | 12    | keeps recursion in the interpreter tiny       |
| Maximum total nodes         | 64    | keeps validation and evaluation cheap         |
| Maximum function arguments  | 4     | bounds `min` / `max`                          |
| Maximum JSON text length    | 4096 characters | rejects huge text before parsing    |

**Safety pipeline (`src/language/`):**
1. `parseExpressionJson` (text only): length check, then `JSON.parse`.
2. `preflight.ts`: a loop with an explicit work list, not recursion, so a
   100,000-level input cannot overflow the call stack. It stops at the first
   exceeded limit, rejects unknown field names and unknown operator,
   function, or variable names, rejects cycles and reused nodes, and builds a
   fresh plain copy of the input, reading each property once.
3. `ExpressionSchema` (Zod, strict): checks the exact shape of the copy.
4. `interpreter.ts`: one explicit case per operator and function. Rejects
   division by zero, `sqrt` of a negative number, `log` of zero or a
   negative number, and any non-finite intermediate result.

Every failure is a fixed code with a fixed message (`errors.ts`), for
example `{ "code": "DIVISION_BY_ZERO", "message": "Division by zero." }`.
Messages never repeat the input. The language imports only Zod and its own
files; it never touches the world engine, the evaluator, the file system,
or the network.

**Theory format (Phase 4):** A theory is a strict object with exactly three
fields: `measurement` (a validated expression), `operator` (`lt`, `lte`,
`gt`, or `gte`), and a finite numeric `threshold`. For example, a theory can
state that its measurement predicts `true` when it is less than zero. Theory
validation calls the existing bounded expression validator, and evaluation
calls the existing safe interpreter; there is no second expression engine.

Theory complexity is reported as the measurement AST's node count and depth.
It remains separate from in-range and out-of-range accuracy. XENO does not
combine them into an arbitrary weighted score.

### 2.5 Agent (`src/agents/`, Phase 2 scripted, Phase 5 LLM)

**What it is:** The discoverer. It decides which experiments to run, which
measurements to create, and which theories to propose.

**What it knows:** Only the public world description (attribute names and
allowed ranges), its budget, and the observations returned by the tools.
Every experimenter implements the same interface: it receives
`{ description, tools }` and nothing else.

**Phases:**
- Phase 2: simple hand-coded strategies (baselines).
- Phase 5: one provider behind `LlmProvider`, calling the same experiment
  tools plus measurement and theory tools. The default provider is a scripted
  dummy. Gemini is used only when a run opts in with `--live`. See section 8.

### 2.6 Evaluator (`src/evaluator/`)

**What it is:** The examiner. It has access to the hidden rule so it can
generate correct answers for cases the agent has never seen.

**What it does:**
- Generates **held-out test cases** (unseen by the agent) with a **seeded
  random number generator**. A *seed* is a starting number; the same seed
  always produces the same sequence of "random" numbers, so the same seed
  always reproduces the same test cases. The evaluation seed is never given
  to the agent.
- In Phase 1, all test cases lie **within the permitted input ranges**.
- From Phase 4 (once the theory language exists), it also generates
  **out-of-range** cases to check extrapolation, not just memorization.
- Scores a theory: in-range and out-of-range accuracy plus deterministic
  complexity; transfer is added later.

**Phase 4 dataset construction:**
- The in-range set draws `a`, `b`, and `c` from `[0, 10]`. Labels come from
  the world engine. Draws are accepted until each outcome class contains
  exactly half of the requested even case count.
- The out-of-range set always draws `a` outside the public range: either
  below `0` or above `10`. It draws `b` from an extended interval one public
  range-width beyond each side and keeps distractor `c` in `[0, 10]`.
  Labels again come only from the world engine, and class-limited acceptance
  produces exactly equal positive and negative counts.
- The two sets use independent seeds. The evaluator returns only aggregate
  counts, accuracy, fixed evaluation-error categories, and complexity. It
  does not return seeds, cases, labels, or the hidden rule.

**Why separate from the tools:** The evaluator's test cases must never pass
through the agent-facing tools; otherwise the agent could "study the exam".
The evaluator calls the world engine directly, so evaluating does not use up
the agent's budget or appear in its observation log.

### 2.7 Later components

| Component       | Phase | Role                                           |
| --------------- | ----- | ---------------------------------------------- |
| Backend API     | 8     | HTTP access to sessions, logs, scores          |
| React dashboard | 9     | Visual view of experiments and theories        |
| MongoDB storage | 10    | Durable storage behind a storage interface     |

---

## 3. How a discovery session flows

1. A session is created with a world, a seed, and an experiment budget.
2. The agent receives the **public description**: attribute names, ranges,
   outcome type. No rule.
3. Loop until the budget runs out:
   1. Agent asks the tools to run an experiment with chosen inputs.
   2. Tools validate the request and check the budget.
   3. Tools ask the world engine for the outcome.
   4. Tools build a clean public observation, log it, and return it.
4. Agent proposes measurements and a theory (restricted language).
5. Evaluator scores the theory on held-out cases (within the permitted
   ranges in Phase 1; out-of-range cases are added in Phase 4).
6. (Phase 7) The theory is tested in an altered world to measure transfer.

---

## 4. Leak prevention checklist

The hidden rule could leak through any of these channels. Each one is
guarded by a structural check, not by searching output text for particular
numbers.

- Tool return values: validated against strict output schemas with an exact
  set of allowed fields.
- Error messages: a fixed error code plus a fixed message per code; never a
  stack trace, internal value, or dump of an object.
- The public world description: must equal the documented description
  exactly, with no private rule configuration.
- Logs or transcripts visible to the agent: contain only public
  observations.
- Evaluation seed and test cases: never passed through the agent-facing
  tools.
- Object references: the agent gets plain data copies, never live objects,
  so changing returned data cannot change internal state.
- Design documents and source code (including this file) are never placed in
  the agent's context.

---

## 5. First world: "Glow World"

### 5.1 The world

Each experiment creates one object with three attributes the agent chooses:

| Attribute | Allowed range | Meaning to the agent |
| --------- | ------------- | -------------------- |
| `a`       | 0 to 10       | unknown property     |
| `b`       | 0 to 10       | unknown property     |
| `c`       | 0 to 10       | unknown property     |

Both ends of each range are allowed (0 and 10 are valid inputs). The outcome
is one boolean: `glows`.

**Hidden rule (private):** the object glows exactly when `a` and `b` are on
**opposite sides of 5**. If either `a` or `b` equals exactly 5, the object
does not glow. Equivalently:

```
glows = ((a - 5) * (b - 5)) < 0
```

`a` and `b` are the relevant attributes. `c` is a **distractor**: it has no
effect. The formula and the threshold value 5 are private world
configuration and are never given to the agent.

**Useful derived measurement (the target discovery):**

```
m = (a - 5) * (b - 5)
```

The eventual theory, expressed in the restricted language (Phases 3 and 4),
is "glows when `m < 0`".

**Why this design:**
- **No single attribute predicts the outcome.** With `a` and `b` drawn
  uniformly from 0 to 10, knowing only `a` (or only `b`) leaves a 50% chance
  either way, because the other attribute is equally likely to be on either
  side of 5. The agent must combine `a` and `b` into a new measurement,
  which directly exercises project goal 3.
- **The natural glow rate is about 50%**, so the lazy theories "always
  glows" and "never glows" are no better than a coin flip.
- Neutral names (`a`, `b`, `c` instead of "mass", "volume") stop an LLM from
  guessing via memorized physics rather than experimenting.
- The distractor tests whether theories include irrelevant factors.
- It is deterministic (no noise) so tests are exact. Noise comes in Phase 6.
- Transfer variants are easy later (Phase 7): move the threshold from 5 to
  another value, rescale `a`, rename attributes, or use different thresholds
  for `a` and `b`.

**Why the first design was replaced:** the earlier rule `glows = (a / b) > 2.5`
on ranges 0.1 to 10 only glows when `b` is below 4, and glows only about 19%
of the time. So `b` alone was highly predictive ("small `b` might glow, large
`b` never glows"), and "never glows" scored about 81%. That contradicted the
claim that individual attributes do not predict the outcome well.

### 5.2 Public description (what the agent sees)

```json
{
  "worldId": "glow-world",
  "attributes": {
    "a": { "min": 0, "max": 10 },
    "b": { "min": 0, "max": 10 },
    "c": { "min": 0, "max": 10 }
  },
  "outcome": { "glows": "boolean" },
  "experimentBudget": 30
}
```

This object must match exactly. It contains no rule, no formula, and no
threshold.

### 5.3 Experiment tool contract

Input (validated by a strict Zod schema: all three fields required, finite
numbers only, within range, extra fields rejected):

```json
{ "a": 8, "b": 2, "c": 1 }
```

Success output (exactly these fields, at every level):

```json
{
  "ok": true,
  "observation": {
    "step": 1,
    "inputs": { "a": 8, "b": 2, "c": 1 },
    "outcome": { "glows": true },
    "remainingBudget": 29
  }
}
```

Error output (exactly these fields; `code` is one of a fixed set, and each
code has one fixed `message`):

```json
{ "ok": false, "error": { "code": "INVALID_INPUT", "message": "Experiment inputs are invalid." } }
```

```json
{ "ok": false, "error": { "code": "BUDGET_EXHAUSTED", "message": "No experiments remain in the budget." } }
```

Rejected requests do not use up budget and are not added to the
observation log.

### 5.4 Evaluator contract (Phase 1 version)

The evaluator takes a **seed** and a **case count**, generates held-out
cases, and returns a predictor's accuracy on them.

- **Within range only:** every generated `a`, `b`, `c` lies in 0 to 10.
  Out-of-range evaluation is deferred to Phase 4.
- **Reproducible:** the same seed and count always produce the identical
  list of cases (same inputs, same order, same correct answers).
- **Balanced:** exactly half the cases glow and half do not. The natural
  rate is already about 50%, but forcing an exact split makes constant
  predictors ("always glows", "never glows") score exactly 50%, which keeps
  the tests precise.
- **Labels come from the world engine**, called directly, never through the
  experiment tools.

In Phase 1, predictors are small TypeScript functions written by us inside
tests (trusted code). In Phase 4 they are replaced by theories written in the
restricted language, so LLM output is never executed as code.

### 5.5 Acceptance tests for Phase 1

| #  | Test                     | What it proves                                                                                     |
| -- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| 1  | Reproducibility          | The same seed and count produce an identical evaluation case list. The world gives the same outcome for the same inputs every time. (The rule is fixed; seeds only control which cases are generated.) |
| 2  | Rule correctness         | `(a=8, b=2)` and `(a=2, b=8)` glow; `(8, 8)` and `(2, 2)` do not; `(0, 10)` glows; changing `c` (0, 5, 10) never changes the outcome. |
| 3  | Boundary                 | `(5, 2)`, `(2, 5)`, `(5, 8)`, and `(5, 5)` do **not** glow: exactly 5 counts as neither side.       |
| 4  | Input validation         | Accepts 0 and 10. Rejects values below 0 or above 10, missing fields, extra fields, strings, `null`, `NaN`, and `Infinity`. |
| 5  | Budget                   | `remainingBudget` counts down from 29 to 0; the 31st experiment returns `BUDGET_EXHAUSTED`.        |
| 6  | Exact response fields    | Success responses, observations, inputs, outcomes, and the public description each contain exactly the documented fields (checked with strict schemas and exact key comparison). None contains private rule configuration. |
| 7  | Safe errors              | Error responses contain exactly `ok` and `error`, which contains exactly `code` and `message`; the code is from the fixed set, and the message is that code's fixed text. |
| 8  | No shared state          | Changing a returned observation, the public description, or a copy of the log does not change the stored log, the remaining budget, or later outcomes. |
| 9  | Observation log          | Every accepted experiment is logged in order with correct step numbers; rejected requests are not logged and do not use budget. |
| 10 | Evaluation separation    | Running the evaluator does not change the observation log or the budget. All evaluation inputs lie within 0 to 10. |
| 11 | Evaluator discriminates  | On a balanced set: the correct predictor (`(a - 5) * (b - 5) < 0`) scores 100%; "always glows" and "never glows" score exactly 50%; single-attribute predictors "`a > 5`", "`b > 5`", and "`c > 5`" score near 50%; the partial predictor "`a > 5` and `b < 5`" scores near 75%. |

Phase 1 is complete only when all eleven tests pass with `npm test`.

---

## 6. Directory structure

All code lives in one package at the project root. Phases 1 to 4 create
only these files:

```
xeno-ai/
  docs/
    PROJECT_PLAN.md
    ARCHITECTURE.md
  src/
    worlds/
      glow-world.ts         world engine: the ONLY place the hidden rule lives
    tools/
      schemas.ts            strict Zod schemas for tool inputs and outputs
      experiment-tools.ts   agent-facing door: validate, budget, log, copy out
    evaluator/
      evaluator.ts          generates private datasets and scores theories
      theory-registry.ts    defensive in-memory theory and metrics registry
    shared/
      random.ts             seeded random number generator (Phase 2 move)
    agents/                 (Phase 2)
      experimenter.ts       common experimenter interface
      random-explorer.ts    seeded random baseline
      systematic-explorer.ts  min/mid/max factorial grid baseline
      baseline-runner.ts    runs an experimenter, reports exploration metrics
      baseline-comparison.ts  fixed-budget, fixed-seed comparison table
    cli/
      baselines.ts          entry point for `npm run baselines`
    language/               (Phases 3 and 4)
      errors.ts             fixed error codes and messages
      expression.ts         node types, allowed names, limits, Zod schema
      preflight.ts          bounded non-recursive safety pass and copy
      theory.ts             strict theory validation and AST complexity
      validate.ts           validateExpression, parseExpressionJson
      interpreter.ts        evaluateExpression: the safe calculator
  tests/
    helpers/
      expression-builders.ts  small helpers for writing expression trees
    language-validation.test.ts
    language-interpreter.test.ts
    language-fuzz.test.ts
    glow-world.test.ts
    experiment-tools.test.ts
    evaluator.test.ts
    random-explorer.test.ts
    systematic-explorer.test.ts
    baseline-runner.test.ts
    experimenter-isolation.test.ts
    baseline-comparison.test.ts
    theory-validation.test.ts
    theory-evaluator.test.ts
    theory-registry.test.ts
  package.json              project info and the `npm test` command
  tsconfig.json             TypeScript settings (type check of src + tests)
  tsconfig.build.json       production build settings (src only)
```

The seeded random number generator moved from `src/evaluator/` to
`src/shared/` in Phase 2, when the random baseline became its second user.
Its code did not change.

Experimenter files may import only types from `src/tools/` and the shared
random number generator. They never import `src/worlds/` or
`src/evaluator/`; a test reads their source to enforce this.

Dependencies: `zod` (runtime) plus `typescript` and `vitest` (development
only). Phase 2 adds `@types/node` (development only, type definitions with
no runtime code) so tests can read source files for the import check.

Phase 5 adds the files in section 8. Phase 6 adds `src/worlds/world.ts`,
`ring-world.ts`, `drift-world.ts`, `registry.ts`, `src/tools/world-schemas.ts`,
`world-tools.ts`, `src/language/numeric-theory.ts`, and
`src/evaluator/world-evaluator.ts` (section 9). Running the agent on every
world adds `src/tools/public-types.ts`, `src/agents/discovery-world.ts`, and
`src/agents/world-comparison.ts` (section 9.6). Phase 7 adds
`src/worlds/variants.ts`, `src/transfer/refit.ts`, `transfer.ts`,
`scenarios.ts`, and `src/cli/transfer.ts` (section 10). Phase 8 adds
`src/api/schemas.ts`, `session-manager.ts`, `app.ts`, and `src/cli/serve.ts`
(section 11). Phase 9 adds the React dashboard in `web/`, built into
`dist-web/`, plus `vitest.config.ts` (section 12). Phase 10 adds
`src/storage/session-store.ts` and `mongo-session-store.ts`, plus
`tests/storage-contract.ts`, `storage-memory.test.ts`, and
`storage-mongo.test.ts` (section 13).

Phase 10 adds the `mongodb` package so the server can keep sessions in
MongoDB. Tests add `mongodb-memory-server` (development only), which
downloads and runs a real `mongod` so the storage suite does not need a
database installed on the machine. Set `XENO_TEST_MONGO_URI` to point that
suite at an existing server instead.

---

## 7. Benchmark limitations

`npm run baselines` builds the project and prints a comparison of the two
scripted experimenters. Both use a budget of **27** experiments (the size of
the systematic grid), and the random explorer uses the fixed seed **42**, so
the output is identical on every run.

Keep these limitations in mind when reading any baseline comparison:

- **The grid uses minimum, midpoint, and maximum.** For each attribute, the
  systematic explorer tries only the public minimum, the midpoint, and the
  public maximum (0, 5, and 10 in Glow World).
- **In Glow World the midpoint coincides with the hidden threshold.** The
  midpoint of the public range 0 to 10 is 5, which is also the private
  threshold. The explorer does not know this; it is a coincidence of the
  world's design. But it means every grid experiment with `a = 5` or
  `b = 5` lands exactly on the boundary and can never glow, so only 6 of the
  27 grid experiments glow.
- **This distorts comparisons.** The coincidence could make the grid look
  better (it probes the boundary exactly) or worse (few glowing examples, and
  no values between the levels) than it would in a world whose threshold is
  elsewhere. Results from Glow World should not be generalized to other
  worlds without re-running the comparison there.
- **Compare strategies at equal budgets.** A strategy given more experiments
  will naturally show more coverage. All future comparisons must give every
  strategy the same experiment budget.
- **Outcome counts and coverage are not discovery.** More glowing outcomes
  or wider coverage does not mean a strategy found the rule. Discovery
  ability is measured only by scoring the theories each strategy leads to
  with the evaluator on held-out cases (Phase 4 onward).

The command's output does not print the threshold itself; it points to this
section instead.

---

## 8. Phase 5 discovery agent

The discovery agent is one provider calling three tools: `run_experiment`,
`evaluate_measurement`, and `submit_theory`. Measurements and theories are
JSON in the restricted language. The agent loop validates every tool call,
keeps a transcript, and stops on a valid theory, the model-turn limit, or a
provider failure. `src/agents/discovery-session.ts` scores a submitted theory
only after that loop returns. Scores, seeds, and held-out cases are not
written back into the transcript.

| File | Role |
| ---- | ---- |
| `src/llm/provider.ts` | `LlmProvider` interface, fixed provider errors |
| `src/llm/gemini-provider.ts` | Gemini adapter, used only for an opted-in live run |
| `src/llm/dummy-provider.ts` | Scripted provider. No network call |
| `src/llm/env.ts` | Reads `GEMINI_API_KEY` and `GEMINI_MODEL` from the environment or `.env` |
| `src/agents/discovery-prompt.ts` | Prompt built from the public description and tool declarations |
| `src/agents/discovery-tool-declarations.ts` | The three tool schemas shown to a provider |
| `src/agents/discovery-tools.ts` | Validates and runs those tools |
| `src/agents/discovery-agent.ts` | The bounded loop |
| `src/agents/discovery-session.ts` | Loop, then evaluator |
| `src/agents/observation-theorist.ts` | Catalog theory fitted to observations and public ranges |
| `src/agents/discovery-comparison.ts` | Equal-budget scores for the agent and both baselines |
| `src/agents/discovery-run-log.ts` | Writes an operator copy of a finished run |
| `src/cli/discover.ts` | `npm run discover` |
| `src/cli/compare.ts` | `npm run compare` |

`npm run discover` uses the dummy provider unless the command includes
`--live` and both Gemini variables are set. `npm run compare` always uses the
dummy provider, at the same budget and seed as `npm run baselines` (27 and
42). Both commands write a JSON copy under `runs/`. That directory is
gitignored. The saved file is for the operator. It is not sent to a provider.
A known API key blocks the save if it would be written into the file.

The dummy provider and the baseline theories share one catalog. Its only
numeric constants are zero and each public range midpoint. The dummy's
experiments are the same public min/mid/max grid as the systematic explorer.
Because that midpoint coincides with Glow World's private threshold (section
7), a perfect held-out score on this world is not evidence that a live model
discovered the rule. The comparison text says this, and it says when the
provider was not a live model. A short all-dark sample can fit perfectly
in-sample and still score at chance on held-out cases. Those two numbers are
printed separately.

The dummy provider, the catalog, and the prompt builder do not import the
world engine or the evaluator. Tests check the prompt, tool results, and
transcript of a dummy session for private rule data. Searching that text for
the number 5 is not one of those checks: 5 is a legal input and the public
midpoint.

Phase 5 adds `@google/genai` so the live adapter can call Gemini. Tests never
construct a live request. The dummy provider does not import that package.

---

## 9. Phase 6 richer worlds

Phase 6 adds a generic world contract and two new worlds. Glow World keeps its
original API, so Phases 1 to 5 are unchanged. It is also wrapped as
`GLOW_WORLD` so the generic tools and evaluator cover it too.

### 9.1 World contract (`src/worlds/world.ts`)

A world is a trusted, frozen object with:

- `spec` (public): world id, ordered attribute names and ranges, outcome name,
  outcome kind (`boolean` or `number`), and whether observations are noisy.
- `trueOutcome(inputs)`: the noiseless rule.
- `observe(inputs, random)`: one noisy observation. A boolean world uses one
  random value per observation; a numeric world uses two (one Gaussian draw).
  A noiseless world uses none.
- Private noise level: `flipRate` (boolean) or `noiseStandardDeviation`
  (numeric).
- Private `extrapolation` profile: which attributes the evaluator pushes
  outside their range, which it extends, and which stay in range.

Only the generic tools and the evaluator receive world objects. A test checks
that no file in `src/agents/` or `src/llm/` imports a world module.

### 9.2 The worlds

| World | Attributes (0 to 10) | Outcome | Hidden rule (private) | Noise (private) |
| ----- | -------------------- | ------- | --------------------- | --------------- |
| `glow-world` | `a`, `b`, `c` | `glows` boolean | `(a - 5) * (b - 5) < 0` | none |
| `ring-world` | `p`, `q`, `r`, `s` | `lit` boolean | `(p - 10)^2 + (q - 5)^2 < 25` | each observation flips with probability 0.05 |
| `drift-world` | `u`, `v`, `w`, `x`, `y` | `level` number | `2u - 3v + 10` | additive Gaussian, standard deviation 0.5 |

`c`, `r`, `s`, `w`, `x`, and `y` are distractors. Ring World's circle extends
past `p = 10`, so out-of-range cases still contain both classes. Drift World's
rule is linear, so a correct theory keeps working out of range.

### 9.3 Generic experiment tools (`src/tools/world-tools.ts`)

`createWorldTools(world, { budget, noiseSeed })` follows the same contract
as the Glow World tools: strict Zod input built from the public ranges, a
budget, an ordered log, fresh copies with exactly the documented fields, and
the same fixed `INVALID_INPUT` and `BUDGET_EXHAUSTED` errors. The public
description is:

```json
{
  "worldId": "ring-world",
  "attributes": { "p": { "min": 0, "max": 10 }, "q": { "min": 0, "max": 10 }, "r": { "min": 0, "max": 10 }, "s": { "min": 0, "max": 10 } },
  "outcome": { "lit": "boolean" },
  "observationNoise": "present",
  "experimentBudget": 30
}
```

`observationNoise` says only whether noise exists, not how much. Noise comes
from a private seeded stream. A rejected request uses no budget and draws no
noise, so the same seed and the same accepted requests reproduce the same
observations. Repeating one input in a noisy world gives different readings.

### 9.4 Language and numeric theories

The expression language now takes a variable set. `createVariableSet(names)`
accepts 1 to 16 unique short lowercase names. Every validator and the
interpreter default to Glow World's `a`, `b`, `c`, so existing callers are
unchanged. A theory naming another world's attributes is rejected.

A numeric theory is a strict object with one field, `measurement`. Its value
is the prediction. It uses the same validator and interpreter as boolean
theories.

### 9.5 Noise-aware evaluator (`src/evaluator/world-evaluator.ts`)

Held-out cases come from a private seed and the world engine directly. Their
labels carry the same noise an observation would, so on a noisy world even
the true theory cannot score 100%.

- **Boolean worlds:** the noiseless classes are exactly balanced, then label
  noise is applied. The report gives a noise ceiling of `1 - flipRate`. A
  dataset passes when accuracy is at least
  `1 - flipRate - 3 * sqrt(e * (1 - e) / n)`, where `e` is the flip rate with
  a floor of 0.005 and `n` is the case count. Ring World at 200 cases needs
  about 0.904. Glow World needs about 0.985.
- **Numeric worlds:** the report gives mean absolute error, root mean squared
  error, and the share of predictions within three noise standard deviations
  (1.5 for Drift World). A dataset passes when that share is at least
  `0.9973 - 3 * sqrt(0.9973 * 0.0027 / n)`, about 0.986 at 200 cases.
- **Out-of-range cases:** profiled `outside` attributes are drawn at least
  one-tenth of a range-width beyond the range, up to one range-width plus that
  gap. Profiled `extended` attributes are drawn from one range-width beyond
  each side. All others stay in range.

Reports contain aggregate metrics, pass thresholds, the noise level, and
complexity. They contain no cases, labels, or seeds. Measured at 200 cases,
the true Ring World theory scores about 0.955 in range and passes. A
single-attribute theory on `p` scores about 0.895 and fails. Distractor and
constant theories score near 0.5. Drift World's true theory has an RMSE close
to 0.5 and passes. A coefficient off by 0.1 fails, and a range-clamped copy of
the true rule passes in range and fails out of range.

### 9.6 The agent and baselines on every world

The discovery agent, its prompt, its tool declarations, the dummy provider,
the observation catalog, and both Phase 2 explorers now work on any world.
They depend only on the type-only shapes in `src/tools/public-types.ts`, which
both the Glow World tools and the generic tools satisfy. No agent file imports
a world.

- **Prompt and tools.** The prompt says whether the outcome is boolean or
  numeric. On a noisy world it adds one sentence: "Observations are
  imprecise: repeating an experiment can give a different result." It never
  states how much noise there is. On a numeric world `submit_theory` takes
  only `measurement`. Glow World's prompt and declarations are unchanged.
- **Session.** `runDiscoverySession` takes `worldId` (default `glow-world`)
  and a private `noiseSeed`. Glow World without a noise seed still uses the
  original tools. Every world gets a noise-aware `worldEvaluation`. The
  Phase 4 `evaluation` and `theoryId` stay Glow-only.
- **Dummy provider.** It runs the min/mid/max grid when that has at most 27
  points, and otherwise a fixed-seed random design (seed 7, different from
  the random explorer's 42). It then submits the boolean catalog theory or,
  for a numeric outcome, the lowest-error candidate among the mean, one
  least-squares line per attribute, and a full least-squares fit.
- **Comparison.** `runWorldComparison` runs the dummy agent and both
  baselines on fresh tools for the same world, budget, and noise seed. It then
  scores every theory with the noise-aware evaluator.

`npm run compare -- --world <id> [--noise-seed <n>]` and
`npm run discover -- --world <id> [--noise-seed <n>]` select the world.
Without `--world`, both commands behave as in Phase 5.

At budget 27 with the default seeds:

- **Glow World:** everything scores perfectly, because of the midpoint
  coincidence in section 7.
- **Ring World:** every strategy fails, because the catalog has no circle.
  The dummy's best fit is a constant.
- **Drift World:** both random designs recover roughly `2u - 3v + 10` by
  least squares. The dummy's fit passes in range and out of range. The
  random explorer's fit passes in range but fails out of range, because its
  small spurious weights on the distractors grow there. Which one passes
  depends on the design seed.
- **Systematic explorer:** it is poor on four- and five-attribute worlds,
  because 27 grid points vary only the last attributes.

---

## 10. Phase 7 transfer to altered worlds

Phase 7 asks whether a theory found in one world still works after the world
changes, and if not, how many new experiments it takes to adapt it.

### 10.1 Variant worlds (`src/worlds/variants.ts`)

`createVariantWorld(base, steps, variantId)` wraps a base world. The steps
apply in order, and each one uses the variant's current attribute names:

| Step | Effect |
| ---- | ------ |
| `shift` | The rule reacts to `attribute - offset`, so every boundary on it moves by `offset`. The public range does not change. |
| `rescale` | The attribute is reported as `value * factor`. The public range scales with it. |
| `rename` | The attribute gets a new public name, including in the extrapolation profile. |
| `add-distractors` | New attributes that the outcome ignores. |
| `change-rule` | The outcome follows a new rule, written as a theory in the restricted language, with the base world's noise level. |

A variant is an ordinary world, so the generic tools and the evaluator work on
it unchanged. Its id is supplied by the caller and must be opaque (the
built-in cases use `transfer-target-1` and so on), because an agent shown the
variant would see it. A test checks that no variant's public description
names its transformation.

### 10.2 Adapting a theory (`src/transfer/refit.ts`)

Adapting keeps the theory's form. `refitTheory` may:

1. Map the theory's variables onto the target's attribute names. All
   one-to-one mappings are ranked by their fit before tuning. The identity
   mapping (when it exists) and the two best other mappings are then tuned.
2. Retune the numeric constants, and for a boolean theory the threshold.
   - **Boolean theories:** a coordinate search on accuracy. The candidate
     values are midpoints between observed values plus an even grid
     reaching one range-width past the public ranges. Constants that start
     equal can also move together. A tie keeps the current value.
   - **Numeric theories:** damped Gauss-Newton (Levenberg-Marquardt) on the
     squared error.

It never adds, removes, or rearranges nodes, and it never changes the
operator. A world whose rule changed form therefore cannot be adapted this
way. The refit is pure: it reads only the theory, the public ranges, and the
observations. A test checks that it imports only the language.

### 10.3 Transfer metrics (`src/transfer/transfer.ts`)

`runTransfer(source, target, theory, { evaluation, adaptation })` reports:

- **Source:** the noise-aware report in the source world, and whether it passed.
- **Unchanged:** the report for the same theory in the target. This is not
  applicable (`UNKNOWN_ATTRIBUTE`) when the theory names attributes the target
  lacks. It is also not applicable (`OUTCOME_KIND_MISMATCH`) when the theory
  predicts the wrong kind of outcome. `transfersUnchanged` is true when it
  passes both in range and out of range.
- **Adaptation:** when the theory does not transfer unchanged, experiments
  run in the target in seeded batches through the ordinary world tools. The
  defaults are a batch size of 10, a limit of 200 experiments, noise seed 1,
  and design seed 2026. After each batch the theory is refitted on every
  observation so far and scored.
- **`experimentsToAdapt`:** the number of target experiments after which the
  refitted theory first passes both held-out sets. It is 0 when the theory
  transfers unchanged, and null when no refit passed within the limit.

The held-out evaluator only decides when to stop. The refit itself never sees
held-out cases. Every report also lists the per-batch steps and the options
used.

### 10.4 Hand-built cases (`src/transfer/scenarios.ts`, `npm run transfer`)

Each case uses the hand-written true theory of its base world as the source
theory. These are not agent discoveries. With the CLI's evaluation seeds:

| Case | Unchanged | Experiments to adapt |
| ---- | --------- | -------------------- |
| Glow World, two distractors added | passes | 0 |
| Glow World, threshold on `a` shifted by +2 | fails | 80 |
| Glow World, `a` rescaled by 2 | fails | 120 |
| Glow World, all attributes renamed | not applicable | 10 |
| Glow World, rule changed to `a > b` | fails | none within 200 |
| Ring World, centre moved along `q` by +2 | fails | 50 |
| Drift World, `u` shifted by +2 | fails | 10 |
| Drift World, rule changed to `u * v / 2` | fails | none within 200 |

The tests check each case's expected outcome with different evaluation seeds.
They also check that `experimentsToAdapt` is a whole number of batches, that
only the last step passes, that a failed adaptation used the full limit, and
that the report is reproducible.

### 10.5 Limits

The adaptation design is random within the public ranges. It is not chosen
by an agent, so `experimentsToAdapt` measures the theory and the refit, not
an agent's experimental skill. Ring World cannot be adapted to a rescaled
attribute, because the circle would need a new scale factor in its form.

---

## 11. Phase 8 backend API

`npm run serve -- [--port <n>] [--live]` starts an HTTP API on 127.0.0.1
(default port 3000). It uses `node:http` only; there is no web framework.

### 11.1 Stepwise sessions

The agent loop is now a stepper. `createDiscoveryRun(options)` returns
`step()`, `status()`, and `snapshot()`, and each `step()` runs one model
turn, including provider retries. `runDiscoveryAgent` loops over it, so the
CLI and every earlier test behave exactly as before. A second `step()` while
one is running throws.

`src/api/session-manager.ts` keeps up to 100 sessions in a `SessionStore`.
The default store is in memory. When `XENO_MONGODB_URI` is set, `npm run
serve` uses MongoDB instead (section 13), and sessions survive a restart.
A running session also keeps its live agent run in this process. Glow World
without a noise seed uses the original tools, as in the CLI.

### 11.2 Routes

Investigation routes return only what an agent could see or produce:

| Method and path | Returns |
| --------------- | ------- |
| `GET /health` | `{ ok: true }` |
| `GET /worlds` | Public description of every world, without a budget |
| `POST /sessions` | Creates a session. Body: `worldId`, and optionally `provider` (`dummy` or `gemini`), `budget`, `maxModelTurns`, `timeoutMs`, `maxRetries`, `noiseSeed`. |
| `GET /sessions` | Public views of every session |
| `GET /sessions/:id` | Public view: status, turns, budget used, submitted theory, provider diagnostic |
| `DELETE /sessions/:id` | Removes the session |
| `GET /sessions/:id/world` | The description the agent was given |
| `GET /sessions/:id/observations` | The agent-facing observation log |
| `GET /sessions/:id/transcript?from=n` | Transcript entries from index `n`, with `total` and `nextIndex` |
| `POST /sessions/:id/steps` | Runs up to `turns` model turns (1 to 32, default 1). Returns the turns run, the new public view, and the new transcript entries. |

Evaluator routes are the only ones that return scores or private settings:

| Method and path | Returns |
| --------------- | ------- |
| `POST /evaluator/sessions/:id/evaluations` | Scores the submitted theory with the noise-aware evaluator. Body: optional `inRangeSeed`, `outOfRangeSeed`, `caseCount` (even). |
| `GET /evaluator/sessions/:id` | The session's noise seed and every stored evaluation |

They need `Authorization: Bearer <XENO_OPERATOR_TOKEN>`, compared in
constant time. Without a configured token they answer `403
EVALUATOR_DISABLED`. The token is checked before any lookup, so an
unauthenticated caller cannot learn whether an evaluator path or session
exists.

### 11.3 Validation and errors

Every body and query string is parsed with a strict Zod schema in
`src/api/schemas.ts`. Unknown fields, repeated query keys, and bodies on GET
or DELETE are rejected. POST bodies must be `application/json` and at most
16 KiB. Errors use fixed codes and messages and never echo the request:

| Code | Status |
| ---- | ------ |
| `INVALID_JSON`, `INVALID_REQUEST`, `UNKNOWN_WORLD`, `PROVIDER_UNAVAILABLE` | 400 |
| `UNAUTHORIZED` | 401 |
| `EVALUATOR_DISABLED` | 403 |
| `NOT_FOUND` | 404 |
| `METHOD_NOT_ALLOWED` (with `Allow`) | 405 |
| `SESSION_BUSY`, `SESSION_FINISHED`, `NO_THEORY`, `SESSION_LIMIT` | 409 |
| `BODY_TOO_LARGE` | 413 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `INTERNAL_ERROR`, `SESSION_CORRUPT` | 500 |
| `STORAGE_UNAVAILABLE` | 503 |

Every response sets `cache-control: no-store` and
`x-content-type-options: nosniff`.

### 11.4 Providers and secrets

The dummy provider is always available. Gemini is offered only when the
server starts with `--live` and both Gemini values are set; otherwise
`provider: "gemini"` gets `PROVIDER_UNAVAILABLE`. The Gemini key and the
operator token are passed to the transcript scrubber and are never printed
or returned. `.env` may also hold `XENO_OPERATOR_TOKEN`,
`XENO_MONGODB_URI`, and `XENO_MONGODB_DB`. The loader still ignores every
other variable. The MongoDB URI is treated as a secret: it is never printed,
and it is scrubbed from transcripts.

### 11.5 Leak tests (`tests/api.test.ts`)

The tests run a real server on a random local port and cover every route. One
test creates and finishes a session on each world, evaluates it, then reads
every investigation route. It checks that no investigation response contains
the noise seed, the evaluation seeds, the operator token, or any of these
fields: flip rate, noise standard deviation, extrapolation profile,
accuracy, pass threshold, root mean squared error, noise ceiling, or stored
evaluations.

### 11.6 Limits

Without `XENO_MONGODB_URI`, sessions live in memory and disappear when the
server stops. With it, they are reloaded from MongoDB (section 13). A step
request stays open until its turns finish, which can take minutes with a
live model. The server binds to 127.0.0.1 and has no user accounts; the
operator token is the only access control.

---

## 12. Phase 9 React dashboard

The dashboard is a React 19 single-page app in `web/`, built with Vite. It
talks only to the Phase 8 API.

### 12.1 Running it

- `npm run serve` builds the server and the dashboard, then serves the
  dashboard at `http://127.0.0.1:3000/dashboard/`. The page and the API share
  an origin, so CORS is not needed.
- `npm run dashboard:dev` starts Vite's dev server with hot reload. It proxies
  the API routes to a server already running on port 3000.
- `npm run build:web` builds `dist-web/` only.

The server serves `index.html` and the flat files under `assets/`. File names
must match a safe character set, so no path can leave the directory. Every
dashboard response carries a strict Content Security Policy (`default-src
'self'`, no inline scripts or styles, `frame-ancestors 'none'`). Assets are
cached as immutable, and the page itself is not cached.

### 12.2 Views

| View | Source | Shows |
| ---- | ------ | ----- |
| Session rail and create form | `SessionList`, `CreateSessionForm` | One card per session: world, status, provider, and experiments used. New sessions take a world, budget, turn limit, and an optional private noise seed. |
| Session detail | `SessionDetail` | Status, gauges for turns and experiments, and actions: Step (`S`), Run to end (`R`, one turn at a time so the view updates live), Pause (`P`). `N` focuses the world picker. |
| Experiment space | `ExperimentSpace` | A scatter plot of probes on two chosen inputs, coloured by the observed outcome. |
| Experiment timeline | `ExperimentTimeline` | An SVG mark per experiment in run order: two lanes for a boolean outcome, a line for a numeric one. A disclosure lists every input and outcome. |
| Agent activity | `AgentFeed` | The public transcript as readable steps. Model text is shown as plain text. |
| Measurements | `MeasurementList` | Each `evaluate_measurement` call, whether it was valid, the range of its values, and a sparkline. |
| Theory | `SessionDetail`, `TheoryTable` | The submitted theory in readable form, every submission attempt with its result, and a table of all sessions' theories. |
| Score charts | `ScoreChart` | Bars for in-range and out-of-range accuracy (or within-tolerance rate on numeric worlds), each with its pass threshold, plus RMSE for numeric worlds. |

Charts are plain SVG, so there is no chart library.

### 12.3 Information hiding

Without the operator token the dashboard reads only investigation routes. It
shows no scores, score columns, or evaluate button. The operator types the
token into a password field. It is held in React state only, never in
storage or cookies, and is dropped if the server rejects it. With the token,
the dashboard loads stored evaluations, can evaluate a submitted theory, and
shows scores in the theory table and score charts. "Hide scores" forgets the
token.

The dashboard imports server code as types only, so no server code reaches
the bundle. A test enforces this, and also rejects `localStorage`,
`sessionStorage`, cookies, `dangerouslySetInnerHTML`, and `eval` in dashboard
code.

### 12.4 Tests

- `web/tests/components.test.tsx` (jsdom) renders each key view with fixed
  data. It covers selection and deletion, form validation, the experiment
  space, timeline marks for both outcome kinds, the activity feed, theory
  rows with and without scores, chart bars and thresholds, transcript
  parsing, and empty states.
- `web/tests/app.test.tsx` renders the whole app against a real API server
  on a random port. It creates and runs sessions, checks that no scores or
  noise seed appear without the token, then enters the token, evaluates, and
  reads the charts. It also covers hiding scores, a rejected token, deleting
  a session, and an unreachable API.
- `tests/api-dashboard.test.ts` covers dashboard hosting: the redirect, the
  security policy, asset types, path traversal attempts, allowed methods,
  and the server without a dashboard.

---

## 13. Phase 10 MongoDB persistence

Sessions, observations, theories, transcripts, and evaluator results are
stored through `SessionStore` (`src/storage/session-store.ts`). The HTTP
layer decides which fields a response may contain. The store is
operator-side and is never given to an agent.

### 13.1 The storage interface

`insert`, `get`, `list` (oldest first, ties broken by session id), `count`,
`saveProgress`, `appendEvaluation`, `remove`, and `close`. Reads and writes
return copies, so a caller cannot change a stored record by mutating what it
was given. `insert` throws `DuplicateSessionError` when the id is taken.
`saveProgress` replaces only the fields that change as the agent works
(status, turns, transcript, provider conversation, observations, submitted
theory, provider diagnostic, and `updatedAt`). Settings, the world, and
stored evaluations stay put. A missing session makes every write return
false.

`createMemorySessionStore` keeps records in this process. It is the default
when `XENO_MONGODB_URI` is unset.

### 13.2 MongoDB backend

`createMongoSessionStore({ uri, database })` uses the official `mongodb`
driver. The database defaults to `xeno`, and the collection is `sessions`,
with the session id as `_id` and an index on `createdAt` then `_id`.

Settings, counters, the observation log, the provider diagnostic, and
evaluator results are ordinary fields. Content the model wrote (the
transcript, the provider conversation, and the submitted theory) can contain
any key, including keys MongoDB would treat as operators, so those three
values are stored as JSON text and parsed back exactly.

`npm run serve` connects when `XENO_MONGODB_URI` is set and uses
`XENO_MONGODB_DB` when that is set too. A failed connection prints
`Could not connect to MongoDB (check XENO_MONGODB_URI).` and does not print
the URI. Later driver failures become `503 STORAGE_UNAVAILABLE`, again
without connection details.

### 13.3 Continuing a session after a restart

Progress is saved when a session is created, after every model turn, when it
is evaluated, and it is removed on delete. The live agent run stays in this
process. After a restart the next step rebuilds it:

1. Fresh tools are opened with the stored budget and the private noise seed.
2. Every stored experiment is replayed. Rejected requests draw no noise, so
   the noise stream lines up. If any replayed outcome differs from the stored
   one, the step fails with `SESSION_CORRUPT` and nothing is advanced.
3. `createDiscoveryRun` resumes from the stored transcript, provider
   messages, and turn count, which the run now exposes for this purpose.

A session another process already finished answers `SESSION_FINISHED`.

### 13.4 Tests

`tests/storage-contract.ts` is the suite every backend must pass: round
trips, duplicate ids, sort order, copy isolation, hostile keys in
model-written content, progress that must not overwrite fixed fields,
ordered and concurrent evaluations, deletion, continuing a session from a
second session manager, and refusal to resume a tampered observation log.

`tests/storage-memory.test.ts` runs that suite against the memory store.
`tests/storage-mongo.test.ts` runs it against a real MongoDB server. By
default `mongodb-memory-server` starts one in-process; `XENO_TEST_MONGO_URI`
uses a server you already have. Each test gets its own database, which is
dropped afterwards. A separate test checks the document layout (model
content stored as JSON text, an index on `createdAt`) and that a record
survives closing the client and opening it again.

### 13.5 Limits

The busy flag and the live run are per process. Two servers pointed at the
same database can both try to step one session. The 100-session cap still
applies, counted in the store. Replaying experiments requires the same world
code and noise seed that produced the stored outcomes.
