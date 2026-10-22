# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and adorn follows
[Semantic Versioning](https://semver.org/). Pre-1.0, minor releases may include breaking changes.

## [0.1.1] — 2026-10-22

A documentation release. No runtime or API changes — this patches the docs the npm page serves and the
tooling that keeps them honest.

### Fixed

- The published README's examples imported `toolSchemaForMethod` and `toolSchemaFrom` from the package
  root, but the 0.1.0 surface curation moved the projections to `adorn/schema` (and the observation reads
  to `adorn/observe`). Every documented import now names the correct entry point.

### Changed

- The README is now a lean overview; the full reference lives in topical guides under `docs/`
  (decorators, schemas, functional API, observability, add-ons). Internal decision-log codes and the
  pre-publish "not yet on npm" caveats are gone, and the artifacts table names real entry points.
- Corrected the 0.1.0 entry below (the provider profile, optional metadata, co-equal descriptor API) and
  the decorator-roadmap naming: TC39 standard decorators are at Stage 2.7, so the planned adapter is
  `adorn/standard`, not `adorn/stage3`.

### Added (repo tooling, not shipped in the package)

- Executable-docs CI: every `import … from 'adorn…'` in the README and guides is typechecked against the
  **packed** artifact under ESM/NodeNext, CJS/Node16, and bundler consumer fixtures, so a documented import
  cannot drift from the published surface again.
- A pre-commit hook (`npm run hooks`) that runs Prettier on staged files.

## [0.1.0] — 2026-10-18

First public release — contracts as data for TypeScript. One declaration is the single source for
runtime validation, JSON Schema, an LLM tool schema, documentation, and observability, so they don't
drift by construction.

### Added

- **Contract core** — parameter, field, and method decorators that record reified constraint
  *descriptors* (an identity plus JSON-serialisable params, with the predicate derived from those
  params), installed and enforced by `@Contract()` / `@Validate()`. Field and method-parameter
  inheritance: a subclass strengthens, never weakens.
- **Constraint vocabulary** — numeric and string constraints (length, pattern, and the validating
  formats `@Uuid` / `@DateTime` / `@Ipv4` / `@Format`), `@OneOf` / `@Const` membership, and the
  compositional `@ArrayOf`, `@Dictionary` (open maps), `@Shape` (class-backed DTOs), `@Fields`
  (optional-aware object literals), and `@Nullable`. Author your own with `defineConstraint`.
- **LLM tool-calling** — `toolSchemaForMethod` (from a decorated method) and `toolSchemaFrom`
  (descriptor-first, so a per-session enum needs no class) emit the prescriptive `parameters` object a
  function-calling API expects; the same declaration validates the model's reply. Both take
  a provider profile (`{ provider: 'openai', strict: true }`) to emit OpenAI-strict-compatible schemas
  (recursive; nullability lives in the declaration). The output was round-tripped end-to-end through OpenAI `gpt-4o-mini`.
- **Imperative validation** — `Verify.that` (throws) and `Verify.check` (non-throwing; narrows
  `unknown` to the constraint's output type, with the failing `path` and `expected` on a violation).
- **Pre / postconditions** — `@Requires` (cross-parameter precondition), `@EnabledWhen` (state-reading
  enabledness guard that receives the instance), `@Ensures` (closure postcondition), and `@Returns`
  (reified, projectable postcondition).
- **Functional surface** — `contract(spec, fn)` enforces params / requires / ensures / returns (sync and
  async) on a plain function with no class or decorator; `violationFromCheck` feeds a functional refusal
  into the same observation stream.
- **`adorn/test`** (subpath export, optional `fast-check` peer) — property-based testing derived from
  the contract: `fuzzMethod` / `fuzzClass` / `fuzzFunction` (and async variants) with sound generation
  (generate only inputs the contract accepts, or decline and say so), including object / composite
  generation, plus `fuzzSequence`, a stateful call-sequence tester that respects `@EnabledWhen`.
- **`adorn/otel`** (subpath export, optional `@opentelemetry/api` peer) — `createOtelSink()` maps the
  observation seam onto OpenTelemetry spans, a duration histogram, and value-free violation events.
- **Projections & CLI** — Markdown documentation, descriptive JSON Schema (draft 2020-12), the
  prescriptive tool schema, and a telemetry / privacy-review report; the `adorn` CLI
  (`docs` / `schema` / `check`).
- **Observability & safety** — a neutral, zero-dependency observation seam; safe-by-default redaction
  (`@Sensitive` / `@Telemetry`) that redacts adorn's own emissions with no annotation required; and a
  build-time sensitive-flow detector.

### Notes

- The only runtime dependency is `tslib`.
- Two co-equal authoring paths. Decorator *syntax* needs only `experimentalDecorators` —
  `emitDecoratorMetadata` is optional and purely cosmetic (it fills an inferred `Type` column in generated
  docs, nothing more). The same constraints are equally usable directly (`Verify.check`, the `*Contracts`
  namespaces and the `Contracts` facade, `contract()`, `toolSchemaFrom`) with no compiler flags — a
  co-equal authoring path, not a fallback.
- The root `adorn` is the authoring surface; the projections, registry introspection, observation
  plumbing, and privacy review are grouped onto curated subpath exports (`adorn/schema`,
  `adorn/introspection`, `adorn/observe`, `adorn/privacy`) so a consumer imports only what it uses.
- The add-ons ship inside the package as subpath exports (`adorn/test`, `adorn/otel`); importing the
  package root never loads them or their peers.
- Shipped `.d.ts` files compile under a consumer's `strict: true`; the library itself builds with
  `strict: true`.
- Published from GitHub Actions via npm Trusted Publishing, with provenance.

[0.1.1]: https://github.com/natwhite/adorn/releases/tag/v0.1.1
[0.1.0]: https://github.com/natwhite/adorn/releases/tag/v0.1.0
