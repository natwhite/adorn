# Schemas, projections & the CLI

[← README](../README.md) · [Decorators & contracts](decorators.md) · [Functional API](functional-api.md) · [Observability & privacy](observability.md) · [Add-ons](add-ons.md)

A contract is read once and *projected* many ways. Every projection reads the same registry data, so none of
them can disagree. This guide covers the projections (docs, JSON Schema, prescriptive tool schema, telemetry),
OpenAI strict mode, the registry read surface those projections walk, and the `adorn` CLI.

The projections live on the **`adorn/schema`** and **`adorn/privacy`** subpath exports; the registry reads live
on **`adorn/introspection`**. Each subpath also exports the TypeScript types for what it holds.

## Projections

The same registry read feeds every projection:

- **Docs:** `documentClass` · `documentContracts` → `renderMarkdown` · `generateMarkdown`.
- **JSON Schema (draft 2020-12), descriptive:** `schemaForClass` · `schemaForContracts` → `serializeSchema` ·
  `generateSchema`. Degradation always goes toward the *weaker* true statement — an over-claiming schema is worse
  than none.
- **Tool schema, prescriptive:** `toolSchemaForMethod(Class, 'method', {description?, provider?, strict?})` — the
  flagship (`{ provider: 'openai', strict: true }` emits [OpenAI strict mode](#openai-strict-mode)). A sibling of
  `schemaForClass`, not a flag on it: `schemaForClass` under-claims (describe a value enforcement will *accept*),
  `toolSchemaForMethod` is tight (specify the object the producer must *send*; `required` +
  `additionalProperties: false`).
- **Telemetry / privacy review:** `telemetryForClass` · `telemetryForContracts` → `serializeTelemetry` ·
  `generateTelemetryReport`. A pure registry read reporting the disclosure each parameter/return carries — see
  [Observability & privacy](observability.md).

The projection model types (`ClassDoc`, `MethodDoc`, `ToolSchema`, `TelemetryReport`, …) are exported so a
consumer can type a variable holding one.

Three deliberate shape decisions the tool schema makes:

- **No `$schema`** — it is a `parameters` sub-schema, not a standalone document (`schemaForClass` still emits
  it).
- **`required` = "carries ≥1 constraint" minus `@Optional`** — sound, because adorn's predicates are total (a
  missing argument already fails at runtime), so `required` matches enforcement.
- **`additionalProperties: false`** — a method's parameter set is closed. This is the one keyword the tool schema
  asserts that runtime enforcement doesn't itself check, labelled honestly as producer-steering.

## OpenAI strict mode

OpenAI's [strict function calling](https://platform.openai.com/docs/guides/function-calling) requires that
**every** property appear in `required` and `additionalProperties: false` be set at **every** object level — not
just the root. Pass `{ provider: 'openai', strict: true }` to the decorated flagship (or to `toolSchemaFrom`) and
adorn emits a strict-compatible schema, proven end-to-end against the live API:

```ts
const parameters = toolSchemaForMethod(ScheduleTool, 'remind', { provider: 'openai', strict: true });
```

`strict` is a **provider compatibility profile**, not a provider-independent toggle — naming the provider is
deliberate, so other providers can define their own profiles without overloading one flag, and an unsupported
`provider` is a loud build-time error rather than a silent fallback. (The original boolean `{ providerStrict:
true }` remains as a deprecated, behaviour-identical alias.)

The rule strict mode forces is *nullability-in-the-declaration*: because strict mode forbids a truly-absent
property, an "optional" field is instead declared `@Nullable(...)` and sent as `null` — so one recursive pass
promotes it into `required` at its own object level, and schema and validator both accept the model's `null` with
no drift. A bare non-nullable `@Optional` parameter or an open `@Dictionary` map (which strict mode cannot
express) is refused at build time with an actionable, decorator-flavoured message instead of a silent 400 from
the API.

## Registry introspection

The read surface the projections walk is public (on `adorn/introspection`). The `getContracts` / `getContract` /
`getContractedClasses` / `getFieldContract(s)` family answers *"what does this class declare?"*; the
`getEffective…` family (`getEffectiveFieldConstraints` / `getEffectiveParameterConstraints` /
`getEffectivePostconditions` / …) answers *"what is in force here?"* — the union of every declaration on the
prototype chain, which is what enforcement applies and a projection should render. This read surface is the
semver-frozen public API (pinned by `test/public-surface.test.ts`); the registry's *writers* are deliberately not
exported (they would bypass the adapter that owns ordering and installation).

The shared evaluators `evaluatePreconditions` / `evaluatePostconditions` / `evaluateEnabledness` live here too —
the *same* oracles the runtime wrapper runs, so a fuzzer checking them checks exactly what enforcement enforces.

## The `adorn` CLI

The projections are functions; the `adorn` CLI is their delivery vehicle:

```bash
adorn docs   [--out <file>] <entry...>   # Markdown documentation projection
adorn schema [--out <file>] <entry...>   # JSON Schema projection (draft 2020-12)
adorn check  <tsconfig-or-globs...>      # report @Sensitive values reaching an adorn emitter
```

`docs` and `schema` **load then project**: they `require` each entry so its decorators execute and populate the
registry, then walk it — so loading *executes* the module, side effects and all. A `.ts` entry is run through
`ts-node`, which the CLI lazily requires: for `.ts` entries you need `ts-node` and `typescript` installed in your
project (they are not runtime dependencies of adorn). `check` is **static** — it builds a `ts.Program`, runs the
sensitive-flow detector, and never executes your code (non-zero exit on a leak).

### The sensitive-flow detector

`tools/sensitive-flow/` is build-time tooling — an ESLint rule (`no-sensitive-to-adorn-sink`) over a shared
analysis core. It reports where a `@Sensitive` value reaches one of adorn's **own** emitters, following the value
through same-function aliases, template interpolation, and destructuring. It is **report-only, permanently**,
prints its own scope on every run, and states its two limits plainly rather than chasing them: `s.ssn.slice(-4)`
is caught by nothing (a regulatory judgement, not a library's), and adorn secures *its own* emissions only — a
raw `console.log` of a sensitive value is yours. See [Observability & privacy](observability.md) for the
`@Sensitive` model this detector guards.
