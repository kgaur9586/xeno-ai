# XENO

XENO is an experimental system that tries to discover hidden rules in
simulated worlds. An agent runs experiments, builds new measurements from raw
observations, and submits a theory. An evaluator then scores that theory on
cases the agent never saw, both inside and outside the input ranges the agent
was allowed to use.

The agent never sees the hidden rule. It gets the public world description,
its experiment budget, and the results the tools return. Anything the agent
writes (measurements and theories) is JSON in a small restricted language that
XENO validates and interprets itself. Generated code is never executed.

## Status

| Phase | Topic | Status |
| ----- | ----- | ------ |
| 0 | Planning docs | Done |
| 1 | Glow World, experiment tools, observation log, evaluator | Done |
| 2 | Scripted baseline experimenters | Done |
| 3 | Restricted measurement language | Done |
| 4 | Theory language, out-of-range scoring, theory registry | Done |
| 5 | Single LLM agent | Done with dummy data; no live Gemini run scored yet |
| 6 | Richer worlds: noise, numeric outcomes, more distractors, two new worlds | Done; the agent and baselines run on every world |
| 7 | Transfer to altered worlds | Done, on hand-built source theories |
| 8 | Backend HTTP API | Done; sessions are kept in memory |
| 9 | React dashboard | Done |
| 10 to 11 | MongoDB, multiple agents | Not started |

The full plan is in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

## Worlds

| World | Attributes | Outcome | Observations |
| ----- | ---------- | ------- | ------------ |
| `glow-world` | `a`, `b`, `c` | `glows` (true/false) | exact |
| `ring-world` | `p`, `q`, `r`, `s` | `lit` (true/false) | noisy |
| `drift-world` | `u`, `v`, `w`, `x`, `y` | `level` (number) | noisy |

Each world hides its rule and includes attributes that have no effect. On
noisy worlds the evaluator's pass thresholds allow for the noise, so a correct
theory can pass without scoring 100%.

## Requirements

- Node.js (developed and tested on version 24)
- npm

## Setup

```bash
npm install
npm test
```

No API key is needed for tests or for the default commands. They use a
scripted dummy provider that makes no network calls.

### Optional: live Gemini runs

Copy `.env.example` to `.env` and fill in both values:

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=your-model-name
```

`.env` is ignored by Git. A live run must also be requested explicitly with
`--live`; without that flag XENO stays on the dummy provider even if a key is
set.

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm test` | Runs the test suite. |
| `npm run typecheck` | Type-checks `src` and `tests`. |
| `npm run build` | Compiles `src` to `dist`. |
| `npm run baselines` | Prints exploration metrics for the random and grid explorers. These are not discovery scores. |
| `npm run compare` | Scores the dummy agent and both baselines on Glow World at the same budget (27) and seed (42). |
| `npm run compare -- --world ring-world` | The same comparison on another world, scored by the noise-aware evaluator. Add `--noise-seed <n>` to change the private noise seed. |
| `npm run discover` | Runs one discovery session with the dummy provider. |
| `npm run discover -- --live` | Runs one session against Gemini. Requires both `.env` values. |
| `npm run transfer` | Runs the hand-built transfer cases: does a theory still pass after the world is altered, and how many experiments does adapting it take? |
| `npm run serve` | Builds everything and starts the HTTP API on `http://127.0.0.1:3000`, with the dashboard at `/dashboard/`. Add `-- --port <n>` to change the port, or `-- --live` to offer Gemini. |
| `npm run dashboard:dev` | Dashboard dev server with hot reload. It proxies API calls to a server running on port 3000. |

`discover` accepts these options:

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `--budget` | 30 | Experiments the agent may run |
| `--max-turns` | 16 | Model turns before the session stops |
| `--timeout-ms` | 60000 | Timeout for each provider request |
| `--retries` | 2 | Retries after a transient provider failure |
| `--in-range-seed` | 1 | Seed for the in-range evaluation cases |
| `--out-of-range-seed` | 2 | Seed for the out-of-range evaluation cases |
| `--case-count` | 200 | Evaluation cases per set (must be even) |
| `--world` | `glow-world` | World to investigate: `glow-world`, `ring-world`, or `drift-world` |
| `--noise-seed` | none | Private observation noise seed (the world tools default to 1) |
| `--live` | off | Use Gemini instead of the dummy provider |

Example:

```bash
npm run discover -- --budget 10 --max-turns 8
```

`discover`, `compare`, and `transfer` save a JSON copy of each run (for
`discover`, including the full transcript) under `runs/`. That folder is ignored by Git. A run is not saved if
the API key would appear in the file.

## HTTP API

`npm run serve` runs discovery sessions over HTTP. The basic flow:

```bash
# Create a session (dummy provider by default)
curl -X POST http://127.0.0.1:3000/sessions -H "content-type: application/json" -d '{"worldId":"ring-world"}'

# Run model turns, one or more per request
curl -X POST http://127.0.0.1:3000/sessions/<id>/steps -H "content-type: application/json" -d '{"turns":5}'

# Inspect what the agent saw and did
curl http://127.0.0.1:3000/sessions/<id>/observations
curl http://127.0.0.1:3000/sessions/<id>/transcript
```

Scores come only from the evaluator routes under `/evaluator/`. They are
disabled unless `XENO_OPERATOR_TOKEN` is set (in the environment or `.env`),
and each request must send it as a bearer token:

```bash
curl -X POST http://127.0.0.1:3000/evaluator/sessions/<id>/evaluations \
  -H "authorization: Bearer $XENO_OPERATOR_TOKEN" -H "content-type: application/json" -d '{}'
```

Every route, request field, and error code is listed in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 11. Sessions are kept
in memory and are lost when the server stops.

## Dashboard

Run `npm run serve` and open
[http://127.0.0.1:3000/dashboard/](http://127.0.0.1:3000/dashboard/). From
there you can:

- create a session for any world and run it one turn at a time or to the end
- follow each experiment on the timeline
- see the measurements the agent defined and every theory it submitted

Held-out scores stay hidden until you enter the operator token
(`XENO_OPERATOR_TOKEN`) in the top bar. The dashboard then adds an
"Evaluate theory" button, score columns in the theory table, and score charts
with pass thresholds. The token is kept in memory only.

## Reading the results

- **Dummy results are not model results.** Every dummy run is labeled as such
  in its output. On Glow World the dummy explores the same min/mid/max grid
  as the systematic baseline. On larger worlds it uses a fixed-seed random
  design. It picks its theory from a small fixed catalog (least squares for
  numeric outcomes).
- **Transfer cases use hand-written theories.** `npm run transfer` starts
  from each world's true rule, not from an agent's discovery. Adapting may
  rename variables and retune constants. It cannot change the theory's form,
  so a changed rule is expected not to adapt.
- **Perfect scores on Glow World are expected and not meaningful.** The
  catalog uses each public range's midpoint, which happens to match Glow
  World's private threshold. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 7.
- **In-sample accuracy is not discovery.** A theory can fit a strategy's own
  observations perfectly and still score at chance on held-out cases. Only the
  evaluator's in-range and out-of-range scores measure discovery.

## Project layout

```
src/
  worlds/      world engines, registry, and variant worlds; the only place hidden rules live
  tools/       agent-facing experiment tools and strict schemas
  language/    restricted measurement and theory language
  evaluator/   held-out case generation, theory scoring, registry
  agents/      baselines, discovery agent loop, session, comparison
  llm/         provider interface, Gemini adapter, dummy provider
  transfer/    theory refit, transfer metrics, hand-built transfer cases
  api/         HTTP API: request schemas, in-memory sessions, routes
  shared/      seeded random number generator
  cli/         entry points for the npm commands
web/           React dashboard (Vite): components, API client, component tests
tests/         Vitest suite
docs/          project plan and architecture
```

## Documentation

- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md): phases, deliverables, and
  exit criteria.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components,   information
  hiding, the Glow World design, benchmark limits, the Phase 5 agent, the
  Phase 6 worlds, Phase 7 transfer, the Phase 8 API, and the Phase 9
  dashboard.

These documents describe the hidden rule. They are never placed in an agent's
context.
