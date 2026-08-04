# adorn

> TypeScript decorators that treat a contract as **data** — one declaration, projected into the JSON Schema an LLM reads, the runtime validation its arguments face, documentation, generated tests, and observability. They descend from one source, so they cannot drift.

**Status: experimental, but substantial.** adorn is not a released package and still has named rough edges (see [Project state](#project-state)), but it is well past a prototype. `index.ts` exports **85 values** (plus the projection and observation model types) across **58 test suites / 1061 tests**, all passing. The shipped set includes a working decorator core with method and field inheritance semantics, closure and reified postconditions, six projections (docs, JSON Schema, prescriptive tool schema, property-test generation, observability, privacy review), a safe-by-default redaction runtime, a build-time sensitive-flow detector, a CLI, and two add-ons (`@adorn/test`, `@adorn/otel`). Treat it as a proof of concept you can read and run, not something to depend on in production.

---

## The thesis

The intent of a method or a field is normally scattered across places that immediately begin to disagree: a runtime check in the body, a schema in a separate file, a sentence in the docs, a hand-written test. Each is maintained separately; each drifts.

adorn's goal (DEC-006) is that a **single contract declaration** is the source all of those descend from. The strongest case is **LLM tool-calling**.

Every tool a project exposes to an LLM needs two artifacts that normally drift: the **JSON Schema the model reads** (so it emits well-formed arguments), and the **runtime validation of what the model sends back** (untrusted input in the strictest sense — a machine that will confidently produce malformed arguments if the schema is wrong). In adorn these are not two artifacts to keep in sync — they are one declaration:

```ts
@GreaterThanEqual(1) @LessThanEqual(7) days: number
```

- The **schema half**: `toolSchemaForMethod(...)` reads this descriptor's `schema()` → `{minimum: 1, maximum: 7}`, the `days` property the model is steered by.
- The **validation half**: the *same* descriptor's predicate — **derived from the same params** (DEC-010) — is installed by `@Contract()` and checks every call. When the model confidently sends `{days: 99}`, the schema said `maximum: 7` **and** the runtime wrapper throws a violation.

One declaration; the two artifacts cannot drift (DEC-006/DEC-048), by construction rather than by discipline. This is a *stronger* case than documentation generation, because the consumer is a machine that produces malformed input on a wrong schema — a drifted doc merely misleads a human who can compensate.

The same declaration projects into every other artifact:

| The declaration produces | Status |
| --- | --- |
| **Runtime validation** — the check that runs on every call | shipped |
| **Prescriptive tool schema** — `toolSchemaForMethod`, the LLM's `parameters` object | shipped |
| **Descriptive JSON Schema** — draft 2020-12, `schemaForClass` | shipped |
| **Documentation** — Markdown generated from the same statement it enforces | shipped |
| **Tests / fuzzing** — inputs derived from the contract, checked against its guarantees | Phase A + B shipped (`@adorn/test`) |
| **Observability** — value-free violation telemetry through a neutral sink | shipped (O1) |
| **Privacy review** — what disclosure each parameter/return carries | shipped (`telemetryForClass`) |

The load-bearing consequence is that a constraint is not an opaque closure that throws — it is a **reified descriptor**: an identity plus JSON-serialisable params, with the predicate *derived* from those params (DEC-010). Derivation is what makes enforcement and every generated artifact unable to disagree.

---

## LLM tool-calling

A contracted method *is* a tool definition. `toolSchemaForMethod(C, 'method', {description?})` emits the tight, prescriptive `parameters` object an OpenAI/Anthropic function-calling API wants, and the same `@Contract()` on the class validates the arguments the model returns.

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
        // @Contract() has already rejected any call whose arguments violate
        // the same constraints the schema below advertises. If the model sends
        // {days: 99} or omits `location`, this body never runs.
        return /* ... */;
    }
}

const schema = toolSchemaForMethod(WeatherTool, 'getWeather');
```

`schema` is exactly what you hand a provider as a tool's `parameters`:

```json
{
  "title": "WeatherTool.getWeather",
  "description": "Look up a weather forecast.",
  "type": "object",
  "properties": {
    "days":     { "type": "number", "minimum": 1, "maximum": 7 },
    "location": { "description": "the city to look up", "type": "string", "minLength": 1 },
    "unit":     { "enum": ["celsius", "fahrenheit"] }
  },
  "required": ["location", "unit", "days"],
  "additionalProperties": false
}
```

Three deliberate shape decisions:

- **No `$schema`.** A prescriptive tool schema is a `parameters` sub-schema handed to a function-calling provider, not a standalone JSON-Schema document — several providers reject unknown top-level keys — so the dialect anchor is omitted (DEC-049). `schemaForClass`, which *is* a standalone document, still emits `$schema`.
- **`required` = "carries ≥1 constraint" (minus `@Optional`).** This is sound, not a guess about optionality: adorn's predicates are *total* (a missing `undefined` argument already fails `@GreaterThanEqual(1)` at runtime — BUG-4/Q-7), so marking a constrained parameter `required` matches what enforcement does. `@Optional()` / `@Default()` drop a parameter from `required` **and** teach enforcement to accept its absence, so schema and runtime move together (DEC-051).
- **`additionalProperties: false`.** A method's named parameter set is closed, so an argument the model invents is not a valid call. This is the one keyword the tool schema asserts that runtime enforcement does not itself check — labelled honestly as a producer-steering assertion (DEC-048).

`@OneOf([...])` emits `{enum: [...]}` — the native constrained-decoding target several providers honour (the model literally cannot emit a non-member). `@Describe('…')` supplies the semantic meaning the model reads on each property; `@Tool('…')` (or the `{description}` option, which overrides it) supplies the tool-level one.

Note the **two postures**, which are complementary rather than contradictory (DEC-029/DEC-048):

| | `schemaForClass` (descriptive) | `toolSchemaForMethod` (prescriptive) |
| --- | --- | --- |
| Question | "describe a value enforcement will **accept**" | "specify the argument object the producer must **send**" |
| Consumer | a validator checking existing data | a generator (the LLM) being **steered** |
| Failure to avoid | falsely **rejecting** data adorn accepts | letting the model send an ill-formed call |
| Honest direction | **under-claim** (a superset; degrade toward `{}`) | **tight** (`required` + `additionalProperties: false`) |

---

## The core trick

A standard TypeScript parameter decorator runs once, at class-definition time, and receives only `(target, propertyKey, parameterIndex)` — it never sees actual argument values. adorn bridges that gap by splitting the work in two:

1. **Parameter decorators record.** `@StringMinLength(10)` files its constraint against `(prototype, method, parameterIndex)` in a contract registry. It writes nothing to the method itself.
2. **`@Contract()` installs.** A class decorator runs *after* every member decorator, so by then the registry holds the complete picture for the whole class. It replaces each contracted method with a wrapper that, on every call, checks the recorded constraints against the runtime arguments before delegating to the original.

```ts
import {Contract, StringMinLength, GreaterThanEqual, LessThanEqual} from 'adorn';

@Contract()
class Task {
    test(
        @StringMinLength(10) message: string,
        @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number,
    ) {
        // If message is too short, or someNumber is out of range,
        // an Error is thrown before this body runs.
    }
}
```

> #### ⚠ `@Contract()` is required
>
> Parameter constraints **do nothing on their own**. A class that declares them without `@Contract()` is not enforced, and is also invisible to any documentation, schema, tool schema, or fuzzing generated from the registry.
>
> Because that failure is silent, adorn emits a development-mode warning naming the offending class and methods. It is off under `NODE_ENV=production` and can be routed or silenced with `setContractDiagnosticsSink` / `setContractDiagnosticsEnabled` — though silencing it does not make the contracts work.
>
> `@Validate()` is available as a per-method alternative when annotating the whole class is not wanted. Since DEC-016 it **also** registers the class for projection: adorn never enforces at runtime what it would omit from a generated artifact.
>
> **Why the annotation exists at all:** an earlier design made the wrapper stick by monkey-patching the global `Object.defineProperty`, because `tslib`'s `__decorate` re-applies the pre-decoration method descriptor and would otherwise discard the wrapper. A parameter decorator's return value is ignored by the language, so there was no other way. Moving installation to a class decorator removes the patch entirely — and is the same shape a standard-decorators (TC39) adapter will need (DEC-040).
>
> Prefer the class-level `@Contract()`: because it installs **outermost**, guard-before-flow-control and postcondition-on-final-result hold by construction (DEC-043). The per-method `@Validate()` form is order-sensitive.

Constraints evaluate in **declaration order**: parameters left to right, stacked decorators top to bottom (DEC-015/DEC-017). When several arguments are invalid, the first one you would read in the signature is the one reported.

---

## What's included

The public surface groups by what it constrains or produces. Every category below is exported from `index.ts`.

### Parameter constraints

Numeric: `GreaterThan` · `GreaterThanEqual` · `LessThan` · `LessThanEqual` · `Between` · `Integer` · `MultipleOf`. String length and pattern: `StringMinLength` · `MinLength` · `MaxLength` · `NotEmpty` · `Matches` · `Email` · `Url`. Every predicate is **total** (a `null`/`NaN`/wrong-type argument reports a contract violation, never a bare `TypeError`), which matters because a fuzzer feeds it those inputs first and a schema claims a `type` on the strength of it (BUG-4).

- **`@OneOf([...])`** — a reified enum/membership constraint, type-agnostic (DEC-049). Projects to a JSON Schema `{enum: [...]}` — the LLM constrained-decoding target — plus a real docs line and a sound `fc.constantFrom` fuzzer. Predicate is strict `===` membership.
- **`@ArrayOf(item, {minItems?, maxItems?})`** — the first **compositional** constraint (DEC-050): a list whose every element satisfies an inner descriptor, carried as serialised data and rebuilt once. Projects to `{type: 'array', items: <item fragment>, minItems?, maxItems?}`, inheriting the item's own fragment, and fuzzes via a recursive `fc.array`. Nests (`@ArrayOf(ArrayContracts.ArrayOf(...))`) and round-trips through JSON.
- **String formats** — `@Uuid` · `@DateTime` · `@Ipv4`, and `@Format(name)` as a keyed alias over them (DEC-052). Each is a **validating** descriptor (never annotate-only): the predicate is at-least-as-strict as the `format` keyword it emits (`{type: 'string', format: 'uuid' | 'date-time' | 'ipv4'}`), so the schema never over-claims (DEC-029). `date-time` uses a strict RFC-3339 check with real-calendar validation, not `Date.parse` (which accepts a superset).

> `@Positive()`, `@Negative()`, `@NonNegative()` and `@NonPositive()` were **removed** (DEC-020). A name cannot carry a boundary, so write the boundary you mean: `@GreaterThan(0)`, `@LessThan(0)`, `@GreaterThanEqual(0)`, `@LessThanEqual(0)`.

### Field constraints

`Enforce` installs an accessor that validates on assignment (e.g. `Enforce.greaterThan(0)`). `CreateFieldDecorator(descriptor)` builds a field decorator over any constraint descriptor; `installFieldContracts(ctor)` is the imperative installer. Field constraints are **inherited**: a subclass's field is checked against the union of every declaration on its prototype chain, and a subclass may only *strengthen*, never weaken (DEC-021 — a field constraint is a class invariant, and invariants are covariant).

### Markers (record-only)

- **`@Optional` / `@Default(value)`** (DEC-051) — enforcement-aware. `@Optional` makes an *absent* (`undefined`) argument satisfy the position (skipped by the installer, dropped from the tool schema's `required`); `@Default` annotates a JSON default (emitted as a non-asserting `{default}`) and implies `@Optional`. Inheritance is **required-wins**, so a subclass can re-require but never silently weaken (DEC-016/DEC-022); adorn annotates the default, it does not inject it at runtime.
- **`@Describe('…')` / `@Tool('…')`** (DEC-052) — pure annotation, never rejects a value. `@Describe` is a parameter description (the sole source of a property's `description`); `@Tool` is a method/tool description. Both also flow into docs.

### Contracts, including postconditions

`Contract()` (class) installs every contract recorded on the class and registers it for projection; `Validate()` (method) is the per-method alternative. Two postcondition tiers run after a method returns (a throw skips them; an async method awaits the settled value then checks; inheritance conjoins covariantly):

- **`@Ensures((result, ...args) => boolean, description?)`** — a **closure** postcondition (DEC-032). Fully general, but enforced-but-unprojectable (a closure carries no identity — Q-3).
- **`@Returns(<descriptor>)`** — a **reified** postcondition (DEC-033). Writes a descriptor into the reserved `post` slot, so the return value is checked by the same predicate machinery preconditions use *and* emitted into docs (a Returns row) and schema (a `returns` fragment). Coexists with `@Ensures`; the reified band is checked first.

`evaluatePostconditions` is exported because it is the *same* oracle the runtime wrapper runs — a fuzzer checking it checks exactly what enforcement enforces, with no drift.

### Method decorators

`Log()` logs each call (safe-by-default: see redaction below). `Time()` measures call duration, including async and Observable-like returns; `setTimingSink(fn)` routes the measurement. `Observe()` opens an observation span carrying duration and disclosed values, sugar over the O1 seam and carrying a declared `SpanKind`. `Verify` is an imperative assertion for call sites with no decoration point (`Verify.that(GreaterThan(0), 'retries', retries)`).

### `@Sensitive` / `@Telemetry` and safe-by-default redaction

`Sensitive()` marks a field, parameter, or class as holding sensitive data (record-only; it installs nothing). The **redaction runtime** (DEC-030) makes it matter: every path adorn can emit a value through — `@Log`, contract-violation messages, observation events — renders `[REDACTED]` **by default, without reading any annotation**. `setValueDisclosure('all')` turns raw values back on for local debugging; a `@Sensitive` marking *vetoes* even that. The safe default holds with zero `@Sensitive` anywhere — the annotation is defence-in-depth, never the thing that makes an emission safe. `getValueDisclosure` reads the current setting.

`Telemetry` is the twin: `@Telemetry.value()` / `.redact(strategy)` / `.result()` opt a parameter or the return *into* value disclosure on the observation record path (redacted by default otherwise). `@Sensitive` still vetoes, and the veto is surfaced (a diagnostic + a `vetoed` flag), not silenced. See [`docs/sensitive.md`](docs/sensitive.md).

### Enforcement and disclosure configuration

Each contract is classified by **trust** (DEC-008). `guard` (the default) validates untrusted input and survives production; the only way to strip it is `disableGuardEnforcement({confirm, reason})`. `assert` is an internal self-check, stripped in production like a C `assert` — postconditions default to `assert` because they audit your own output. `setEnforcementMode` · `setAssertEnforcement` · `setDefaultTrust` · `enableGuardEnforcement` · `disableGuardEnforcement` tune the gate; `setViolationPolicy('throw' | 'warn' | handler)` routes what happens on a violation (`'warn'` proceeds into the method, which is what makes staging a new contract over live traffic possible); `setObservationVerbosity` gates detail-level observations. `setValueDisclosure` / `getValueDisclosure` control raw-value emission; `setContractDiagnosticsEnabled` · `setContractDiagnosticsSink` · `flushContractDiagnostics` control the missing-`@Contract()` warning.

### Registry introspection

Read-only access to what the projections read. The `getContracts` / `getContract` / `getContractedClasses` / `getContractsForClass` / `getFieldContract` / `getFieldContracts` / `getFieldContractsForClass` family answers *"what does this class declare?"*. The `getEffectiveFieldConstraints` / `getEffectiveFieldContract` / `getEffectiveContract` / `getEffectiveParameterConstraints` / `getEffectivePostconditions` family answers *"what is in force here?"* — the union of every declaration on the prototype chain.

> The `getField…` / `getEffectiveField…` prefix is load-bearing. Since DEC-021/DEC-022 a member is checked against the union of every declaration on its prototype chain, so the `Effective` form is what enforcement applies and what a projection should render. Reading the plain form and assuming it describes runtime behaviour is a mistake — which is why the names disambiguate. This read surface is the **semver-frozen public API** (DEC-039); the registry's *writers* are deliberately **not** exported (Q-6), because they would let a caller bypass the adapter that owns declaration ordering and installation.

### Projections

The same registry read feeds every projection:

- **Docs:** `documentClass` · `documentContracts` extract a model; `renderMarkdown` · `generateMarkdown` render it.
- **JSON Schema (draft 2020-12), descriptive:** `schemaForClass` · `schemaForContracts` build it; `serializeSchema` · `generateSchema` render it. Stacked constraints compose as conjunction, and degradation always goes toward the *weaker* true statement — an over-claiming schema is worse than none (DEC-029).
- **Tool schema, prescriptive:** `toolSchemaForMethod` — see [LLM tool-calling](#llm-tool-calling) above. A sibling of `schemaForClass`, not a flag on it: `schemaForClass` under-claims (validated *against*), `toolSchemaForMethod` is tight (generated *from*).
- **Telemetry / privacy review** (the sixth projection): `telemetryForClass` · `telemetryForContracts` build the "what leaves the process" report; `serializeTelemetry` · `generateTelemetryReport` render it. A pure registry read (DEC-012) that reports the disclosure each parameter/return carries and renders its own scanned denominator (a clean table is never a clean bill of health). It makes no claim about runtime flows.

The projection model types (`ClassDoc`, `MethodDoc`, `ParameterDoc`, `ConstraintDoc`, `FieldDoc`, `ClassSchema`, `ToolSchema`, `TelemetryReport`, …) are exported so a consumer can type a variable holding one.

### Observability (O1)

A neutral, zero-dependency observation seam (DEC-035/036/037). `setObservationSink` / `getObservationSink` install and read one around-shaped `ObservationSink`; the enforcement weave emits **value-free violation facts** and completions through it, and `@Observe` emits completions carrying pre-disclosed values (redacted by default — the organising principle is *"seeing ≠ emitting"*). `settle` is the shared sync/thenable/observable settling classifier (`@Time` rides it, and an OTel adapter ends spans with it); `RETURN_INDEX` marks the return value in an emitted-value payload; `consoleObservationSink` is a ready-made zero-dependency JSON-to-console sink (opt-in, never installed automatically). The event union (`ObservationEvent`, `ViolationFacts`, `EmittedValue`, `Settlement<T>`, …) is exported and semver-frozen-but-additive.

### Constraint descriptors (data, not decorators)

`NumberContracts` · `StringContracts` · `EnumContracts` · `ArrayContracts` are the underlying descriptors namespaced (`NumberContracts.Between(1, 10)`, `ArrayContracts.ArrayOf(...)`), for use wherever a descriptor is wanted directly — feeding `Verify.that`, `CreateFieldDecorator`, or a projection. `ArrayContracts` is the compositional one (its `ArrayOf` takes another descriptor as its item). A constraint authored as a descriptor is registry-visible data; a hand-written predicate closure carries no identity or params and **cannot be projected** (Q-3/SMELL-14).

### Add-ons and tooling

- **`@adorn/test`** (`addons/test/`) — property-based testing driven by contract descriptors (see below).
- **`@adorn/otel`** (`addons/otel/`) — an OpenTelemetry `ObservationSink` (see below).
- **`adorn` CLI** (`bin: adorn`) — `docs` / `schema` / `check` (see below).
- **Build-time sensitive-flow detector** (`tools/sensitive-flow/`) — an ESLint rule + `adorn check` (see below).

---

## Projections and the CLI

The projections are functions, and the `adorn` CLI is their delivery vehicle:

```bash
adorn docs   [--out <file>] <entry...>   # Markdown documentation projection
adorn schema [--out <file>] <entry...>   # JSON Schema projection (draft 2020-12)
adorn check  <tsconfig-or-globs...>      # report @Sensitive values reaching an adorn emitter
```

`docs` and `schema` **load then project** (DEC-007): they `require` each entry module so its decorators execute and populate the registry, then walk it — which means loading *executes* the module, side effects and all (`.ts` entries lazily register `ts-node`). `check` is **static**: it builds a `ts.Program` over your source, runs the sensitive-flow detector, and never executes your code (non-zero exit on a leak). Zero new library dependencies — a hand-rolled arg parser, with `typescript`/`ts-node` lazily required behind actionable errors.

### The sensitive-flow detector

`tools/sensitive-flow/` is build-time tooling — an ESLint rule (`no-sensitive-to-adorn-sink`) over a shared analysis core, never part of the runtime library. It reports where a `@Sensitive` value reaches one of adorn's **own** emitters (`@Log` parameters, constraint-decorated parameters), following the value through same-function aliases, template interpolation, and destructuring (DEC-028). It is **report-only, permanently**, and prints its own scope on every run so a clean result cannot be mistaken for a clean bill of health. Two limits are stated plainly and pinned by test rather than chased: `s.ssn.slice(-4)` is caught by nothing (deciding whether that sanitises an SSN is a regulatory judgement, not a library's), and adorn secures *its own* emissions only — a raw `console.log` of a sensitive value is yours (DEC-025). The full-chain *interprocedural* reachability version is deferred (IDEA-11); the shipped detector is intraprocedural by design.

---

## Property-based testing (`@adorn/test`)

`addons/test/` is the fourth projection: it derives `fast-check` generators from constraint descriptors and fuzzes contracted methods. Its governing rule is **sound generation** — produce only inputs the contract accepts, or *decline* and say so (DEC-031); an unsound generator costs trust, a declined one only costs coverage. `fast-check` is a dev-dependency confined to the add-on and verified absent from `dist` — the runtime dependency stays `tslib` alone (`isolation.test.ts`).

- **Phase A — the weak invariant oracle:** run the method on precondition-valid inputs, then re-check every field invariant on the receiver. Strictly stronger than "didn't throw", but not a correctness oracle.
- **Phase B — the full postcondition oracle (DEC-034):** consumes the *same* functions enforcement runs (`getEffectiveContract().post` + `descriptor.predicate` reified-first, then `getEffectivePostconditions` + `evaluatePostconditions`), so the oracle flags an input exactly when the enforced wrapper throws on it — an executably-pinned no-drift property. Async via `fc.asyncProperty`.

`@OneOf` fuzzes as a sound `fc.constantFrom`, `@ArrayOf` recurses via `fc.array`. (String-format arbitraries are not yet wired, so an `@ArrayOf(Uuid())` item currently *declines* soundly — a coverage gap, not a correctness one.)

---

## OpenTelemetry (`@adorn/otel`)

`addons/otel/` binds the O1 seam to OpenTelemetry (DEC-046). `createOtelSink(options?)` returns an `ObservationSink` a host installs via the public `setObservationSink`, mapping `scope` → an active span (SpanKind mapped, pre-disclosed param attributes), `completed` → an opt-in duration histogram, `violation` → `recordException` + ERROR status + a value-free span event, `message` → a span event. Spans are ended at their correlated `completed` event via the per-call id (DEC-047), so the settled duration cannot drift. `@opentelemetry/api` and `sdk-trace-base` are peers/devDeps with **zero** requires in `dist`, and the add-on needed **no** new core surface — the first proof the O1 seam is a complete public contract (DEC-045). *"Seeing ≠ emitting"* holds end-to-end: a `@Telemetry.value()` param appears on the span, an un-opted one is `[REDACTED]`, and the raw value appears nowhere.

---

## Project structure

```
adorn/
├── index.ts                              # Public entry point (85 value exports + model types)
├── src/
│   ├── Core/                             # Decorator-agnostic model — imports no adapter (DEC-012)
│   │   ├── Descriptor.ts                 # Constraints as data (identity + params -> predicate); constraintFromJSON (DEC-050)
│   │   ├── ContractRegistry.ts           # Where contracts are recorded; the semver-frozen public read surface (DEC-039)
│   │   ├── Postconditions.ts             # evaluatePostconditions — the shared oracle (DEC-032)
│   │   ├── Configuration.ts              # Trust / enforcement / violation policy / verbosity (DEC-008)
│   │   ├── redaction.ts                  # Safe-by-default emission (DEC-030)
│   │   ├── Observation.ts                # O1 sink interface + event union + callId (DEC-035/047)
│   │   ├── settle.ts                     # Shared settling classifier — Settlement<T> (DEC-035)
│   │   ├── telemetryDisclosure.ts        # The one veto + opt-in + global disclosure resolver (DEC-037)
│   │   ├── ViolationError.ts             # Error subclass carrying value-free ViolationFacts
│   │   ├── DecoratorConfiguration.ts     # Legacy config shim, inert (superseded by Configuration.ts)
│   │   └── common.ts                     # Param-name recovery, stack attribution
│   ├── Adapters/                         # The decorator-adapter layer (GAP-8) — may import Core/Contracts
│   │   ├── legacy/                       # Legacy (experimentalDecorators) adapter; a stage3/ sibling can join it (DEC-040)
│   │   │   ├── ContractInstaller.ts      # @Contract() / @Validate() + the enforcement weave
│   │   │   ├── MethodDecoratorFactory.ts # The around-behaviour install seam
│   │   │   ├── ParameterDecoratorFactory.ts # Parameter decorators — record only, never install
│   │   │   ├── FieldDecoratorFactory.ts  # Field decorators — record + install an accessor (DEC-021)
│   │   │   ├── ContractDiagnostics.ts    # Missing-@Contract() dev warning
│   │   │   └── ObservationBehavior.ts    # The MethodBehavior @Observe is sugar over (O1c); consoleObservationSink
│   │   └── layering.test.ts              # Asserts Core/Contracts/Projections import no adapter (DEC-012)
│   ├── Contracts/                        # Built-in constraint descriptors (decorator-free)
│   │   ├── number.ts                     # totality + NaN handling (BUG-4, Q-7)
│   │   ├── string.ts
│   │   ├── enum.ts                       # @OneOf membership descriptor (DEC-049)
│   │   └── array.ts                      # @ArrayOf — the compositional descriptor (DEC-050)
│   ├── ParameterDecorators/Constraints.ts# GreaterThan / StringMinLength / OneOf / ArrayOf / Uuid / ...
│   ├── FieldDecorators/Enforce.ts        # Enforce.* field decorators
│   ├── Markers/                          # Record-only markers
│   │   ├── Optional.ts · Default.ts      # Enforcement-aware optionality (DEC-051)
│   │   └── Describe.ts · Tool.ts         # NL description markers (DEC-052)
│   ├── MethodDecorators/
│   │   ├── Log.ts                        # Log()
│   │   ├── Time.ts                       # Time() + setTimingSink()
│   │   ├── Ensures.ts                    # @Ensures closure postconditions (DEC-032)
│   │   ├── Returns.ts                    # @Returns reified postcondition tier (DEC-033)
│   │   └── Observe.ts                    # @Observe observation scope (DEC-037)
│   ├── Sensitive/Sensitive.ts            # @Sensitive record-only marker
│   ├── Telemetry/Telemetry.ts            # @Telemetry.value/.redact/.result disclosure opt-in (DEC-037)
│   ├── Projections/
│   │   ├── docs.ts                       # Markdown from recorded contracts
│   │   ├── schema.ts                     # JSON Schema + toolSchemaForMethod (DEC-029/048/049)
│   │   └── telemetry.ts                  # Telemetry/disclosure privacy-review report (DEC-037)
│   ├── Validation/Verify.ts             # Imperative assertion helper
│   └── cli/                              # `adorn` CLI (docs / schema / check) — bin entry
├── addons/
│   ├── test/                             # @adorn/test — fast-check fuzzing (Phase A+B), isolated from dist
│   └── otel/                             # @adorn/otel — OpenTelemetry sink (DEC-046), isolated from dist
├── tools/sensitive-flow/                 # Build-time sensitive-flow detector (ESLint rule + `adorn check`)
├── examples/demo.ts                      # Manual smoke script (excluded from the build)
├── docs/                                 # Decision log, issue tracker, plans, research
├── tsconfig.json · tsconfig.cli.json · tsconfig.test.json
└── package.json
```

---

## Getting started

### Prerequisites

- Node.js 20.19+ (CI runs on 20.19 / 22 / 24).
- TypeScript with `experimentalDecorators` and `emitDecoratorMetadata` (both already set in `tsconfig.json`). adorn is pinned to **TypeScript 6.0.3** — the highest version the toolchain supports, because ts-jest has no TS 7 release (DEC-013).

The only runtime dependency is `tslib`. The package exposes a single CJS entry through its `exports` map (`.` → `types` + `default`) plus the `adorn` `bin`.

### Install, build, test

```bash
npm install
npm run build      # tsc -> ./dist, then the CLI build (tsconfig.cli.json)
npm test           # jest — 58 suites, 1061 tests
npm run typecheck  # tsc --noEmit over src, tests, addons, and tools (tsconfig.test.json)
npm run demo       # ts-node examples/demo.ts
```

`examples/demo.ts` constructs a `Task`, calls decorated methods, and exits non-zero if a deliberate constraint violation is *not* raised — a genuine smoke test of installation. It is excluded from the build, so the published package does not ship it.

---

## Project state

### Working

- Parameter-constraint decorators (numeric, string, `@OneOf` enum, `@ArrayOf` arrays, `@Uuid`/`@DateTime`/`@Ipv4`/`@Format` formats), the reified descriptor model behind them, and the `@Contract()` / `@Validate()` installer that enforces them.
- Field decorators (`@Enforce.*`, `CreateFieldDecorator`) with inheritance — a subclass strengthens, never weakens (DEC-021).
- Method-parameter inheritance — an overridden method inherits its parent's preconditions (DEC-022).
- Postconditions — `@Ensures` (closure, DEC-032) and `@Returns` (reified + projectable, DEC-033), the shared `evaluatePostconditions` oracle, blame-driven trust.
- Enforcement-aware `@Optional` / `@Default` (DEC-051) and record-only `@Describe` / `@Tool` (DEC-052).
- `@Log()`, `@Time()`, and `@Observe()`.
- Six projections: Markdown docs, descriptive JSON Schema (draft 2020-12), prescriptive tool schema (`toolSchemaForMethod`), property-test generation (`@adorn/test`, Phase A+B), observability (O1 sink), and the privacy-review telemetry report.
- `@Sensitive` / `@Telemetry` plus safe-by-default redaction — adorn's own emissions redact by default (DEC-028/DEC-030).
- Observability O1 — a neutral zero-dependency `ObservationSink`, `settle`, value-free violation telemetry, per-call correlation (DEC-035/036/037/047).
- `@adorn/otel` OpenTelemetry add-on (DEC-046) and `@adorn/test` fuzzing add-on — both isolated from `dist`, runtime deps stay `{tslib}`.
- Build-time sensitive-flow detector — ESLint rule + `adorn check` (DEC-028).
- The `adorn` CLI (`docs` / `schema` / `check`), the `exports` map, and enforcement / trust / disclosure configuration.

### Roadmap / next steps

**Wave 2 contract vocabulary** (see [`docs/plan-contract-offering.md`](docs/plan-contract-offering.md); Wave 1 — arrays, optional/default, markers, formats — is complete per DEC-050/051/052):

- **`@Shape(FieldClass)`** — nested object parameters (IDEA-25/GAP-16), the second consumer of the DEC-050 compositional mechanism; inline-expanded, never `$ref`, with the tool projection tightening `required`/`additionalProperties` recursively.
- **`@Const` / `@Nullable`** (IDEA-24) — single-literal and null-union polish over the existing enum/compositional machinery.
- **`@Requires(...)`** — cross-parameter contracts (IDEA-26, building IDEA-6: `start < end`, "if mode=custom then config required"). The first writer of the reserved `pre` band; enforcement + fuzzing only, explicitly unprojectable like `@Ensures`.
- Smaller: string-format fast-check arbitraries (the current fuzzer *declines* on formats).

**Bigger directions:**

- **A TC39 Stage-3 decorators adapter** (`adorn/stage3`) beside the legacy one, recording into the same Core model (DEC-040/IDEA-18; needs a second compilation unit, GAP-13).
- **The add-on ecosystem** (DEC-041): `@adorn/rx` (reintroducing `@Memoize`/Observable handling, carrying the removed reactive code's hard-won findings verbatim — IDEA-8), `@adorn/cache` (IDEA-15, records into a `concern` band and carries the composition-hazard detector — DEC-043), and `@adorn/policy` (IDEA-16).
- **The flow-control family**, entirely as add-ons (DEC-042/IDEA-17): `@adorn/resilience` (`@Retry`/`@Timeout`/`@Fallback`/`@CircuitBreaker`), `@adorn/limit` (`@RateLimit`/`@ConcurrencyLimit`/`@Queue`), `@adorn/idempotency`.

**Publication readiness:** the registry read surface is frozen (Q-6/DEC-039, enforced by `test/public-surface.test.ts` pinning the export count) and the `exports` map is in place (GAP-11), but the npm-release process itself is deliberately deprioritised — this is a boundary freeze, not a version commitment.

### Known rough edges

- **Parameter names come from `Function.prototype.toString()`.** Minification degrades them (`["message","someNumber"]` → `["s","t"]`), and that degradation propagates into generated documents, schemas, and tool schemas. Enforcement and every projection degrade *together*, which is the property that matters — a schema saying `s` about a check saying `s` beats one saying `arg0` about a check saying `sku` (SMELL-1, OPEN).
- **Arity is lost.** A wrapped method reports `length === 0` rather than its real arity; its `.name` is correct. Destructured/rest signatures also yield no arity and can misalign recovered names (Q-10, PARTIAL) — which is why a faithful OpenAPI path emitter is still blocked.
- **Hand-written predicate closures can't be projected.** A constraint that is a closure rather than a descriptor (`@Ensures`, and the future `@Requires`) is enforced but invisible to docs, schema, and fuzzing (Q-3/SMELL-14) — "decorate your code, get a fuzz suite" is partial by construction. `@Ensures` additionally types its `result` as `unknown`, so under `strict` the author must annotate (SMELL-20).
- **`strict: false` is still set.** The zero-cost sub-flags are on (`strictFunctionTypes`, `strictBindCallApply`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`); `strictNullChecks` / `noImplicitAny` / `strictPropertyInitialization` carry real, measured cost and are deferred (SMELL-12, PARTIAL).
- **`compileOnSave: true` makes the IDE emit stray sibling `.js` files** for edited `.ts`, which are neither git-ignored nor in eslint's `ignores` and pollute `git status` / `eslint .` until removed (SMELL-21, OPEN).
- **`DecoratorConfiguration.ts` is inert**, retained only as a migration shim; the live configuration is `Core/Configuration.ts` (SMELL-4).
- **The `@Sensitive` primitive-parameter gap is permanent.** `transfer(ssn: string)` must be marked on the parameter; the connection to a `@Sensitive` field is destroyed by JavaScript's value semantics (DEC-PII-5). A method *return* likewise cannot be directly `@Sensitive` (a TS signature limit — Q-23); `@Telemetry.result()` gives it the opt-in half but the veto half needs class-level `@Sensitive`.
- The reactive `@Memoize` decorator and `rxjs` were removed from core (they will return as `@adorn/rx` — IDEA-8), so `@Time` degrades to `settled: false` when no Observable library is present.

For the full picture, [`docs/DECISIONS.md`](docs/DECISIONS.md) is the decision log (DEC-001…DEC-052) and [`docs/ISSUES.md`](docs/ISSUES.md) the running issue tracker.

---

## License

ISC (per `package.json`). Author: `natwhite`.
</content>
</invoke>
