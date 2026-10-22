# adorn

> **adorn is contract-driven development for TypeScript.** Decorators **adorn** a function with its contract —
> what its inputs must satisfy, what has to hold before and after. Runtime validation, JSON Schema,
> documentation, tests, observability, and an LLM tool schema are all **derived from that one declaration**, so
> those artifacts can't drift from each other by construction, not by discipline.

**`0.1.0` · MIT · TypeScript.** The core has a single runtime dependency (`tslib`). Two opt-in add-ons —
`adorn/otel` (OpenTelemetry) and `adorn/test` (property-based testing) — sit behind an optional peer dependency
each, so the package root stays `tslib`-only.

```bash
npm install adorn
```

---

## The problem it solves

The intent of a function is normally scattered across places that immediately begin to disagree: a runtime
check buried in the body, a schema in a separate file, a sentence in the docs, a hand-written test. Each is
maintained by hand; each drifts.

adorn's wager is that the contract belongs **on the declaration**, not in the body — lifted up to the signature
where you can *see* it, and enforced at the boundary of **every** function that carries one. A contracted method
*is* its own documentation, *is* a schema, *is* a tool definition — because all of them are read from the one
thing you wrote on the signature.

```ts
import {
    Contract, Tool, Describe, NotEmpty, OneOf,
    GreaterThanEqual, LessThanEqual,
} from 'adorn';
import { toolSchemaForMethod } from 'adorn/schema';

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

// Exactly the object a function-calling API wants:
const parameters = toolSchemaForMethod(WeatherTool, 'getWeather');
```

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

That one line — `@GreaterThanEqual(1) @LessThanEqual(7) days: number` — is *both* the `{minimum: 1, maximum: 7}`
the model is steered by **and** the predicate that throws when the model sends `{days: 99}`. Change
`@LessThanEqual(7)` to `@LessThanEqual(14)` and *both* the schema the model reads and the check its reply faces
move together, because there is only one of them, and it lives on the signature.

### Why this matters even more for machine consumers

A drifted *doc* misleads a human who can compensate; a drifted *tool schema* silently corrupts every call,
because the consumer produces malformed input the moment the schema is wrong. That makes an LLM tool the most
*unforgiving* consumer of a contract — and a good stress test for one, rather than the reason the paradigm
exists.

To prove the tool-schema projection against a real provider, its output was round-tripped end to end through
OpenAI's live function-calling API (`gpt-4o-mini`, temperature 0): the generated schema was accepted, the model
returned a tool call, and its arguments validated against **the same declaration** that produced the schema —
nested objects, nullable-optional fields, and OpenAI strict mode included. The verbatim evidence is in
[`docs/q31-capstone-results.md`](docs/q31-capstone-results.md).

## One declaration, every artifact

| One declaration produces | Entry point |
| --- | --- |
| **Runtime validation** — the check that runs on every call | `adorn` |
| **Prescriptive tool schema** — the LLM's `parameters` object (`toolSchemaForMethod`) | [`adorn/schema`](docs/schemas.md) |
| **Descriptive JSON Schema** — draft 2020-12 (`schemaForClass`) | [`adorn/schema`](docs/schemas.md) |
| **Documentation** — Markdown generated from the same statement it enforces | [`adorn/schema`](docs/schemas.md) |
| **Observability** — value-free violation & completion facts through a neutral sink | [`adorn/observe`](docs/observability.md) |
| **Privacy review** — the disclosure each parameter/return carries (`telemetryForClass`) | [`adorn/privacy`](docs/observability.md) |
| **Property-based tests** — `fast-check` inputs derived from the contract | [`adorn/test`](docs/add-ons.md) |

**adorn is a validator, not a coercion library.** It *rejects* an invalid value; it never silently coerces,
defaults, or transforms one. A malformed argument is a violation, not something to degrade into a fallback.

> **What "no drift" does and doesn't cover.** The artifacts adorn *derives* — schema, validation, docs,
> telemetry — cannot drift from each other, because they all read one underlying descriptor. The descriptor
> itself still has to be authored to match the two channels adorn can't see at runtime: the parameter's
> **TypeScript type** and any **TypeScript default**. adorn removes drift *between the projections*; it does not
> reconcile the descriptor with TypeScript's own view. See
> [Decorators & contracts](docs/decorators.md#surprising-shapes) for the details.

## Decorators are the ergonomic form, not the foundation

What every projection reads is a **reified contract descriptor** — plain, JSON-serialisable data — and decorators
are simply the preferred adapter that produces it. The same descriptors drive a fully decorator-free path
(`contract()`, `toolSchemaFrom`, `Verify.check`, `defineConstraint`), so a codebase that can't or won't use
decorators adopts the identical enforcement and projections without them — and with **no compiler flags**.

```ts
// The descriptor path — same enforcement, same schema, no decorators:
import { Verify, Contracts } from 'adorn';
import { toolSchemaFrom } from 'adorn/schema';

const params = { city: Contracts.string.notEmpty(), days: Contracts.number.between(1, 7) };

const schema = toolSchemaFrom({ name: 'getWeather', params });  // the model's parameters object
const result = Verify.check(Contracts.object(params), 'args', untrustedJson); // typed, non-throwing verdict
```

Choose decorators or descriptors per file; they interoperate and project identically. See
[The functional (descriptor) API](docs/functional-api.md) and
[Two authoring paths](docs/functional-api.md#two-authoring-paths).

## Install & setup

```bash
npm install adorn
```

The only runtime dependency is `tslib`. The package ships **dual ESM + CommonJS** through its `exports` map —
`import` resolves to a tree-shakeable ESM build, `require` to the CommonJS build, both sharing one set of `.d.ts`
types. The two formats are safe to mix in one process: adorn's mutable state (the registry, the sinks, the
policy) lives in a `globalThis`-keyed slot, so a dual-loaded copy shares one registry rather than silently
splitting enforcement.

**Decorator syntax** needs exactly one TypeScript flag:

```jsonc
// tsconfig.json
{ "compilerOptions": { "experimentalDecorators": true } }
```

That is the whole requirement — enforcement and every projection read the reified descriptor, not reflected type
metadata, so nothing depends on `emitDecoratorMetadata` or `reflect-metadata`. Node.js 20.19+ is supported (CI
runs on 20.19 / 22 / 24). The descriptor API needs no flags at all. Full setup, including the optional docs
`Type` column and per-toolchain notes, is in [Enable decorators](docs/decorators.md#enable-decorators).

## Package entry points

The root is the authoring surface; the rest of the API is grouped onto subpaths so a consumer imports only what
it uses and a bundler can tree-shake the rest. Each subpath also exports the TypeScript types for what it holds.

| Entry point | What it holds |
| --- | --- |
| `adorn` | Decorators; the descriptor factories + the `Contracts` facade; `contract` / `contract.checked`; `Verify` / `Enforce`; `defineConstraint`; and the configuration setters (`setViolationPolicy`, `setObservationSink`, …). |
| `adorn/schema` | The projections — `toolSchemaForMethod`, `toolSchemaFrom`, `schemaForClass`, and the docs generators. |
| `adorn/introspection` | The registry reads (`getContractsForClass`, `getEffective*`) and the shared evaluators. |
| `adorn/observe` | Observation plumbing — `getObservationSink`, `nextCallId`, `settle`, `violationFromCheck`, and the `ObservationSink` model. |
| `adorn/privacy` | The telemetry / privacy-review projection — `telemetryForClass`, `generateTelemetryReport`. |
| `adorn/otel` | An OpenTelemetry `ObservationSink` (optional peer `@opentelemetry/api`). |
| `adorn/test` | Property-based testing from descriptors (optional peer `fast-check`). |

## Documentation

The guides below cover the full surface; the website hosts an interactive reference and a live playground.

- **[Decorators & contracts](docs/decorators.md)** — the full decorator catalog (constraints, markers,
  pre/postconditions), how `@Contract()` works, and enforcement/disclosure configuration.
- **[Schemas, projections & the CLI](docs/schemas.md)** — the tool schema, descriptive JSON Schema, Markdown
  docs, OpenAI strict mode, registry introspection, and the `adorn` CLI.
- **[The functional (descriptor) API](docs/functional-api.md)** — `Verify`, `contract()`, `toolSchemaFrom`, the
  `Contracts` facade, and the two authoring paths — decorator-free authoring and validation.
- **[Observability & privacy](docs/observability.md)** — the neutral observation sink, `@Sensitive` /
  `@Telemetry`, and safe-by-default redaction.
- **[Add-ons](docs/add-ons.md)** — `adorn/otel` (OpenTelemetry sink) and `adorn/test` (property-based testing).
- **Interactive reference & playground:** [adorn-ts.dev](https://adorn-ts.dev)
- **Runnable examples:** [`examples/`](examples/README.md) · **Decision log:** [`docs/DECISIONS.md`](docs/DECISIONS.md) · **Releases:** [`CHANGELOG.md`](CHANGELOG.md)

## Project status

A focused, honestly-scoped `0.1.0`: a working decorator core with method and field inheritance, closure and
reified pre-/postconditions, five projections (docs, JSON Schema, prescriptive LLM tool schema, observability,
privacy review), a safe-by-default redaction runtime, a build-time sensitive-flow detector, and a CLI. The
public surface is pinned by a test, and the suite is green.

**What works today**

- The parameter-constraint decorators (numeric, string, `@OneOf`/`@Const`, `@ArrayOf`, `@Dictionary`, `@Shape`,
  `@Nullable`, string formats), the reified descriptor model, and the `@Contract()` / `@Validate()` installer.
- Field decorators and method-parameter inheritance (a subclass strengthens, never weakens).
- Pre-/postconditions — `@Requires`, `@EnabledWhen`, `@Ensures` (closure), `@Returns` (reified + projectable).
- Five in-core projections, including the prescriptive tool schema with OpenAI strict mode.
- `@Sensitive` / `@Telemetry` plus safe-by-default redaction, the sensitive-flow detector, and the CLI.
- The co-equal descriptor-first path — `Verify`, `contract()`, `toolSchemaFrom`, `defineConstraint`, the
  `*Contracts` namespaces and the `Contracts` facade — the same enforcement and projections with no decorators.

**On the roadmap** — a TC39 standard-decorators adapter (`adorn/standard`) beside the legacy one, consumer-facing
JSDoc carried into `dist`, and string-format fuzzing arbitraries. A few known limitations (minification degrades
recovered parameter names; closures are enforced but unprojectable; constructor-parameter decorators are not yet
supported) are documented in [Decorators & contracts](docs/decorators.md#known-limitations).

## Contributing / build from source

```bash
npm install
npm run build      # tsc -> ./dist (CJS mirror + CLI), then tsup -> ./dist/esm (the ESM bundles)
npm test           # jest — the full suite
npm run typecheck  # tsc --noEmit over src, tests, add-ons, tools
npm run demo       # ts-node examples/demo.ts — a genuine install smoke test
npm run hooks      # enable the repo's pre-commit Prettier gate (.githooks)
```

Formatting is enforced by Prettier (`npm run format`) and gated in CI; run `npm run hooks` once per clone so the
pre-commit hook catches drift before it reaches a push.

## License

[MIT](LICENSE). Copyright © 2026 natwhite.
