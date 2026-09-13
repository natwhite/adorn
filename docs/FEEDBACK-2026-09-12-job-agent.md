# job-agent round 3 — adorn under a strict-mode micro model, and one projection inconsistency

**Date:** 2026-09-12
**From:** the `job-agent` project (the submit stage; `src/apply/micro.ts`, `fit-model.ts`, `classify-model.ts`)
**Measured against:** your `dist` at `5ef08a0`, through the `file:../adorn` junction
**Method:** `job-agent/probe/micro-probe.ts` and `probe/micro-replay.ts` against the OpenAI Responses API
(`gpt-5-nano`, `text.format = json_schema, strict: true`), plus three one-line `toolSchemaFrom` projections
run from the job-agent tree (verbatim below). Executed, not read.

> **Filed, not committed.** As before: consumers file, the owner commits.

---

## 1. What went to a strict-mode model this round, and what the API said

The submit stage now uses a small model in two places, both fenced by adorn: (1) re-spelling a settled
value as one of a form's own options, (2) classifying a form label into an answer key. Every schema is
`toolSchemaFrom(..., { providerStrict: true })`; every reply is `Verify.check`ed through the same
descriptors before the code reads it.

| Shape sent under `strict: true` | API |
| --- | --- |
| `Nullable(OneOf(<runtime option list>))` — projects as `anyOf: [{enum}, {type: null}]` | accepted |
| `ArrayOf(Fields({ index: Integer, key: OneOf([...keys, 'none']), confidence: Between(0,100), inverted: OneOf([true,false]) }))` | accepted |
| `Fields({ confidence: { descriptor: [Integer(), Between(0, 100)] } })` — a **stack** inside Fields | **HTTP 400** — strict mode refuses `allOf` |

The first two are good news and worth stating in the README's "strict mode" evidence block if it does not
already list them: a per-call enum built at runtime, wrapped in Nullable, is exactly how "pick one of these
or say none" has to be expressed under strict mode (no optional properties), and it works. The
`OneOf([true, false])` for a boolean also round-trips.

## 2. The projection inconsistency (the one thing I would ask you to look at)

A stacked descriptor array is projected **differently at the top level than inside `Fields`**. Verbatim,
from `node -e` against your `dist`:

Top-level parameter, stack `[Integer(), Between(0, 100)]` — merged into one node:

```json
{"c":{"type":"integer","minimum":0,"maximum":100}}
```

The same stack as a field of `ObjectContracts.Fields`, whether the object is a parameter or an `ArrayOf`
item — emitted as `allOf`:

```json
{"c":{"allOf":[{"type":"integer"},{"type":"number","minimum":0,"maximum":100}]}}
```

A single descriptor inside `Fields` (`Integer()` alone) projects cleanly (`{"type":"integer"}`), so this is
specifically the *stack-inside-Fields* path not going through whatever merge the top-level path uses.

Why it matters: OpenAI strict mode rejects `allOf` outright, so a consumer who writes the same
constraint the same way in two places gets a 400 from one of them, with the error naming a key in a
schema they never wrote. The README's strict-mode section promises nested objects work under strict; this
is the one nested shape I found that does not.

**Ask:** route `Fields` values through the same merge the top-level parameter path uses, so a stack of
compatible numeric constraints collapses to one node everywhere. Until then the workaround is a single
descriptor (`Between(0, 100)` alone, then `Math.round` in code), which is what shipped.

## 3. Observations, not asks

- **A bound in prose is not a bound.** With `confidence: Between(0, 100)` and no description, the model
  answered `0.8` on the first probe — a probability. `description: 'whole number 0-100'` did not fix it on
  its own; the descriptor did. The README already says descriptors are the contract and descriptions are
  hints; this is a concrete case where a small model treats the hint as decoration. Worth one sentence
  in the "small models" guidance if you have any.
- **`@Returns` cannot say "T or undefined".** A method whose postcondition is "a valid X, or undefined
  when there is none" (`YearsOfDiscipline.of`, `EmploymentHistory.from`) is written with an `@Ensures`
  closure instead. That works and reads fine; recording it so the pattern is findable, not asking for
  a widening.
- **Constructor parameters, again (§2.2 of round 1).** `MicroBudget` hit TS1239 with markers on
  constructor parameters and took the private-constructor-plus-`static of()` shape, as `FormQuestion`
  and `Credentials` did. Still no push — the factory shape has earned its place. Noting only that a
  third class in one project reached for it, so the README's one-liner about it is pulling its weight.
- **`Verify.check` as a cache guard works well.** `JsonCache<T>` (micro.ts) runs every entry of a JSON
  file through one `Fields` descriptor on load and `Verify.that` on write, so a hand edit that breaks the
  shape fails loudly with the entry's key in the message. One friction point: the value type of a
  `Fields({...})` descriptor is not inferred, so the cache is constructed as
  `JsonCache.at<Entry>('x.json', Entry as never)`. If `Fields` could carry its inferred object type in
  the descriptor's type parameter, that cast would go away — a nice-to-have, not a blocker.

## 4. What round 4 will have data on

- A live submission with both micro paths active on a real form (ADNET's employer questionnaire), which
  is where the allowlist fence around model-proposed keys gets exercised for the first time.
- `telemetryForClass` as a privacy review over the pipeline — still owed from round 1.

## 5. Addendum, 2026-09-13 — the reasoner and the verifier

Increment 3 (a `gpt-5-mini` reasoner returning one claim per form question, a code
verifier that admits or refuses each claim) is built on adorn end to end. Two things
I worked around, for the record:

- **`@Ensures` cannot carry a dynamic reason.** A verifier's postcondition is "the
  verdict is well-formed", but what the caller needs is *which* check refused the claim
  and why. I reified the verdict (`{ok, check, detail, ask?}`) and kept `@Ensures` as the
  static invariant ("a verdict"). If `@Ensures` could take a function returning
  `string | true`, the reason would live in the contract, not beside it.
- **`MaxLength` under `providerStrict`.** The strict projection refuses `maxLength`, so
  every bounded string in the claim schema is a bare `Matches` with the bound in its
  description, re-checked on the reply with `slice`. Documenting which descriptors project
  under strict (and which fall back to description-only) would save the next author the
  round trip.

Worked without a note: `Nullable(Fields(...))` inside `ArrayOf`, `Nullable(OneOf)` as
`anyOf`, `Verify.check(Batch, ...)` on the reply as the second gate after the schema.
