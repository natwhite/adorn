# Decision: does adorn's schema projection serve LLM tool-calling?

**Status:** DESIGN + empirical spike. Proposes DEC-048, IDEA-20, IDEA-21, GAP-14, Q-28/Q-29/Q-30.
**Source of the question:** real-world feedback from `AiVoiceAgent-ts` (a project using adorn).
**Spike:** `spike/tool-schemas.ts` (+ `spike/tsconfig.tool-schemas.json`), throwaway, excluded from build/lint/jest. Run with:

```
npx ts-node --project spike/tsconfig.tool-schemas.json spike/tool-schemas.ts
```

---

## The feedback, and the claim under test

> "Every tool a project exposes to an LLM needs a JSON Schema for its parameters AND runtime
> validation of what the model sends back — untrusted input in the strictest sense. Those are two
> artifacts that normally drift — exactly adorn's thesis, and a STRONGER case than doc generation,
> because the schema's consumer is a machine that will confidently produce malformed arguments if you
> get it wrong. Open question: does `schema.ts` handle object parameters? LLM tool arguments are
> almost always one structured object, while adorn's constraints look per-parameter-primitive. A
> fundamental mismatch kills it; a gap might be the most valuable thing adorn builds next."

The load-bearing worry is the last one: **the model sends one structured object; adorn constrains
positional primitives.** Is that a fundamental mismatch or a fillable gap?

---

## Verdict: **a fillable gap**, not a fundamental mismatch — proven by the spike

The single structured object an LLM sends maps cleanly onto **a method's named parameter list**, and
adorn already records everything that mapping needs. The mismatch is only in the *shape the current
projection chooses to emit*, not in the data it holds.

The spike defines a realistic tool and captures three real outputs.

### The tool, authored exactly as a user would

```ts
@Contract()
class WeatherTool {
    getWeather(
        @NotEmpty() location: string,
        @Matches(/^(celsius|fahrenheit)$/) unit: string,          // simulating an enum — see the gap below
        @GreaterThanEqual(1) @LessThanEqual(7) days: number,
    ): string { /* ... */ }
}
```

### (1) What `schemaForClass(WeatherTool)` emits **today** — a *positional* tuple

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WeatherTool",
  "type": "object",
  "properties": {},
  "methods": {
    "getWeather": {
      "title": "WeatherTool.getWeather",
      "type": "array",
      "prefixItems": [
        { "type": "string", "minLength": 1 },
        { "type": "string", "pattern": "^(celsius|fahrenheit)$" },
        { "type": "number", "minimum": 1, "maximum": 7 }
      ]
    }
  }
}
```

The method is a `{type:'array', prefixItems:[…]}` — an **argument tuple keyed by position**. No LLM
tool API consumes this shape; they all want a named-property object. This is the mismatch, in the flesh.

Note also: `days` carries **two** constraints (`@GreaterThanEqual(1) @LessThanEqual(7)`) and the
projection has *already merged them* into `{minimum:1, maximum:7}` — the DEC-029 conjunction. Whatever
we build inherits that merge unchanged; there is nothing to re-derive.

### (2) The parameter **names are already in the registry** (`getContractsForClass`)

```json
[
  { "index": 0, "name": "location", "constraints": ["notEmpty"] },
  { "index": 1, "name": "unit",     "constraints": ["matches"] },
  { "index": 2, "name": "days",     "constraints": ["min", "max"] }
]
```

`location`/`unit`/`days`, not `arg0`/`arg1`/`arg2`. This is BUG-14 / `captureSignature` doing its job:
the same names enforcement quotes in a violation message are recorded in the registry (SMELL-1's
minification caveat rides along, *consistently*). The orchestrator's read is confirmed: the name band
is present and populated on the real decorator path.

### (3) The tight tool-object schema is **mechanically constructible** from (1) + (2)

Re-key the tuple fragments from (1) by the names from (2); add `required` + `additionalProperties`.
The spike does exactly this — it reuses the *same fragments the projection already emitted* (including
the `days` merge) and adds only the tight-posture keywords:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WeatherTool.getWeather",
  "description": "Look up a weather forecast.",
  "type": "object",
  "properties": {
    "location": { "type": "string", "minLength": 1 },
    "unit":     { "type": "string", "pattern": "^(celsius|fahrenheit)$" },
    "days":     { "type": "number", "minimum": 1, "maximum": 7 }
  },
  "required": ["location", "unit", "days"],
  "additionalProperties": false
}
```

Spike verdict line: `Names present: true | positional tuple emitted today: true | object view built
purely by re-keying + tightening: true`.

**The gap is one projection function.** Everything it needs — names, indices, per-position merged
fragments — is recorded and read through the existing DEC-012-clean registry API. No new data, no
adapter reach, no descriptor change.

---

## The emitted shape, and where it lives

```
toolSchemaForMethod(C, 'method', { description? })  →
  {
    "$schema": "…2020-12",
    "title": "C.method",
    "description": <tool NL description>,
    "type": "object",
    "properties": { "<paramName>": <merged fragment>, … },
    "required": [ <every param that carries ≥1 constraint> ],
    "additionalProperties": false
  }
```

**A new entry point, not a flag on `schemaForClass`.** `schemaForClass`'s root deliberately *validates
an instance* — fields become `properties`, methods ride under the ignorable `methods` annotation
keyword (DEC-029 point 3). A tool schema's root is a *method's parameters*, and its posture is the
opposite of the instance schema's (below). Overloading one function to emit both a descriptive
instance schema and a prescriptive argument schema would put two contradictory honesty contracts in one
place — precisely the "looks complete, is not" hazard the projection layer exists to avoid. So it is a
sibling function.

**Layering (DEC-012) is unchanged.** `toolSchemaForMethod` reads `getContractsForClass` /
`getEffectiveContract` and `descriptor.schema()` — Core + Contracts only, exactly as `schema.ts` and
`docs.ts` do. It must **reuse `schema.ts`'s `mergeFragments` / `schemaFragmentsOf`** (co-locate it in
`schema.ts`, or export those two internals), never re-implement the merge: forking the conjunction
logic would reopen the descriptor/projection drift DEC-010 closes (the same reason `schema.ts` reads
`descriptor.schema()` directly instead of rebuilding fragments from `params`).

---

## THE CENTRAL TENSION — and its resolution

`schemaForClass` (DEC-029) **under-claims on purpose**: it never emits `required` or
`additionalProperties`, degrades any unknown constraint to `{}` (accept-anything), and always moves
toward *the weaker true statement* so the emitted schema accepts a **superset** of what enforcement
accepts. A tool schema wants the **opposite**: `required` + `additionalProperties:false`, tight enough
to *steer the model and reject hallucinated or missing arguments*.

These are not in conflict, because **they answer different questions for different consumers**:

| | `schemaForClass` (DEC-029) | `toolSchemaForMethod` (proposed) |
|---|---|---|
| Question | "describe a value enforcement will **accept**" | "specify the argument object the producer must **send**" |
| Consumer | a validator checking existing data | a generator (the LLM) being **steered** |
| Failure to avoid | false **rejection** of data adorn accepts | letting the model send an ill-formed call |
| Honest direction | under-claim (superset) | tight (the producer's obligation) |
| Posture | **descriptive** | **prescriptive** |

DEC-029's rule is *"never reject what enforcement accepts"* because its schema is **validated
against**. The tool schema is **generated from** — it is a target the producer is obligated to hit, with
adorn's own `@Contract` enforcement as the runtime backstop for whatever the producer sends anyway. So
the tight direction is not over-claiming against enforcement; it is **aligning the producer's target
with exactly what enforcement will accept.** DEC-029 keeps governing `schemaForClass` untouched; the new
posture governs only the new function. This is a deliberate **new posture — "this schema *is* the
contract the producer must obey"** — living beside DEC-029, not overturning it.

### Where does `required` come from? (Q-10 says arity/optionality is unreliable)

Decision: **`required` = every parameter position that carries at least one constraint descriptor.**
This is not a guess about optionality — it is **backed by enforcement**:

- adorn's built-in predicates are **total** (BUG-4) and reject the missing-argument sentinels: `isNumeric`
  returns `false` for `undefined`/`null` (Q-7), `isText` likewise. So a parameter carrying
  `@GreaterThanEqual(1)` **already throws at runtime when the argument is absent.** Marking it `required`
  therefore matches what enforcement does — it is descriptive of the runtime *for constrained params*,
  and prescriptive for the model. Both readings agree.
- An **undecorated gap position** (a `{}` accept-anything slot between decorated ones) is **not**
  required — adorn asserts nothing about it, so the tool schema asserts nothing either. `required` is a
  faithful subset, self-consistent with the fragments beside it.

The two rejected sources:

- **TS `?` / default values → unrecoverable.** `getParamNames` parses `Function.prototype.toString`
  and cannot see optionality; there is no runtime source for it (Q-10, extended). Not a candidate.
- **An explicit `@Required`/`@Optional` marker →** the right answer *only* for the genuinely-optional
  **but constrained** parameter (a param that carries a bound yet may be omitted). That is a real but
  secondary case; defer it to a record-only marker (Q-28), the twin of how `@Sensitive`/`@Telemetry`
  record plain data into their own bands. Until then "carries a constraint ⇒ required" is the sound
  default.

### Is `additionalProperties:false` honest?

It is the **one** keyword the tool schema asserts that runtime enforcement does not check (a method
silently ignores extra arguments). It is justified *prescriptively*, not descriptively: a method's
named parameter set **is closed**, so an argument the model invents that is not a parameter is not a
valid call, and telling the model so is the entire point of the tight posture. We emit it, and we say
plainly that it is a producer-steering assertion rather than a claim about adorn's runtime — the same
kind of honesty label DEC-028 requires of the sensitive-flow detector's scope report.

---

## The enum gap — `@OneOf` / a reified enum descriptor (highest-value small addition after names)

The spike simulated the `unit` enum with `@Matches(/^(celsius|fahrenheit)$/)`, which emits
`{type:'string', pattern:'^(celsius|fahrenheit)$'}`. Functional — but **`{enum:[…]}` is what LLM
tool-calling wants most**, because several providers *constrain-decode* against an `enum` (the model
literally cannot emit a non-member), whereas a `pattern` is at best a hint. There is today **no**
enum/`oneOf`/object descriptor kind (GAP-14): confirmed across `Contracts/number.ts`,
`Contracts/string.ts`, and `Core/Descriptor.ts` (`ConstraintKind = 'number' | 'string' | 'generic'`,
no membership constraint).

Design a small reified descriptor — `kind: 'generic'` — in `src/Contracts/` (e.g. `enum.ts`):

```ts
export const oneOfConstraint = defineConstraint<{ values: JsonValue[] }>({
    kind: 'generic',
    constraint: 'oneOf',
    derive: params => value => params.values.some(v => Object.is(v, value)),
    describe: params => `one of ${params.values.map(v => JSON.stringify(v)).join(', ')}`,
    schema: params => ({ enum: params.values }),          // exactly what tool schemas want
});
export function OneOf(values: JsonValue[]) { /* validate non-empty, JSON-serialisable */ }
```

`values` is already forced JSON-serialisable by `Descriptor.normalizeParams`. It slots into the model
with zero new machinery — predicate **derived** from params (DEC-010), so schema/docs/enforcement
cannot drift. It pays off in **three** projections at once, for free:

- **schema / tool schema:** `{enum:[…]}`, the native constrained-decoding target.
- **docs:** "one of: `celsius`, `fahrenheit`" — a real improvement over "a string matching /…/".
- **fuzzing (`@adorn/test`):** a **perfectly sound** generator — `fc.constantFrom(...values)`, no
  filtering, no starvation (DEC-031's ideal case), where `matches` needs regex inversion.

Ship it **first** (below). It is the thing tool schemas need most after names, and it stands alone.

---

## Nested objects: recommend the flat parameter-list convention; `$ref` stays deferred

`schema.ts` deliberately builds **no `$ref` graph across classes** ("one class → one self-contained
schema"). For the LLM-tool case that instinct is *more* right, not less:

- **Model a tool as its parameter list** — one property per named parameter. This is how every
  provider's function-calling schema is actually shaped, and it covers the overwhelming majority of real
  tools (primitives, enums, small arrays).
- **A parameter that is itself a structured object:** recommend, for v1, **self-contained inline
  expansion, never `$ref`** — if the parameter's type is another `@Contract`ed class, recurse over that
  class's *field* contracts and inline a nested `{type:'object', properties:{…}}`. Rationale: many
  function-calling endpoints do **not** resolve `$ref`, and every one accepts a self-contained schema.
  The tradeoff — a shared sub-object is duplicated across tools rather than referenced once — is the
  right price for an artifact every provider accepts. `$ref` bundling remains the correct shape for the
  *doc-bundle* output (`serializeSchema` already does `$defs`), which is a different consumer.
- **The real limiter, stated:** adorn records a parameter's *type* only advisorily (`design:paramtypes`,
  which erases interfaces/unions/generics to `Object` and is absent entirely under esbuild — DEC-004).
  So "this parameter is a `WeatherQuery` object" is **not reliably knowable at runtime**. Therefore v1
  should **degrade an unrecognised structured parameter to `{}` (accept-anything)** — honest under-claim,
  consistent with the rest of the projection — and inline-expand only when a `@Contract`ed field class
  is positively identifiable. Reliable nested structure ultimately wants an explicit nested spec on the
  parameter; that is a future extension (Q-29), not a v1 blocker.

For the tools people actually expose to an LLM, **names + enum + primitive bounds is already the whole
schema.**

---

## The tool DESCRIPTION source: `@Tool(description)` + `describe()` default; a `@Describe` param marker deferred

The model reads NL descriptions of the tool and of each parameter. Three candidate sources:

- **JSDoc extraction — rejected for the runtime projection.** adorn is runtime-introspection only
  (DEC-007); JSDoc is erased before runtime, so a runtime projection cannot see it without the
  build-time extractor adorn has repeatedly declined to build (the sensitive-flow spike, Q-16/Q-20,
  rejected exactly this class of build-time source analysis).
- **The descriptor's `describe()` — the honest free default for the *parameter* level.** It already
  yields "a number between 1 and 7", which is a genuine, drift-free constraint description and a fine
  `description` on each property fragment. But it describes the *bound*, not the *meaning* ("the forecast
  horizon in days") — necessary, not sufficient.
- **A decorator argument — recommended for the *tool* level and the semantic *parameter* level.** A
  method marker `@Tool('Look up a weather forecast')` supplies the tool description (or pass it to
  `toolSchemaForMethod(C, m, {description})`); a param's *semantic* description comes from an optional,
  record-only `@Describe('the forecast horizon in days')` marker — the exact twin of `@Sensitive` /
  `@Telemetry.name`: plain data recorded into its own band, DEC-012-clean, installing nothing.

**Recommendation:** v1 = tool description via `@Tool`/entry-point argument, parameter description =
`describe()` (free, honest, already recorded). The semantic `@Describe` param marker is a small additive
follow-up (Q-30), not a v1 blocker — the constraint prose is a usable floor.

---

## The end-to-end payoff, made concrete (the feedback's core claim, verified)

The feedback's strongest point is that a tool needs **two** artifacts that normally drift: the schema
the model reads, and the runtime validation of what the model sends back. adorn already serves the
second half — and from the *same declaration*:

```ts
@GreaterThanEqual(1) @LessThanEqual(7) days: number
```

- **The schema half:** `descriptor.schema()` → `{minimum:1, maximum:7}` → the `days` property the model
  reads and is steered by.
- **The validation half:** the *same* descriptor's `predicate` — **derived from the same `params`**
  (DEC-010) — is installed by `@Contract()` and checks every call. When the model confidently sends
  `{days: 99}`, the schema said `maximum:7` **and** the runtime wrapper throws a violation. One
  declaration; the two artifacts **cannot drift** (DEC-006/DEC-010), by construction, not by discipline.

This is precisely the feedback's *stronger-than-docs* case: the schema's consumer is a machine that
*will* produce malformed arguments, and adorn gives you both the guidance that reduces that and the
enforcement backstop for when it happens anyway — **"one declaration → the schema the model reads AND
the validation its arguments face."** The untrusted-input half is not a thing to build; it *is*
`@Contract` enforcement, which already exists and already reads the same source.

---

## Recommended trackers (proposed numbers; highest live: DEC-047, IDEA-19, GAP-13, Q-27)

- **DEC-048** — *Tool schemas are a prescriptive projection.* A new `toolSchemaForMethod` sibling of
  `schemaForClass`: params-as-object, **tight** (`required` + `additionalProperties:false`), a deliberate
  new posture ("the schema is the contract the producer must obey") coexisting with DEC-029's
  descriptive under-claim because it serves a different consumer. `required` = "carries ≥1 constraint",
  sound because total predicates (BUG-4/Q-7) already reject a missing argument; `additionalProperties:false`
  is an honestly-labelled producer-steering assertion. Reuses `schema.ts` merge internals (no fork,
  DEC-010); Core+Contracts only (DEC-012).
- **IDEA-20** — *The params-as-object tool-call schema projection* (`toolSchemaForMethod(C, 'method')` /
  a `@Tool(description)` method marker). The build target DEC-048 governs.
- **IDEA-21** — *`@OneOf` / reified enum descriptor* (new `generic`-kind constraint whose predicate is
  membership and whose `schema()` emits `{enum:[…]}`). Strengthens schema, docs, and sound fuzzing
  (`fc.constantFrom`, DEC-031) at once.
- **GAP-14** — *No enum/`oneOf`/object descriptor kind exists.* `ConstraintKind` is
  `'number'|'string'|'generic'` with no membership constraint; the concrete gap IDEA-21 fills.
- **Q-28** — *Optional-but-constrained parameters.* v1 rule is "carries a constraint ⇒ required"; an
  explicit record-only `@Optional`/`@Required` marker is the answer for the constrained param that may be
  omitted. TS `?`/default is unrecoverable at runtime (extends Q-10).
- **Q-29** — *Nested-object tool parameters.* Recommend self-contained inline expansion of a `@Contract`ed
  field class; `$ref` stays deferred; unrecognised structured params degrade to `{}`. Blocked on reliable
  parameter-type knowledge (DEC-004).
- **Q-30** — *Semantic parameter descriptions.* `describe()` is the honest v1 default; a record-only
  `@Describe` param marker (twin of `@Sensitive`/`@Telemetry`) supplies the meaning the model wants.

### Build order — what ships first

1. **`@OneOf` enum descriptor (IDEA-21 / GAP-14).** Small, standalone, pays off in three projections
   immediately; the thing tool schemas need most after names.
2. **`toolSchemaForMethod` (IDEA-20 / DEC-048).** Re-keys the existing per-position fragments by the
   registry names, adds `required` + `additionalProperties:false`, tool description via `@Tool`/argument,
   param descriptions from `describe()`. Mechanically small — the spike is most of the algorithm.
3. **Deferred:** nested inline expansion (Q-29), `@Describe` / `@Optional` record-only markers (Q-30/Q-28).

The whole first wave is names (already there) + enum + one re-keying projection. The mismatch the
feedback feared does not exist; the gap it hoped for is small and high-value.
