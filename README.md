# adorn

> TypeScript decorators that treat a contract as **data** — one declaration, projected into validation, documentation, JSON Schema, and generated tests.

**Status: experimental, but substantial.** adorn is not a released package and still has named rough edges (see [Project state](#project-state)), but it is well past a prototype: a working decorator core, method and field inheritance semantics, postconditions, three shipping projections (docs, JSON Schema, property-test generation), a safe-by-default redaction runtime, a build-time sensitive-flow detector, and a CLI. `index.ts` exports **59 values** (plus 10 model types) across **36 test suites**. Treat it as a proof of concept you can read and run, not something to depend on in production.

---

## The thesis

The intent of a method or a field is normally scattered across four places that immediately begin to disagree: a runtime check in the body, a sentence in the docs, a JSON Schema in a separate file, and a hand-written test. Each is maintained separately; each drifts.

adorn's goal (DEC-006) is that a **single contract declaration** is the source all of those descend from:

| The declaration produces | Status |
| --- | --- |
| **Validation** — the check that runs on every call | shipped |
| **Documentation** — Markdown generated from the same statement it enforces | shipped |
| **JSON Schema** — draft 2020-12, generated from the same declaration | shipped |
| **Tests / fuzzing** — inputs derived from the contract, checked against its guarantees | Phase A shipped (`@adorn/test`) |
| **Observability** — value-free violation telemetry | planned |

The load-bearing consequence is that a constraint is not an opaque closure that throws — it is a **reified descriptor**: an identity plus JSON-serialisable params, with the predicate *derived* from those params (DEC-010). Derivation is what makes enforcement and the generated artifacts unable to disagree.

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

> #### ⚠ Breaking change — `@Contract()` is required
>
> Parameter constraints **do nothing on their own**. A class that declares them without `@Contract()` is not enforced, and is also invisible to any documentation, schema, or fuzzing generated from the registry.
>
> Because that failure is silent, adorn emits a development-mode warning naming the offending class and methods. It is off under `NODE_ENV=production` and can be routed or silenced with `setContractDiagnosticsSink` / `setContractDiagnosticsEnabled` — though silencing it does not make the contracts work.
>
> `@Validate()` is available as a per-method alternative when annotating the whole class is not wanted. Since DEC-016 it **also** registers the class for projection: adorn never enforces at runtime what it would omit from a generated artifact.
>
> **Why the annotation exists at all:** an earlier design made the wrapper stick by monkey-patching the global `Object.defineProperty`, because `tslib`'s `__decorate` re-applies the pre-decoration method descriptor and would otherwise discard the wrapper. A parameter decorator's return value is ignored by the language, so there was no other way. Moving installation to a class decorator removes the patch entirely — and is the same shape a standard-decorators (TC39) adapter will need.

Constraints evaluate in **declaration order**: parameters left to right, stacked decorators top to bottom (DEC-015/DEC-017). When several arguments are invalid, the first one you would read in the signature is the one reported.

---

## What's included

The public surface groups by what it constrains or produces. Every category below is exported from `index.ts`.

### Parameter constraints

`GreaterThan` · `GreaterThanEqual` · `LessThan` · `LessThanEqual` · `Between` · `Integer` · `MultipleOf` — numeric bounds. `StringMinLength` · `MinLength` · `MaxLength` · `NotEmpty` · `Matches` · `Email` · `Url` — string length and pattern. Every predicate is **total** (a `null`/`NaN`/wrong-type argument reports a contract violation, never a bare `TypeError`), which matters because a fuzzer feeds it those inputs first (BUG-4).

> `@Positive()`, `@Negative()`, `@NonNegative()` and `@NonPositive()` were **removed** (DEC-020). A name cannot carry a boundary, so write the boundary you mean: `@GreaterThan(0)`, `@LessThan(0)`, `@GreaterThanEqual(0)`, `@LessThanEqual(0)`.

### Field constraints

`Enforce` installs an accessor that validates on assignment (e.g. `Enforce.greaterThan(0)`). `CreateFieldDecorator(descriptor)` builds a field decorator over any constraint descriptor; `installFieldContracts(ctor)` is the imperative installer. Field constraints are **inherited**: a subclass's field is checked against the union of every declaration on its prototype chain, and a subclass may only *strengthen*, never weaken (DEC-021 — a field constraint is a class invariant, and invariants are covariant).

### Contracts, including postconditions

`Contract()` (class) installs every contract recorded on the class and registers it for projection. `Validate()` (method) is the per-method alternative. `Ensures((result, ...args) => boolean, description?)` records a **postcondition** (DEC-032): checked after the method returns — a throw skips it, an async method awaits the settled value then checks, and inheritance conjoins covariantly (a subclass strengthens). Overridden methods inherit their parent's parameter preconditions the same way fields do (DEC-022). `evaluatePostconditions` is exported because it is the *same* oracle the runtime wrapper runs — a fuzzer checking it checks exactly what enforcement enforces, with no drift.

### Method decorators

`Log()` logs each call (safe-by-default: see redaction below). `Time()` measures call duration, including async and Observable-like returns; `setTimingSink(fn)` routes the measurement. `Verify` is an imperative assertion for call sites with no decoration point (`Verify.that(GreaterThan(0), 'retries', retries)`).

### `@Sensitive` and safe-by-default redaction

`Sensitive()` marks a field, parameter, or class as holding sensitive data (record-only; it installs nothing). The **redaction runtime** (DEC-030) makes it matter: every path adorn can emit a value through — `@Log`, contract-violation messages — renders `[REDACTED]` **by default, without reading any annotation**. `setValueDisclosure('all')` turns raw values back on for local debugging; a `@Sensitive` marking *vetoes* even that. The safe default holds with zero `@Sensitive` anywhere — the annotation is defence-in-depth, never the thing that makes an emission safe. `getValueDisclosure` reads the current setting. See [`docs/sensitive.md`](docs/sensitive.md).

### Enforcement configuration

Each contract is classified by **trust** (DEC-008). `guard` (the default) validates untrusted input and survives production; the only way to strip it is `disableGuardEnforcement({confirm, reason})`. `assert` is an internal self-check, stripped in production like a C `assert` — postconditions default to `assert` because they audit your own output. `setEnforcementMode` · `setAssertEnforcement` · `setDefaultTrust` · `enableGuardEnforcement` · `disableGuardEnforcement` tune the gate; `setViolationPolicy('throw' | 'warn' | handler)` routes what happens on a violation (`'warn'` proceeds into the method, which is what makes staging a new contract over live traffic possible). `setContractDiagnosticsEnabled` · `setContractDiagnosticsSink` · `flushContractDiagnostics` control the missing-`@Contract()` warning.

### Registry introspection

Read-only access to what the projections read. The `getContracts` / `getContract` / `getContractedClasses` / `getContractsForClass` / `getFieldContract` / `getFieldContracts` / `getFieldContractsForClass` family answers *"what does this class declare?"*. The `getEffectiveFieldConstraints` / `getEffectiveFieldContract` / `getEffectiveContract` / `getEffectiveParameterConstraints` / `getEffectivePostconditions` family answers *"what is in force here?"* — the union of every declaration on the prototype chain.

> The `getField…` / `getEffectiveField…` prefix is load-bearing. Since DEC-021/DEC-022 a member is checked against the union of every declaration on its prototype chain, so the `Effective` form is what enforcement applies and what a projection should render. Reading the plain form and assuming it describes runtime behaviour is a mistake — which is why the names disambiguate. The registry's *writers* are deliberately **not** exported (Q-6): they would let a caller bypass the adapter that owns declaration ordering and installation.

### Projections

**Docs:** `documentClass` · `documentContracts` extract a model; `renderMarkdown` · `generateMarkdown` render it. **JSON Schema (draft 2020-12):** `schemaForClass` · `schemaForContracts` build it; `serializeSchema` · `generateSchema` render it. Stacked constraints compose as conjunction, and degradation always goes toward the *weaker* true statement — an over-claiming schema is worse than none (DEC-029). The projection model types (`ClassDoc`, `MethodDoc`, `ParameterDoc`, `ConstraintDoc`, `FieldDoc`, `ClassSchema`, …) are exported so a consumer can type a variable holding one.

### Constraint descriptors (data, not decorators)

`NumberContracts` and `StringContracts` are the underlying descriptors namespaced (`NumberContracts.Between(1, 10)`), for use wherever a descriptor is wanted directly — feeding `Verify.that`, `CreateFieldDecorator`, or a projection. A constraint authored as a descriptor is registry-visible data; a hand-written predicate closure carries no identity or params and **cannot be projected** (Q-3/SMELL-14).

---

## Projections and the CLI

The projections are functions, and the `adorn` CLI (`bin: adorn`) is their delivery vehicle:

```bash
adorn docs   [--out <file>] <entry...>   # Markdown documentation projection
adorn schema [--out <file>] <entry...>   # JSON Schema projection (draft 2020-12)
adorn check  <tsconfig-or-globs...>      # report @Sensitive values reaching an adorn emitter
```

`docs` and `schema` **load then project** (DEC-007): they `require` each entry module so its decorators execute and populate the registry, then walk it — which means loading *executes* the module, side effects and all. `check` is **static**: it builds a `ts.Program` over your source, runs the sensitive-flow detector, and never executes your code (non-zero exit on a leak).

### The sensitive-flow detector

`tools/sensitive-flow/` is build-time tooling — an ESLint rule (`no-sensitive-to-adorn-sink`) over a shared analysis core, never part of the runtime library. It reports where a `@Sensitive` value reaches one of adorn's **own** emitters (`@Log` parameters, constraint-decorated parameters), following the value through same-function aliases, template interpolation, and destructuring (DEC-028). It is **report-only, permanently**, and prints its own scope on every run so a clean result cannot be mistaken for a clean bill of health. Two limits are stated plainly and pinned by test rather than chased: `s.ssn.slice(-4)` is caught by nothing (deciding whether that sanitises an SSN is a regulatory judgement, not a library's), and adorn secures *its own* emissions only — a raw `console.log` of a sensitive value is yours (DEC-025).

---

## Property-based testing (`@adorn/test`, Phase A)

`addons/test/` is the fourth projection: it derives `fast-check` generators from constraint descriptors and fuzzes contracted methods. Its governing rule is **sound generation** — produce only inputs the contract accepts, or *decline* and say so (DEC-031); an unsound generator costs trust, a declined one only costs coverage. `fast-check` is a dev-dependency confined to the add-on and verified absent from `dist` — the runtime dependency stays `tslib` alone.

Phase A ships a **weak invariant oracle**: run the method on precondition-valid inputs, then re-check every field invariant on the receiver. That is strictly stronger than "didn't throw" but is not a correctness oracle. The full postcondition oracle (consuming `@Ensures` / `evaluatePostconditions`) is Phase B — see the roadmap.

---

## Project structure

```
adorn/
├── index.ts                              # Public entry point (72 value exports)
├── src/
│   ├── Core/                             # Decorator-agnostic model — imports no adapter (DEC-012)
│   │   ├── Descriptor.ts                 # Constraints as data (identity + params -> predicate)
│   │   ├── ContractRegistry.ts           # Where contracts are recorded; public read surface
│   │   ├── Postconditions.ts             # evaluatePostconditions — the shared oracle (DEC-032)
│   │   ├── Configuration.ts              # Trust / enforcement / violation policy / verbosity (DEC-008)
│   │   ├── redaction.ts                  # Safe-by-default emission (DEC-030)
│   │   ├── Observation.ts                # O1 sink interface + event union (DEC-035)
│   │   ├── settle.ts                     # Shared settling classifier — Settlement<T> (DEC-035)
│   │   ├── telemetryDisclosure.ts        # The one veto+opt-in+global disclosure resolver (DEC-037)
│   │   ├── ViolationError.ts             # Error subclass carrying value-free ViolationFacts
│   │   ├── DecoratorConfiguration.ts     # Legacy config shim, inert (superseded by Configuration.ts)
│   │   └── common.ts                     # Param-name recovery, stack attribution
│   ├── Adapters/                         # The decorator-adapter layer (GAP-8) — may import Core/Contracts
│   │   ├── legacy/                       # Legacy (experimentalDecorators) adapter; a stage3/ sibling can join it
│   │   │   ├── ContractInstaller.ts      # @Contract() / @Validate() + the enforcement weave
│   │   │   ├── MethodDecoratorFactory.ts # The around-behaviour install seam
│   │   │   ├── ParameterDecoratorFactory.ts # Parameter decorators — record only, never install
│   │   │   ├── FieldDecoratorFactory.ts  # Field decorators — record + install an accessor (DEC-021)
│   │   │   ├── ContractDiagnostics.ts    # Missing-@Contract() dev warning
│   │   │   └── ObservationBehavior.ts    # The MethodBehavior @Observe is sugar over (O1c)
│   │   └── layering.test.ts              # Asserts Core/Contracts/Projections import no adapter (DEC-012)
│   ├── Contracts/                        # Built-in constraint descriptors (decorator-free)
│   │   ├── number.ts                     # totality + NaN handling (BUG-4, Q-7)
│   │   └── string.ts
│   ├── ParameterDecorators/Constraints.ts# GreaterThan / StringMinLength / Matches / ...
│   ├── FieldDecorators/Enforce.ts        # Enforce.* field decorators
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
│   │   ├── schema.ts                     # JSON Schema (draft 2020-12) from recorded contracts
│   │   └── telemetry.ts                  # Telemetry/disclosure report (DEC-037)
│   ├── Validation/Verify.ts             # Imperative assertion helper
│   └── cli/                              # `adorn` CLI (docs / schema / check) — bin entry
├── addons/test/                          # @adorn/test — fast-check fuzzing (Phase A+B), isolated from dist
├── tools/sensitive-flow/                 # Build-time sensitive-flow detector (ESLint rule + `adorn check`)
├── examples/demo.ts                      # Manual smoke script (excluded from the build)
├── docs/                                 # Decision log, issue tracker, plans, research
├── tsconfig.json
└── package.json
```

---

## Getting started

### Prerequisites

- Node.js 20.19+ (CI runs on 20.19 / 22 / 24).
- TypeScript with `experimentalDecorators` and `emitDecoratorMetadata` (both already set in `tsconfig.json`). adorn is pinned to **TypeScript 6.0.3** — the highest version the toolchain supports, because ts-jest has no TS 7 release (DEC-013).

The only runtime dependency is `tslib`.

### Install, build, test

```bash
npm install
npm run build      # tsc -> ./dist, then the CLI build (tsconfig.cli.json)
npm test           # jest — 36 suites
npm run typecheck  # tsc --noEmit over src, tests, addons, and tools
npm run demo       # ts-node examples/demo.ts
```

`examples/demo.ts` constructs a `Task`, calls decorated methods, and exits non-zero if a deliberate constraint violation is *not* raised — a genuine smoke test of installation. It is excluded from the build, so the published package does not ship it.

---

## Project state

### Working

- Parameter-constraint decorators, the reified descriptor model behind them, and the `@Contract()` / `@Validate()` installer that enforces them.
- Field decorators (`@Enforce.*`, `CreateFieldDecorator`) with inheritance — a subclass strengthens, never weakens (DEC-021).
- Method-parameter inheritance — an overridden method inherits its parent's preconditions (DEC-022).
- Postconditions v1 — `@Ensures`, a closure band, the shared `evaluatePostconditions` oracle, blame-driven trust (DEC-032).
- `@Log()` and `@Time()`.
- Markdown documentation projection (`documentClass`, `generateMarkdown`).
- JSON Schema projection, draft 2020-12 (`schemaForClass`, `generateSchema`).
- `@Sensitive` plus safe-by-default redaction — adorn's own emissions redact by default (DEC-028/DEC-030).
- Build-time sensitive-flow detector — ESLint rule + `adorn check` (DEC-028).
- The `adorn` CLI (`docs` / `schema` / `check`).
- Property-based testing add-on, Phase A — sound generation + weak invariant oracle (`@adorn/test`).
- Enforcement / trust / disclosure configuration.

### Known rough edges

- **Arity is lost.** A wrapped method reports `length === 0` rather than its real arity; its `.name` is correct (BUG-7 residue, Q-10). Destructured/rest signatures also yield no arity and can misalign recovered names.
- **Parameter names come from `Function.prototype.toString()`.** Minification degrades them (`["message","someNumber"]` → `["s","t"]`), and since BUG-14 that degradation propagates into generated documents. Enforcement and documentation degrade *together*, which is the property that matters (SMELL-1).
- **`DecoratorConfiguration.ts` is inert**, retained only as a migration shim; the live configuration is `Core/Configuration.ts` (SMELL-4 / DEC-008).
- **Hand-written predicate closures can't be projected.** A constraint that is a closure rather than a descriptor is enforced but invisible to docs, schema, and fuzzing (Q-3 / SMELL-14) — "decorate your code, get a fuzz suite" is partial by construction.
- **The `@Sensitive` primitive-parameter gap is permanent.** `transfer(ssn: string)` must be marked on the parameter; the connection to a `@Sensitive` field is destroyed by JavaScript's value semantics (DEC-PII-5).
- `strict: false` is still set, but the zero-cost sub-flags are on (`strictFunctionTypes`, `strictBindCallApply`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`); `strictNullChecks` / `noImplicitAny` / `strictPropertyInitialization` carry real cost and are deferred (SMELL-12). The reactive `@Memoize` decorator and `rxjs` were removed from core (they will return as a separate `@adorn/rx` add-on — IDEA-8), so `@Time` degrades to `settled: false` when no Observable library is present.

### Roadmap

The next build phase is specified in [`docs/next-phase-plan.md`](docs/next-phase-plan.md):

- **Reified `@Returns(<descriptor>)`** — a projectable postcondition tier that writes a descriptor into the reserved `post` slot, plus a return-value JSON-Schema fragment and a docs "Returns" row.
- **Fuzzing Phase B** — replace the weak invariant oracle with the full postcondition oracle (`getEffectivePostconditions` + `evaluatePostconditions`), consumed inside `@adorn/test`.
- **Observability O1** — a neutral, zero-dependency observation layer with value-free contract-violation telemetry, per the adversary-hardened [`docs/observability-o1-plan.md`](docs/observability-o1-plan.md).

For the full picture, [`docs/DECISIONS.md`](docs/DECISIONS.md) is the decision log and [`docs/ISSUES.md`](docs/ISSUES.md) the running issue tracker.

---

## License

ISC (per `package.json`). Author: `natwhite`.
