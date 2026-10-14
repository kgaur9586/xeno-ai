# XENO — Project Plan

XENO is an experimental AI system that discovers hidden rules in simulated
worlds. It runs experiments, invents new measurements from raw observations,
proposes theories, tests them on unseen cases, and checks whether discoveries
still work in altered worlds.

This plan is split into small phases. Each phase has a **goal**, the
**deliverables** it produces, and **exit criteria**: automated tests that must
pass before we move on. A phase is not "done" because code exists; it is done
when its tests demonstrate the behavior.

---

## Guiding rules (apply to every phase)

1. **The hidden rule never reaches the agent.** Not in tool outputs, error
   messages, prompts, logs the agent can read, world descriptions, or design
   documents and source code (these docs describe the hidden rule, so they
   are never placed in the agent's context).
2. **No arbitrary code execution.** Anything the LLM writes (measurements,
   theories) is expressed in a small, restricted language that we parse,
   validate with Zod, and interpret ourselves. We never `eval` it.
3. **Three separate components:** the world engine (knows the rule), the
   agent-facing experiment tools (the only door the agent can use), and the
   evaluator (scores theories against unseen cases).
4. **Claims require tests.** "The agent discovered the rule" means a test
   scored its theory on held-out cases and it passed a stated threshold.
5. **Minimal dependencies.** Each new package must be justified in writing.

---

## Phase 0 — Setup and planning (current step)

**Goal:** Agree on what we are building and how the pieces fit.

**Deliverables**
- `docs/PROJECT_PLAN.md` (this file)
- `docs/ARCHITECTURE.md`
- Proposed directory structure and first milestone specification

**Exit criteria**
- Tooling verified (Node.js, npm, git).
- You have reviewed and approved the first milestone.

---

## Phase 1 — Hidden world, safe experiment tools, observation log, evaluator

**Goal:** A tiny, deterministic world with a hidden rule, a safe way to run
experiments on it, a log of what was observed, and an evaluator that can tell
a correct theory from a wrong one.

**In scope**
- Project scaffolding: `package.json`, `tsconfig.json`, Vitest setup.
- The "Glow World" simulation in `src/worlds/` (see `ARCHITECTURE.md`,
  section 5). Attributes `a`, `b`, `c` range from 0 to 10; the object glows
  exactly when `a` and `b` are on opposite sides of a hidden threshold; `c`
  has no effect. The rule is fixed.
- Agent-facing experiment tools in `src/tools/`: strict Zod input
  validation, an experiment budget, exact output fields, safe errors.
- An observation log (in `src/tools/`) that records every accepted
  experiment.
- An evaluator in `src/evaluator/` with a seeded random number generator
  that produces reproducible, balanced held-out cases **within the permitted
  input ranges**, and scores trusted, hand-written predictors.

**Out of scope for Phase 1**
- Any LLM or AI agent, frontend, HTTP API, or MongoDB.
- The measurement and theory languages (Phases 3 and 4).
- Out-of-range (extrapolation) evaluation (Phase 4).
- Noise, multiple worlds, randomized rules (Phase 6 and later).

**Exit criteria (all automated; full list in `ARCHITECTURE.md` section 5.5)**
- The same seed reproduces the same evaluation cases; the same inputs always
  give the same outcome.
- Outcomes follow the hidden rule for hand-picked inputs, including the
  boundary (exactly 5 never glows) and the irrelevance of `c`.
- Invalid inputs (out of range, wrong type, missing or extra fields, `NaN`,
  `Infinity`) are rejected; 0 and 10 are accepted.
- Experiments beyond the budget are refused; rejected requests use no budget.
- Every response contains exactly its allowed fields and no private rule
  configuration; errors have a fixed code and fixed message.
- Changing returned data does not change internal state.
- Evaluating does not touch the observation log or the budget.
- The correct predictor scores 100% on held-out cases; constant and
  single-attribute predictors score about 50%.

---

## Phase 2 — Scripted baseline experimenters

**Goal:** Establish a performance floor before adding AI, so we can later say
whether the LLM actually helps.

**Deliverables**
- A common experimenter interface that receives only the public world
  description and the experiment tools (`src/agents/experimenter.ts`).
- A **random** experimenter (seeded random inputs within the public ranges).
- A **systematic** experimenter: a factorial grid of minimum, midpoint, and
  maximum for each attribute, derived from the public ranges (27
  experiments; it stops when the grid is complete).
- A runner that executes an experimenter under a configurable budget and
  reports descriptive metrics: experiment and request counts, rejected
  requests, unique and repeated inputs, outcome counts, and per-attribute
  value distributions.
- The seeded random number generator moves to `src/shared/random.ts`.

**Exit criteria**
- Both baselines run end-to-end through the experiment tools only, and a
  test confirms they never import the world engine or the evaluator.
- Their results are reproducible with a fixed seed.
- Runner metrics are verified against hand-built observations.
- Metrics are descriptive only. Neither baseline is called "better at
  discovery" until Phase 4 scores actual theories.

---

## Phase 3 — Restricted measurement language

**Goal:** Let the system build new quantities (e.g.
`m = (a - 5) * (b - 5)` for Glow World) from raw observations **without
executing generated code**.

**Deliverables**
- A small expression language: numbers, observed attribute names, `+ - * /`,
  and a short whitelist of functions (e.g. `abs`, `sqrt`, `log`, `min`, `max`).
- Expressions represented as a JSON tree (an AST, "abstract syntax tree")
  validated by Zod.
- A safe interpreter that walks the tree and computes values.
- Limits: maximum depth, maximum node count, division-by-zero handling.

**Exit criteria**
- Valid expressions compute correct values.
- Unknown functions, unknown variables, oversized or too-deep trees are
  rejected with clear errors.
- Fuzz-style tests: random junk input never crashes the interpreter.

---

## Phase 4 — Theory language and evaluation

**Goal:** Represent theories as testable prediction rules built from
measurements, and score them properly.

**Deliverables**
- Theory format, e.g. "outcome is `true` when measurement `m` < 0",
  validated by Zod.
- Evaluator scoring: accuracy on held-out cases, accuracy on
  **out-of-range** cases (extrapolation, introduced in this phase), and a
  simplicity score.
- A theory registry that records each theory and its scores.

**Exit criteria**
- The true theory scores near 100% in- and out-of-range.
- Theories that rely on a distractor attribute score near chance.
- Theories that only memorize seen data fail on out-of-range cases.

---

## Phase 5 — Single LLM agent (one configurable provider)

**Goal:** Replace the scripted experimenter with an LLM that chooses
experiments, proposes measurements, and states theories using our tools.

**Deliverables**
- Provider configuration via environment variables (API key, model name).
- A thin provider interface so another provider can be added later.
- The agent loop: think, call tool, observe, repeat, within a budget.
- Every LLM tool call validated with Zod before execution.
- Full transcript logging for later inspection.

**Exit criteria**
- With a mock LLM (scripted responses), the loop runs end-to-end in tests,
  so tests never need a real API key.
- Malformed tool calls are rejected and reported back to the agent.
- A leak test confirms no prompt or tool output contains hidden-rule data.
- Real-LLM runs are reported honestly versus the Phase 2 baselines.

---

## Phase 6 — Richer worlds

**Goal:** Make discovery harder and more realistic.

**Deliverables**
- Measurement noise (observations are slightly imprecise).
- Numeric outcomes (not just true/false).
- Multiple distractor attributes.
- At least two more worlds with different rule shapes.

**Exit criteria**
- Each world has its own determinism, rule, isolation, and evaluator tests.
- The evaluator's thresholds account for noise.

---

## Phase 7 — Transfer to altered worlds

**Goal:** Measure whether a discovery remains useful when the world changes.

**Deliverables**
- World variants: shifted thresholds, rescaled units, renamed attributes,
  added distractors, changed rule form.
- Transfer metrics: how well the old theory performs in the new world
  unchanged, and how many experiments are needed to adapt it.

**Exit criteria**
- Tests show transfer metrics computed correctly on hand-built cases
  (e.g. a theory that should transfer does; one that should not, does not).

---

## Phase 8 — Backend API

**Goal:** Run and inspect discovery sessions through an HTTP API.

**Deliverables**
- Endpoints to create a session, run steps, and fetch logs and scores.
- Zod validation on every request.
- No endpoint returns hidden-rule data except explicit evaluator-only
  endpoints, clearly separated.

**Exit criteria**
- API tests cover each endpoint, including leak checks.

---

## Phase 9 — React dashboard

**Goal:** Visualize experiments, measurements, theories, and scores.

**Deliverables**
- Session list, experiment timeline, theory table, score charts.

**Exit criteria**
- Component tests for key views; the dashboard works against the real API.

---

## Phase 10 — MongoDB persistence

**Goal:** Store sessions, observations, theories, and results durably.

**Deliverables**
- A storage interface (already used by earlier phases with an in-memory
  implementation) plus a MongoDB implementation.

**Exit criteria**
- The same storage test suite passes against in-memory and MongoDB backends.

---

## Phase 11 — Multiple specialized agents (optional)

**Goal:** Only if Phase 5 results justify it, split work into roles such as
experimenter, theorist, and critic.

**Exit criteria**
- Measured improvement over the single agent on the same worlds and budgets.
