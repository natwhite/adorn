# adorn

> Decorators **adorn** a function with its contract. One declaration on the signature becomes the JSON Schema
> an LLM reads, the runtime validation its arguments face, JSON Schema, documentation, and observability —
> all descended from a single source, so they **don't drift by construction**, not by discipline.

**Status: released — `0.1.0`, MIT.** `npm i adorn`. The public surface is pinned by a test (`index.ts`
exports **101 values** plus the projection and observation model types); the suite is **1303 tests
across 76 suites**, all green. It is a focused, honestly-scoped `0.1.0`: a working decorator core with method
and field inheritance, closure and reified pre-/postconditions, five in-core projections (docs, JSON Schema,
prescriptive LLM tool schema, observability, privacy review), a safe-by-default redaction runtime, a
build-time sensitive-flow detector, and a CLI. Two opt-in add-ons ship as **subpath exports** — `adorn/otel`
(OpenTelemetry) and `adorn/test` (fuzzing) — each behind an optional peer dependency, so the package root stays
`tslib`-only.

> **Proven against OpenAI, not asserted.** The tool schemas adorn generates are round-tripped through OpenAI's
> live function-calling API (`gpt-4o-mini`, temperature 0): the generated schema is accepted, the model
> returns a tool call, and its arguments validate against **the same declaration** that produced the schema —
> including nested objects, nullable-optional fields, and OpenAI strict mode. Evidence, with the verbatim
> schemas, is in [`docs/q31-capstone-results.md`](docs/q31-capstone-results.md).

---

## The idea

The intent of a function is normally scattered across places that immediately begin to disagree: a runtime
check buried in the body, a schema in a separate file, a sentence in the docs, a hand-written test. Each is
maintained by hand; each drifts.

adorn's wager (DEC-006) is that the contract belongs **on the declaration**, not in the body — lifted up to the
signature where you can *see* it, enforced at the boundary of **every** function that carries one. That is
contract-driven development, and decorators are what make it ergonomic enough to be a paradigm rather than a
chore. A contracted method *is* a tool definition, *is* a schema, *is* its own documentation — because all of
them are read from the one thing you wrote on the signature.

```ts
import {
    Contract, Tool, Describe, NotEmpty, OneOf,
    GreaterThanEqual, LessThanEqual, toolSchemaForMethod,
} from 'adorn';

@Contract()
class WeatherTool {
    @Tool('Look up a weather forecast.')
    getWeather(
        @Describe('the city to look up') @NotEmpty() location: string,
        @OneOf(['celsius', 'fahrenheit']) unit: string,
        @GreaterThanEqual(1) @LessThanEqual(7) days: number,
    ): string {
        // @Contract() has already rejected any call whose arguments violate the same
        // constraints the schema advertises. If the model sends {days: 99} or omits
        // `location`, this body never runs.
        return /* ... */;
    }
}

const parameters = toolSchemaForMethod(WeatherTool, 'getWeather');
```

That one line — `@GreaterThanEqual(1) @LessThanEqual(7) days: number` — is *both* the `{minimum: 1, maximum:
7}` the model is steered by **and** the predicate that throws when the model sends `{days: 99}`. `parameters`
is exactly the object a function-calling API wants:

```json
{
  "title": "WeatherTool.getWeather",
  "description": "Look up a weather forecast.",
  "type": "object",
  "properties": {
    "days":     { "type": "number", "minimum": 1, "maximum": 7 },
    "location": { "description": "the city to look up", "type": "string", "minLength": 1 },
    "unit":     { "type": "string", "enum": ["celsius", "fahrenheit"] }
  },
  "required": ["location", "unit", "days"],
  "additionalProperties": false
}
```

Change `@LessThanEqual(7)` to `@LessThanEqual(14)` and *both* the schema the model reads and the check its
reply faces move together, because there is only one of them, and it lives on the signature.

This is the strongest case for the paradigm, because the consumer of the schema is a machine that produces
malformed input the moment the schema is wrong — a drifted *doc* misleads a human who can compensate; a drifted
*tool schema* silently corrupts every call.

> **Permitted values known only at runtime?** A decorator is fixed when the module loads, so
> `@OneOf(['celsius','fahrenheit'])` works only for a *static* set. When the allowed values are per-call data —
> this session's available slots, this user's account ids — the constraint can't be a decorator. That case is
> first-class, not unsupported: build the same tool schema from descriptors with
> [`toolSchemaFrom`](#working-with-values-directly), and validate the reply with the same descriptors. It's
> common in LLM work; see [Working with values directly](#working-with-values-directly).

| One declaration on the signature produces | Where it ships |
| --- | --- |
| **Runtime validation** — the check that runs on every call | core |
| **Prescriptive tool schema** — the LLM's `parameters` object (`toolSchemaForMethod`) | core |
| **Descriptive JSON Schema** — draft 2020-12 (`schemaForClass`) | core |
| **Documentation** — Markdown generated from the same statement it enforces | core |
| **Observability** — value-free violation & completion facts through a neutral sink | core |
| **Privacy review** — the disclosure each parameter/return carries (`telemetryForClass`) | core |
| **Property-based tests** — `fast-check` inputs derived from the contract | `adorn/test` subpath export (optional `fast-check` peer) |

**Scope — a validator, not a coercion library.** adorn *rejects* an invalid value; it never silently coerces,
defaults, or transforms one. A malformed argument is a violation, not something to degrade into a fallback.

---

## The core trick

A standard TypeScript parameter decorator runs once, at class-definition time, and receives only `(target,
propertyKey, parameterIndex)` — it never sees actual argument values. adorn bridges that gap by splitting the
work in two:

1. **Parameter decorators record.** `@GreaterThanEqual(1)` files its constraint against `(prototype, method,
   parameterIndex)` in a contract registry. It writes nothing to the method itself.
2. **`@Contract()` installs.** A class decorator runs *after* every member decorator, so by then the registry
   holds the whole class. It replaces each contracted method with a wrapper that, on every call, checks the
   recorded constraints against the runtime arguments before delegating.

> #### ⚠ `@Contract()` is required
>
> Parameter constraints **do nothing on their own**. A class that declares them without `@Contract()` is not
> enforced, and is invisible to every projection. Because that failure is silent, adorn emits a
> development-mode warning naming the offending class and methods (off under `NODE_ENV=production`; routable via
> `setContractDiagnosticsSink` / `setContractDiagnosticsEnabled`). `@Validate()` is a per-method alternative
> that also registers the class for projection (DEC-016) — adorn never enforces what it would omit from a
> generated artifact. Prefer class-level `@Contract()`: it installs **outermost**, so guard-before-flow and
> postcondition-on-final-result hold by construction (DEC-043); the per-method form is order-sensitive.

> #### ⚠ Three shapes that surprise new consumers
>
> - **A TypeScript default value is honoured.** `detect(@GreaterThanEqual(1000) timeoutMs = 30_000)` called
>   as `detect()` uses the default rather than throwing — adorn treats any parameter at or after the first
>   defaulted one as optional, so an omitted (or explicitly `undefined`) argument is not validated as
>   `undefined` (a default is compiled into the body, which runs *after* the wrapper). The one exception is a
>   *required* parameter placed **after** a defaulted one (`f(a, b = 1, c)`), a signature TS lint discourages;
>   mark it `@Optional()`/`@Default()` explicitly if you must write it.
> - **Constructor parameters can't carry decorators** (TS1239 — a constructor's `propertyKey` is `undefined`,
>   which the decorator signature rejects). Validate at construction with a **static factory**: a
>   `static of(...)` decorated with `@Validate()` that returns `new`; a private constructor then makes the
>   validated path the only path.
> - **A `static #private` member blocks a class decorator** (TS18036 — TypeScript's own limitation, though the
>   error blames the decorator). Move the static private to module scope, or use `@Validate()` per method.
>   Instance `#private` members are fine.

Constraints evaluate in **declaration order** — parameters left to right, stacked decorators top to bottom
(DEC-015/017). When several arguments are invalid, the first one in the signature is the one reported.

### Why a decorator can become five artifacts: constraints are data

The load-bearing move is that a constraint is **not an opaque closure that throws** — it is a *reified
descriptor*: an identity plus JSON-serialisable params, with the predicate **derived** from those params
(DEC-010). `@GreaterThanEqual(1)` is literally a thin `@`-syntax adapter over that descriptor. Derivation is
what lets one decorator project into a schema keyword, a docs line, a fuzzer generator, and the runtime check —
none of which can disagree, because they are all read from the same recorded data. The paradigm rests on this:
the decorator is the ergonomic surface; the reified descriptor underneath is why it can be more than a check.

> Those descriptors are also exported directly (`NumberContracts.Between(1, 10)`, `Verify.check(...)`,
> `toolSchemaFrom({...})`) for the handful of places a decorator can't reach — validating a raw `unknown` off
> the wire where there is no signature to annotate, or a schema whose enum is known only at session start.
> These are the **escape hatch, not the front door**: the paradigm is the decorator on the signature. See
> [Working with values directly](#working-with-values-directly).

---

## What's included

The public surface groups by what it constrains or produces. Everything below is exported from `index.ts`.

### Parameter constraints

Numeric: `GreaterThan` · `GreaterThanEqual` · `LessThan` · `LessThanEqual` · `Between` · `Integer` ·
`MultipleOf`. String length and pattern: `StringMinLength` · `MinLength` · `MaxLength` · `NotEmpty` ·
`Matches` · `Email` · `Url`. Every predicate is **total** (a `null`/`NaN`/wrong-type argument reports a
contract violation, never a bare `TypeError`) — which matters because a fuzzer feeds it those first and a
schema claims a `type` on the strength of it (BUG-4).

- **`@OneOf([...])`** — a reified enum/membership constraint, type-agnostic. Projects to `{enum: [...]}`, the
  LLM constrained-decoding target several providers honour; strict `===` membership.
- **`@Const(value)`** — the single-literal sibling of `@OneOf` (DEC-056): projects to `{const: value}`.
- **`@ArrayOf(item, {minItems?, maxItems?})`** — the first **compositional** constraint (DEC-050): a list whose
  every element satisfies an inner descriptor, carried as serialised data. Projects to `{type:'array', items:
  <item fragment>, …}`, nests, and round-trips through JSON.
- **`@Dictionary(value)`** — an **open** map (`Record<string, V>`, DEC-054): arbitrary string keys, every value
  satisfying an inner descriptor. Projects to `{type:'object', additionalProperties: <value fragment>}`.
- **`@Shape(FieldClass)`** — a **closed** DTO (DEC-055) validated against another class's `@Contract`ed
  instance fields. `toolSchemaForMethod` tightens it recursively (`required` = every field,
  `additionalProperties: false`), descending array items and dictionary values.
- **`@Nullable(item)`** — a compositional combinator (DEC-056) widening any constraint to also accept `null`,
  distinct from `@Optional`'s "may be absent". Stays *required* in a tool schema (the model must send a value
  or explicit `null`).
- **String formats** — `@Uuid` · `@DateTime` · `@Ipv4`, and `@Format(name)` as a keyed alias (DEC-052). Each
  is a **validating** descriptor whose predicate is at-least-as-strict as the `format` keyword it emits, so the
  schema never over-claims (DEC-029). `date-time` uses strict RFC-3339 with real-calendar validation, not
  `Date.parse`.

> `@Positive()` / `@Negative()` / `@NonNegative()` / `@NonPositive()` were **removed** (DEC-020) — a name can't
> carry a boundary. Write the boundary you mean: `@GreaterThan(0)`, `@LessThan(0)`, etc.

### Field constraints

`Enforce` installs an accessor that validates on assignment (`Enforce.greaterThan(0)`);
`CreateFieldDecorator(descriptor)` builds a field decorator over any descriptor; `installFieldContracts(ctor)`
is the imperative installer. Field constraints are **inherited**: a subclass's field is checked against the
union of every declaration on its prototype chain, and may only *strengthen*, never weaken (DEC-021).

### Markers (record-only)

- **`@Optional` / `@Default(value)`** (DEC-051) — enforcement-aware. `@Optional` makes an *absent*
  (`undefined`) argument satisfy the position (dropped from the tool schema's `required`); `@Default`
  annotates a JSON default and implies `@Optional`. Inheritance is **required-wins** (DEC-016/022).
- **`@Describe('…')` / `@Tool('…')`** (DEC-052) — pure annotation. `@Describe` is the sole source of a
  property's `description`; `@Tool` is the method/tool description. Both flow into docs.

### Contracts, pre- and postconditions

`Contract()` (class) / `Validate()` (method) install enforcement and register for projection.

- **`@Ensures((result, ...args) => boolean, description?)`** — a **closure** postcondition (DEC-032): fully
  general, but enforced-but-unprojectable (a closure carries no identity).
- **`@Returns(<descriptor>)`** — a **reified** postcondition (DEC-033): checked by the same predicate machinery
  preconditions use *and* emitted into docs and schema. Coexists with `@Ensures`.
- **`@Requires((...args) => boolean, description?)`** — the input-side twin (DEC-057): a **closure**
  cross-parameter precondition (`start < end`) checked before the call, blaming the caller. Like `@Ensures`,
  enforced-but-unprojectable.

`evaluatePostconditions` / `evaluatePreconditions` are exported because they are the *same* oracles the runtime
wrapper runs — a fuzzer checking them checks exactly what enforcement enforces, with no drift.

### Method decorators

`Log()` logs each call (safe-by-default redaction below). `Time()` measures duration, including async and
Observable-like returns (`setTimingSink(fn)` routes it). `Observe()` opens an observation span over the O1 seam
carrying a declared `SpanKind`.

### `@Sensitive` / `@Telemetry` and safe-by-default redaction

`Sensitive()` marks a field, parameter, or class as holding sensitive data (record-only). The **redaction
runtime** (DEC-030) makes it matter: every path adorn can emit a value through — `@Log`, violation messages,
observation events — renders `[REDACTED]` **by default, without reading any annotation**.
`setValueDisclosure('all')` turns raw values back on for local debugging; a `@Sensitive` marking *vetoes* even
that (and the veto is surfaced, not silenced). The safe default holds with zero `@Sensitive` anywhere — the
annotation is defence-in-depth. `Telemetry.value()` / `.redact(strategy)` / `.result()` opt a value *into*
disclosure on the observation path. See [`docs/sensitive.md`](docs/sensitive.md).

### Enforcement and disclosure configuration

Each contract is classified by **trust** (DEC-008): `guard` (default) validates untrusted input and survives
production (only `disableGuardEnforcement({confirm, reason})` strips it); `assert` is an internal self-check,
stripped in production. `setEnforcementMode` · `setAssertEnforcement` · `setDefaultTrust` ·
`enableGuardEnforcement` · `disableGuardEnforcement` tune the gate; `setViolationPolicy('throw' | 'warn' |
handler)` routes what happens on a violation (`'warn'` proceeds into the method, which is what makes staging a
new contract over live traffic possible); `setObservationVerbosity`, `setValueDisclosure` / `getValueDisclosure`,
and `setContractDiagnosticsEnabled` / `setContractDiagnosticsSink` / `flushContractDiagnostics` round it out.

> **This family is process-level, set-once-at-startup configuration** — not per-request state. Set at boot,
> it is safe under concurrency; mutating it per request in a shared process would change other in-flight
> calls, so don't. If you need *divergent policy per concurrent context* (one request `throw`, another
> `warn`), that is not expressible today — a known limitation. The data-first core you'll reach for most —
> the constraint decorators, the `*Contracts` descriptors, and `Verify.check` — is pure and carries no
> ambient state, so it is concurrency-safe regardless.

### Registry introspection (semver-frozen read surface)

The `getContracts` / `getContract` / `getContractedClasses` / `getFieldContract(s)` family answers *"what does
this class declare?"*; the `getEffective…` family (`getEffectiveFieldConstraints` /
`getEffectiveParameterConstraints` / `getEffectivePostconditions` / …) answers *"what is in force here?"* — the
union of every declaration on the prototype chain, which is what enforcement applies and a projection should
render. This read surface is the semver-frozen public API (DEC-039, pinned by `test/public-surface.test.ts`);
the registry's *writers* are deliberately not exported (they would bypass the adapter that owns ordering and
installation).

### Projections

The same registry read feeds every projection:

- **Docs:** `documentClass` · `documentContracts` → `renderMarkdown` · `generateMarkdown`.
- **JSON Schema (draft 2020-12), descriptive:** `schemaForClass` · `schemaForContracts` →
  `serializeSchema` · `generateSchema`. Degradation always goes toward the *weaker* true statement — an
  over-claiming schema is worse than none (DEC-029).
- **Tool schema, prescriptive:** `toolSchemaForMethod(Class, 'method', {description?, providerStrict?})` — the
  flagship above (`providerStrict` emits [OpenAI strict mode](#openai-strict-mode)). A sibling of
  `schemaForClass`, not a flag on it: `schemaForClass` under-claims (describe a value enforcement will
  *accept*), `toolSchemaForMethod` is tight (specify the object the producer must *send*; `required` +
  `additionalProperties: false`).
- **Telemetry / privacy review:** `telemetryForClass` · `telemetryForContracts` → `serializeTelemetry` ·
  `generateTelemetryReport`. A pure registry read reporting the disclosure each parameter/return carries.

The projection model types (`ClassDoc`, `MethodDoc`, `ToolSchema`, `TelemetryReport`, …) are exported so a
consumer can type a variable holding one.

Three deliberate shape decisions the tool schema makes: **no `$schema`** (a `parameters` sub-schema, not a
standalone document — DEC-049; `schemaForClass` still emits it); **`required` = "carries ≥1 constraint" minus
`@Optional`** (sound, because adorn's predicates are total — a missing argument already fails at runtime — so
`required` matches enforcement; DEC-048/051); **`additionalProperties: false`** (a method's parameter set is
closed — the one keyword the tool schema asserts that runtime enforcement doesn't itself check, labelled
honestly as producer-steering; DEC-048).

### Observability (O1)

A neutral, zero-dependency observation seam (DEC-035/036/037). `setObservationSink` / `getObservationSink`
install one around-shaped `ObservationSink`; the enforcement weave emits **value-free violation facts** and
completions through it, and `@Observe` emits completions carrying pre-disclosed values (redacted by default —
*"seeing ≠ emitting"*). `settle` is the shared sync/thenable/observable settling classifier; `RETURN_INDEX`
marks the return value; `nextCallId` is the one shared correlation-id sequence a consumer's own emitter draws
from (below); `consoleObservationSink` is a ready-made opt-in JSON-to-console sink. The event union
(`ObservationEvent`, `ViolationFacts`, `EmittedValue`, `Settlement<T>`, …) is exported and additive.

**Emitting without decorators.** The stream isn't decorator-only — a functional codebase (no classes to
`@Observe`) emits point events straight to the installed sink, the observation analog of `Verify.check`:

```ts
import { getObservationSink, nextCallId } from 'adorn';
import type { Observation } from 'adorn';

const observation: Observation = {
    owner: 'reminders', member: 'schedule', name: 'reminders.schedule',
    isStatic: false, detail: 'always', kind: 'internal', parameters: [],
};
getObservationSink().record?.({
    kind: 'completed', observation, callId: nextCallId(),
    durationMs: 12, outcome: 'returned', settled: true,
    // startedAt?: number   — position a retroactive interval (epoch ms)
    // parentCallId?: number — nest it under another call's span
});
```

Draw the `callId` from **`nextCallId()`** — the one shared, monotonic sequence adorn's own wrappers use — so
your ids never collide with adorn's (a sink may key per-call state by `callId`, e.g. `createOtelSink`'s span
nesting). For an interval you *time* rather than *wrap*, add **`startedAt`** (epoch ms) so the sink can
*position* the span, and **`parentCallId`** to *nest* it: a record-only sink can then build a full waterfall
tree with no context manager.

`record` is the fire-and-forget point-event surface (`completed` / `violation` / `message`); `scope` is the
around-wrapper for span nesting. **If you drive `scope` yourself, mind the lifecycle:** `scope` *opens* the
span, but its correlated `completed` event *ends* it — matched by `callId` (DEC-047). Do **not** end the span
inside `scope`, or every async span is flat (it closes before the promise settles). Because `createOtelSink`
maps *only* the public `ObservationSink`, a well-formed event you emit this way becomes an OTel span/metric with
no decorator in sight. It's a documented pattern rather than a one-call helper (a blessed emitter may follow if
it proves common).

---

## OpenAI strict mode

OpenAI's [strict function calling](https://platform.openai.com/docs/guides/function-calling) requires that
**every** property appear in `required` and `additionalProperties: false` be set at **every** object level —
not just the root. Pass `{ providerStrict: true }` to the decorated flagship (or to `toolSchemaFrom`) and adorn
emits a strict-compatible schema, proven end-to-end against the live API in the capstone above:

```ts
const parameters = toolSchemaForMethod(ScheduleTool, 'remind', { providerStrict: true });
```

The rule strict mode forces is *nullability-in-the-declaration* (DEC-068/069/071): because strict mode forbids
a truly-absent property, an "optional" field is instead declared `@Nullable(...)` and sent as `null` — so one
recursive pass promotes it into `required` at its own object level, and schema and validator both accept the
model's `null` with no drift. A bare non-nullable `@Optional` parameter or an open `@Dictionary` map (which
strict mode cannot express) is refused at build time with an actionable, decorator-flavoured message instead of
a silent 400 from the API.

---

## Working with values directly

Not everything is a function you can decorate. A raw `unknown` arriving from `JSON.parse` at an HTTP boundary
has no signature to annotate; a tool schema whose enum is known only at session start can't be fixed at module
load; a codebase may have zero classes at all. For those cases the same reified descriptors are available as
plain data — for validation, schema, **and enforcement**. This is the escape hatch; the paradigm is still the
decorator on the signature, and each of these is a decorator's job available as a function.

- **`Verify.that(descriptor, name, value)`** throws on a violation; **`Verify.check(...)`** returns a
  discriminated `CheckResult` instead (DEC-053) — the non-throwing path for a boundary that needs the failure
  as a *value* (an HTTP 400) rather than an exception. Since DEC-059 both **narrow** `unknown` to the
  constraint's output type, and `Verify.check` reports the failing key on `path` (DEC-060).
- **`contract(spec, fn)`** — the functional twin of `@Contract` / `@Requires` / `@Ensures` / `@Returns` /
  `@Observe` (DEC-074): wrap a plain function with `{params, requires, ensures, returns, observe}` from
  descriptors, no class or decoration point. It runs the *same* precondition/postcondition oracles the
  decorators do (no drift), settles an async result before the return band, and — with `observe` set — emits
  `completed`/`violation` events to the installed sink. This is the fourth of four decorator jobs available as
  a function, so a zero-class codebase can adopt the enforcement layer whole.
- **`violationFromCheck(result, {parameter?})`** — turn a failed `check` into `ViolationFacts` (DEC-074), so a
  functional refusal emits as a `violation` event on the same stream the decorator weave feeds (and that
  `adorn/otel` maps). One observability stream, decorator or not.
- **`toolSchemaFrom({params: {...}})`** builds the same prescriptive schema from named descriptors rather than
  from a decorated method, for a per-session schema; it takes the `{providerStrict}` option described above.
- **`defineConstraint({...})`** builds a first-class reified constraint from data, so a constraint you define
  yourself projects into schemas and `Verify` exactly like a built-in.
- The descriptor namespaces themselves — `NumberContracts` · `StringContracts` · `EnumContracts` ·
  `ArrayContracts` · `ObjectContracts` (incl. `ObjectContracts.Fields({...})`, the optional-aware object
  literal) · `NullableContracts` — feed all of the above.

---

## Projections and the CLI

The projections are functions; the `adorn` CLI is their delivery vehicle:

```bash
adorn docs   [--out <file>] <entry...>   # Markdown documentation projection
adorn schema [--out <file>] <entry...>   # JSON Schema projection (draft 2020-12)
adorn check  <tsconfig-or-globs...>      # report @Sensitive values reaching an adorn emitter
```

`docs` and `schema` **load then project** (DEC-007): they `require` each entry so its decorators execute and
populate the registry, then walk it — so loading *executes* the module, side effects and all. A `.ts` entry is
run through `ts-node`, which the CLI lazily requires: for `.ts` entries you need `ts-node` and `typescript`
installed in your project (they are not runtime dependencies of adorn). `check` is **static** — it builds a
`ts.Program`, runs the sensitive-flow detector, and never executes your code (non-zero exit on a leak).

### The sensitive-flow detector

`tools/sensitive-flow/` is build-time tooling — an ESLint rule (`no-sensitive-to-adorn-sink`) over a shared
analysis core. It reports where a `@Sensitive` value reaches one of adorn's **own** emitters, following the
value through same-function aliases, template interpolation, and destructuring (DEC-028). It is
**report-only, permanently**, prints its own scope on every run, and states its two limits plainly rather than
chasing them: `s.ssn.slice(-4)` is caught by nothing (a regulatory judgement, not a library's), and adorn
secures *its own* emissions only — a raw `console.log` of a sensitive value is yours (DEC-025).

---

## Getting started

### Install

```bash
npm i adorn
```

The only runtime dependency is `tslib`. The package ships CommonJS with `.d.ts` types through its `exports`
map, plus the `adorn` `bin`.

### Enable decorators

The `@`-decorator paradigm requires TypeScript with `experimentalDecorators` and `emitDecoratorMetadata`:

```jsonc
// tsconfig.json
{ "compilerOptions": { "experimentalDecorators": true, "emitDecoratorMetadata": true } }
```

`reflect-metadata` is **not** required — adorn feature-detects it and degrades honestly when absent (its only
effect is filling a `Type` column in generated docs from `design:paramtypes`). Node.js 20.19+ is supported (CI
runs on 20.19 / 22 / 24). A note on toolchains: the decorator authoring path needs the two flags above, which
constrains you to a metadata-emitting compiler (`tsc` / ts-jest / ts-node); esbuild/SWC/Vite/Bun don't emit
that metadata (DEC-004).

### Build from source (contributors)

```bash
npm install
npm run build      # tsc -> ./dist, then the CLI build (tsconfig.cli.json)
npm test           # jest — 72 suites, 1223 tests
npm run typecheck  # tsc --noEmit over src, tests, addons, tools (tsconfig.test.json)
npm run demo       # ts-node examples/demo.ts — a genuine install smoke test
```

adorn is pinned to **TypeScript 6.0.3** for the build — the highest version the toolchain supports, because
ts-jest has no TS 7 release yet (DEC-013). The shipped `.d.ts` compile cleanly under a consumer's
`strict: true` (DEC-070).

### Examples

Runnable, self-contained scripts covering each capability — the LLM tool paths, `contract()`, boundary
validation, the projections, observability, and redaction — live in [`examples/`](examples/README.md). Each
is `npx ts-node examples/<file>.ts`.

---

## Add-ons — the `adorn/otel` and `adorn/test` subpath exports

Both ship in the package as **opt-in subpath exports** (DEC-073): built into `dist`, reachable as `adorn/otel`
and `adorn/test`, but importing the package root (`require('adorn')`) never pulls them — the core runtime
dependency stays `tslib` alone, asserted by the isolation tests. Each declares its heavy dependency as an
**optional peer** you install only when you use that entry point.

- **`adorn/test`** — `import { fuzzClass } from 'adorn/test'`. Property-based testing that derives `fast-check`
  generators from constraint descriptors. Its rule is **sound generation**: produce only inputs the contract
  accepts, or *decline* and say so (DEC-031). Phase B consumes the *same* functions enforcement runs, so the
  oracle flags an input exactly when the enforced wrapper throws — an executably-pinned no-drift property.
  Optional peer: `fast-check`.
- **`adorn/otel`** — `import { createOtelSink } from 'adorn/otel'`. An OpenTelemetry `ObservationSink`
  (DEC-046): `createOtelSink()` maps `scope` → an active span, `completed` → a duration histogram, `violation`
  → `recordException` + a value-free span event; install it with `setObservationSink(createOtelSink({...}))`.
  Optional peer: `@opentelemetry/api`.

---

## Project state

### Working

- Parameter-constraint decorators (numeric, string, `@OneOf`/`@Const` membership, `@ArrayOf` arrays,
  `@Dictionary` open maps + `@Shape` closed DTOs, the `@Nullable` combinator, `@Uuid`/`@DateTime`/`@Ipv4`/
  `@Format` formats), the reified descriptor model, and the `@Contract()` / `@Validate()` installer.
- Field decorators with inheritance — a subclass strengthens, never weakens (DEC-021).
- Method-parameter inheritance — an overridden method inherits its parent's preconditions (DEC-022).
- Postconditions — `@Ensures` (closure), `@Returns` (reified + projectable), the shared oracle.
- Cross-parameter preconditions — `@Requires` (DEC-057), enforced before the call, caller-blamed.
- Enforcement-aware `@Optional` / `@Default` and record-only `@Describe` / `@Tool`.
- `@Log()`, `@Time()`, `@Observe()`.
- Five in-core projections: Markdown docs, descriptive JSON Schema, prescriptive tool schema
  (`toolSchemaForMethod`, incl. OpenAI strict mode via `{providerStrict}` on both entries — DEC-071),
  observability (O1 sink), privacy-review telemetry.
- `@Sensitive` / `@Telemetry` plus safe-by-default redaction.
- Build-time sensitive-flow detector, and the `adorn` CLI (`docs` / `schema` / `check`).
- The descriptor escape hatch — `Verify.that`/`Verify.check`, `toolSchemaFrom`, `defineConstraint`, and the
  `*Contracts` namespaces — for boundaries a decorator can't reach.

### Validated against OpenAI

The generated tool schemas round-trip through OpenAI's live function-calling API — schema accepted, model
returns a tool call, arguments validate against the same declaration — across nested objects, nullable-optional
fields, and strict mode. Method and offline evidence: [`docs/q31-results.md`](docs/q31-results.md),
[`docs/q32-results.md`](docs/q32-results.md), [`docs/q31-capstone-results.md`](docs/q31-capstone-results.md).

### Roadmap / next

- The add-ons now ship as `adorn/otel` / `adorn/test` **subpath exports** (DEC-073). Promoting either to its
  own top-level `@adorn/*` package later remains an option, but is no longer required to consume them.
- Consumer-facing JSDoc on the source declarations, so guidance survives into `dist/index.d.ts`; and
  string-format `fast-check` arbitraries (the fuzzer currently *declines* on formats).
- **A TC39 Stage-3 decorators adapter** (`adorn/stage3`) beside the legacy one, recording into the same Core
  model (DEC-040) — the successor to `experimentalDecorators`, so the paradigm survives the language's
  decorator transition.
- **The add-on ecosystem** (DEC-041/042): `@adorn/rx`, `@adorn/cache`, `@adorn/policy`, and a flow-control
  family (`@adorn/resilience`, `@adorn/limit`, `@adorn/idempotency`) — deliberately kept out of core.

### Known rough edges

- **Parameter names come from `Function.prototype.toString()`.** Minification degrades them (`message` → `s`),
  and that propagates into generated documents and schemas. Enforcement and every projection degrade
  *together* — a schema saying `s` about a check saying `s` beats one saying `arg0` about a check saying `sku`
  (SMELL-1).
- **Arity is lost.** A wrapped method reports `length === 0` (its `.name` is correct); destructured/rest
  signatures can misalign recovered names (Q-10) — which is why a faithful OpenAPI path emitter is still
  blocked.
- **Closures can't be projected.** `@Ensures` / `@Requires` are enforced but invisible to docs, schema, and
  fuzzing (a `@Requires`-only method emits an empty tool schema). `@Ensures` types its `result` as `unknown`,
  so under `strict` the author must annotate.
- **`strict: false` is still set** in the *library's own* build; the zero-cost sub-flags are on. This does
  **not** affect consumers — the shipped `.d.ts` compile under `strict: true` (DEC-070).
- **The `@Sensitive` primitive-parameter gap is permanent.** `transfer(ssn: string)` must be marked on the
  parameter; JavaScript's value semantics destroy the link to a `@Sensitive` field (DEC-PII-5). A method
  *return* likewise can't be directly `@Sensitive`; `@Telemetry.result()` gives the opt-in half, the veto half
  needs class-level `@Sensitive`.

For the full picture, [`docs/DECISIONS.md`](docs/DECISIONS.md) is the decision log (DEC-001…DEC-070) and
[`CHANGELOG.md`](CHANGELOG.md) tracks releases.

---

## License

[MIT](LICENSE). Copyright © 2026 natwhite.
