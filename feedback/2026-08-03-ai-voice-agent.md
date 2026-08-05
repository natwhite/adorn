# Feedback on `adorn` — from the AiVoiceAgent-node build

**Date:** 2026-08-03
**From:** the `AiVoiceAgent-node` project (a Twilio ConversationRelay re-architecture test bed)
**Round:** 2 — the first round after the LLM-usability and schema-projection work landed

This is consumer feedback from a project that genuinely tried to adopt adorn and, on this occasion,
decided not to. The decision is argued below from the code rather than from a preference, and the
parts of adorn that are good are called good — an unearned compliment would make the rest of this
document worth less.

Every factual claim carries a `file:line` citation and a **Verify** line. Please check them; if any
of them is wrong, the rest of my conclusions deserve less weight, and I would rather you found that
out cheaply. Claims I could not check myself are collected under [Unverified](#unverified) rather
than smoothed over.

The longer internal version of this review — including the side-by-side code for the endpoint below
and the full adoption reasoning — lives at `AiVoiceAgent-node/docs/adorn-feedback.md`, which also
preserves round 1 with a per-item status.

---

## The context that shapes all of this

The consuming project has two constraints that make it an unusually harsh reviewer, and you should
weight the feedback accordingly:

1. **It has zero runtime dependencies.** `package.json` has no `"dependencies"` key at all. Adding a
   first one is a real threshold, not a formality.
2. **Its governing principle is to stay minimal** and delete anything not exercised. It has removed
   more machinery than it has added.

A project with a normal dependency budget would weigh §1 and §5 differently. Nothing below is an
argument that adorn is too heavy in general.

---

## Ranked actions

### 1. Ship the documentation you already wrote — highest leverage, roughly an hour

This is the single biggest return available, and it costs almost nothing.

`index.ts` is 359 lines, of which **162 are `//` comments** and only ~15 are JSDoc. The emitted
`dist/index.d.ts` is **58 lines with 1 `//` comment**. TypeScript's declaration emit preserves JSDoc
(`/** … */`) and discards line comments — so the great majority of the guidance you wrote is
invisible to anyone consuming the published package, which is exactly where it was most needed.

This matters disproportionately for the LLM-consumption goal you have been building toward: a model
writing code against adorn sees `dist/index.d.ts`, not `index.ts`. The corrective guidance for a
real API trap (`NumberContracts.Between` argument shape) sits at `index.ts:161` and does not survive
into the shipped declarations. The one guidance block that *does* survive is the JSDoc on `Contract`
— which is precisely the point: JSDoc survived, `//` did not.

**Action:** convert the load-bearing `//` blocks in `index.ts` to `/** … */`. Mechanical, low risk,
and it roughly quadruples what a consumer (human or model) can see.

> **Verify:**
> `(Get-Content index.ts | Select-String '^\s*//').Count` → 162
> `(Get-Content dist/index.d.ts).Count` → 58

---

### 2. `@Shape` (GAP-16 / IDEA-25) is the gap that actually blocked adoption

Your own tracker already has this right, which is why it is item 2 and not a complaint:

> `GAP-16 | OPEN | **No nested-object descriptor kind.** A tool argument that is a structured object
> can't be constrained — you cannot decorate a parameter's fields, and there is no object descriptor.`
> — `docs/ISSUES.md:84`

The endpoint I wanted to validate takes `{seq: number, optionId: string, slotInput?: Record<string,
string>}` off an unauthenticated public port. adorn covers `seq` and `optionId` comfortably. It has
nothing that can express `slotInput`, which is the only field with a shape worth validating — and
therefore the only field that would have justified the dependency.

`@Shape` is currently build-order #6 (`docs/ISSUES.md:151`). **From this consumer's perspective it is
the highest-value remaining item in the contract offering**, ahead of `@Const`/`@Nullable`/`@Default`
polish. A validator that handles primitives but not objects is a validator you still have to
hand-write the interesting half of, and once the hand-written half exists the adorn half stops
paying for itself.

Worth noting the mismatch this creates today: `Record<string, string>` projects to a tool-schema
property with a `description` and **no `type`**, which is weaker than the rest of the projection
deserves.

> **Verify:** `docs/ISSUES.md:84` (GAP-16, OPEN) and `docs/ISSUES.md:151` (IDEA-25, build-order #6).

---

### 3. Give consumers a non-throwing path — or export the typed error

adorn's enforcement throws, and `Configuration` offers throw-or-proceed rather than
throw-or-return-a-value. That is a coherent design for a decorator-based contract system and I am not
asking you to abandon it.

The friction is at the boundary. The consuming project requires that failures be **returned typed
values, never thrown** — an HTTP handler turning a bad body into a `400` needs the violation *as a
value, in that call*, not as an exception to catch and re-interpret.

And catching it is harder than it should be: `ViolationError` is exported from its own module
(`src/Core/ViolationError.ts:39`) but deliberately **not re-exported from the package entry point**
(`index.ts:85-86`, `index.ts:287`, citing Q-6). The stated rationale is that consumers receive facts
through the observation sink rather than by catching:

> `This class is **not** exported from the package. Consumers receive facts through the observation
> sink, not by catching a typed error; exporting it would widen the semver surface with no consumer
> (Q-6).` — `src/Core/ViolationError.ts:20-21`

**Here is the consumer Q-6 was looking for.** The sink is the wrong shape for this job: it is an
out-of-band stream of facts, and an HTTP handler needs to correlate *this* failure with *this*
response, synchronously, to choose a status code and a message. With the error unexported, the only
bridge available is `error.name === 'ViolationError'` — a string comparison against a class you
deliberately hid, which is strictly worse for your semver surface than exporting the type would have
been.

**Action, in preference order:** (a) a non-throwing entry point returning a discriminated result —
this would make adorn usable at every I/O boundary, not just inside already-trusted call paths; or,
failing that, (b) export `ViolationError` as a type so the catch site can be type-safe.

> **Verify:** `src/Core/ViolationError.ts:20-21` (intent) and `:39` (module-level export);
> `index.ts:85-86` and `index.ts:287` (deliberate non-re-export).

---

### 4. Nothing narrows `unknown`, and that is structural

Two signatures, quoted verbatim:

```ts
static that<T>(constraint: ConstraintDescriptor, keyName: string | symbol, value: T): T   // src/Validation/Verify.ts:82
export type Predicate = (value: unknown) => boolean                                        // src/Core/Descriptor.ts:72
```

`Verify.that` returns the **input** type, so it validates without narrowing. `Predicate` returns
`boolean`, not `value is T`, so it cannot drive `.filter()` or `if`-narrowing either.

The practical consequence at an I/O boundary: the value arrives as `unknown`, and the only line that
is genuinely unsound — the cast from `unknown` to the expected shape — remains the consumer's, with
adorn checking *after* it. That inverts what a validator is for. In a system where a decorator guards
an already-typed method parameter this is invisible; at a network boundary it is the whole problem.

**Action:** if `Predicate` became `(value: unknown) => value is T` (or a parallel guard-shaped type
existed), adorn would compose with narrowing instead of sitting beside it.

> **Verify:** read the two lines cited. Neither is a type predicate.

---

### 5. Bump `tslib` — it is two majors behind

```json
"dependencies": { "tslib": "^1.10.0" }   // package.json:45-46
```

`importHelpers: true` is set (`tsconfig.json:38`) and `require("tslib")` appears throughout the
emitted output, so the dependency is real and used — this is not a suggestion to remove it. But
tslib 1.x is two majors behind the current 2.x line, which is what TypeScript 5+/6 emits against.
Small, mechanical, and it is the kind of thing a security-conscious adopter checks first.

Flagging it also because it is a fact worth stating plainly to prospective adopters: **adorn is not
zero-dependency.** That is fine and normal; it was simply load-bearing for *this* project's decision
and was not obvious from the README.

> **Verify:** `package.json:45-46`, `tsconfig.json:38`, and
> `Get-ChildItem dist -Recurse -Filter *.js | Select-String 'require\("tslib"\)'`.

---

## What is genuinely good, and improved since round 1

**The schema projection is the strongest thing in the library.** `toolSchemaForMethod`
(`src/Projections/schema.ts:304-308`) turning decorated parameters into an LLM tool schema is a real
answer to a real problem, and it closes most of what round 1 asked for. `@OneOf` (GAP-14, fixed) and
`@ArrayOf` (GAP-15, fixed) were the right two to build first — enums and arrays are exactly what tool
arguments are made of.

**Your tracker is unusually honest**, and I want to be specific about why that mattered here: the
decisive fact in this adoption decision — that object shapes are not expressible — I found in *your*
`ISSUES.md`, stated plainly as an open gap, not by discovering it the hard way. A project that
records its gaps accurately is one an outsider can evaluate quickly and trust. That is worth more
than it probably feels like when writing it.

**One conceptual note back:** `@OneOf` is the right *shape* of idea for a problem the consuming
project hit independently. Our presentation layer has a slot field whose valid values are a fixed set
(patient ids) that the wire format never enumerates, so a picker UI cannot render it. `@OneOf`'s
`{enum: […]}` is exactly that concept, one level of dynamism down — ours is per-session rather than
fixed at decoration time. If you ever consider a runtime-supplied variant of `@OneOf`, there is a real
use case waiting for it.

---

## The adoption verdict, stated plainly

**Not adopted for this endpoint** — and the deciding factor was capability, not the dependency count.
adorn cannot express the one field that needed validating (§2). Add to that a throwing failure mode
against a codebase that requires returned values (§3) and no narrowing from `unknown` (§4), and what
remains is two boolean checks on two primitives, in exchange for a first runtime dependency and
repo-wide `experimentalDecorators`.

The hand-written alternative came to about 40 lines of logic, returns `{kind: 'ok' | 'error'}`,
compiles clean under `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, and
handled every hostile body thrown at it. It reuses a `{kind: …}` result union the codebase already
had three of, so it introduced no new concept.

**This verdict would flip** on §2 plus §3. If `@Shape` existed and there were a non-throwing entry
point, adorn would be doing real work at this boundary rather than decorating the easy half of it.

---

## One place adorn would make things actively worse

Offered because it is more useful than another feature request, and because the distinction seems
worth naming in your own docs.

The consuming project has a renderer whose defensive readers look superficially like a validation
use case: `asString`, `asNumber`, `asStringArray`, `isLabeledDatum`. Adopting adorn there would be a
regression, for two reasons:

- **They are coercers, not rejecters.** `asString` returns `string | null`; `asStringArray` returns
  `[]` for anything unusable. The function they serve is contractually guaranteed **never to throw** —
  it degrades to legible output instead, because a malformed value must not end a phone call. adorn's
  model is to reject. Substituting one for the other would convert a graceful degradation into a
  failure.
- **`isLabeledDatum` is a type predicate** (`value is LabeledDatum`) and its narrowing drives a
  `.filter()`. `Predicate` (§4) is not guard-shaped, so this would lose type information.

The general lesson: **validation and coercion are different jobs**, and adorn is firmly a validator.
Saying so explicitly in the README would save a prospective adopter the same analysis — and it costs
you nothing, because "not a coercion library" is a strength claim, not a limitation.

---

## Unverified

Stated so nothing here is mistaken for a checked fact:

1. **adorn under a real LLM tool-call loop.** The generated schema was inspected by eye; no provider
   ever consumed it. The claim that the projection is good is a code-reading judgement, not an
   observed round trip.
2. **Minification degrading parameter names.** Not reproduced. Taken on your own README's word, which
   states it against interest.
3. **Round 1's `strict: false` declaration leak.** Only partially re-checked. A probe compiled clean
   under `strict` + `exactOptionalPropertyTypes`, but `getContractedClasses()` — where round 1
   located the leak — was not exercised.
4. **`@adorn/test`, `@adorn/otel`, the CLI, and the sensitive-flow detector.** Out of scope, not
   evaluated, no opinion offered.
5. The hostile-input and throwing-behaviour observations in §3 come from a scripted review run inside
   the consuming project rather than from my own hands; the **signatures, exports, tracker entries,
   dependency and line counts** cited throughout were each checked directly against this repository.
