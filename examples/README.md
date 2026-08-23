# adorn examples

Runnable, self-contained scripts that show what adorn does. Each is meant to be **read** and **run**,
printing output that demonstrates one capability. They are excluded from the published package.

```bash
npx ts-node examples/01-llm-tool-decorated.ts
```

In these files the import is `from '../index'` so they resolve inside this repo; **in your own project
it is `from 'adorn'`** — the exact same public surface.

| # | File | Shows |
| --- | --- | --- |
| 01 | [`01-llm-tool-decorated.ts`](01-llm-tool-decorated.ts) | A contracted method **is** an LLM tool: one signature → the JSON Schema the model reads **and** the runtime validation its arguments face. |
| 02 | [`02-llm-tool-descriptor-first.ts`](02-llm-tool-descriptor-first.ts) | Tools whose permitted values are known only at **runtime** — `toolSchemaFrom` + `Verify.check(Fields(...))`, and OpenAI `providerStrict`. |
| 03 | [`03-boundary-validation.ts`](03-boundary-validation.ts) | `Verify.check` / `Verify.that` at an untrusted boundary — typed result, localized `path` + `expected`, compositional descriptors. |
| 04 | [`04-functional-contract.ts`](04-functional-contract.ts) | `contract(spec, fn)` — enforcement (params / requires / ensures / returns, sync **and** async) with no class or decorator. |
| 05 | [`05-pre-post-conditions.ts`](05-pre-post-conditions.ts) | Decorated `@Requires` (precondition), `@Ensures` / `@Returns` (postconditions) firing on bad input **and** a bad return. |
| 06 | [`06-projections.ts`](06-projections.ts) | One class → Markdown docs, a JSON Schema (draft 2020-12), and a privacy/telemetry report — all from the same registry. |
| 07 | [`07-observability.ts`](07-observability.ts) | The `ObservationSink`: `@Observe` completions, value-free violation events, a non-decorator emit (with `nextCallId`), and `consoleObservationSink`. |
| 08 | [`08-redaction.ts`](08-redaction.ts) | Safe-by-default redaction: `[REDACTED]` with zero annotations, `setValueDisclosure('all')` for local debugging, and the `@Sensitive` veto that survives it. |

Plus [`demo.ts`](demo.ts) — the original smoke script (`npm run demo`), which constructs a decorated class
and exits non-zero if a deliberate violation is *not* raised.

## The through-line

Every example is one declaration doing several jobs at once. A parameter constraint is the schema
keyword the model is steered by **and** the predicate that rejects a bad call **and** a documentation
row **and** a privacy fact — because they are all read from the one thing you wrote, they cannot drift.
