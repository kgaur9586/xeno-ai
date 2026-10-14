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

### 2.4 Expression language (`src/language/`, Phase 3)

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

### 2.5 Agent (`src/agents/`, Phase 2 scripted, Phase 5 LLM)

**What it is:** The discoverer. It decides which experiments to run, which
measurements to create, and which theories to propose.

**What it knows:** Only the public world description (attribute names and
allowed ranges), its budget, and the observations returned by the tools.
Every experimenter implements the same interface: it receives
`{ description, tools }` and nothing else.

**Phases:**
- Phase 2: simple hand-coded strategies (baselines).
- Phase 5: an LLM behind a thin provider interface, calling the same tools.

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
- Scores a theory: accuracy, and later simplicity and transfer.

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

All code lives in one package at the project root. Phases 1 to 3 create
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
      evaluator.ts          generates held-out cases, scores predictors
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
    language/               (Phase 3)
      errors.ts             fixed error codes and messages
      expression.ts         node types, allowed names, limits, Zod schema
      preflight.ts          bounded non-recursive safety pass and copy
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

Later phases add folders as they are needed, not before:

| Folder          | Phase | Contents                                |
| --------------- | ----- | --------------------------------------- |
| `src/agents/`   | 5     | The LLM agent, next to the baselines    |
| `src/language/` | 4     | Theory language, next to measurements   |
| API and web app | 8, 9  | Backend server and React dashboard      |

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
