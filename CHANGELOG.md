# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and adorn follows
[Semantic Versioning](https://semver.org/). Pre-1.0, minor releases may include breaking changes.

## [0.1.0] — 2026-08-08

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
  `{ providerStrict }` to emit OpenAI-strict-compatible schemas (recursive; nullability lives in the
  declaration). The output was round-tripped end-to-end through OpenAI `gpt-4o-mini`.
- **Imperative validation** — `Verify.that` (throws) and `Verify.check` (non-throwing; narrows
  `unknown` to the constraint's output type, with the failing `path` and `expected` on a violation).
- **Pre / postconditions** — `@Requires` (cross-parameter precondition), `@Ensures` (closure
  postcondition), and `@Returns` (reified, projectable postcondition).
- **Projections & CLI** — Markdown documentation, descriptive JSON Schema (draft 2020-12), the
  prescriptive tool schema, and a telemetry / privacy-review report; the `adorn` CLI
  (`docs` / `schema` / `check`).
- **Observability & safety** — a neutral, zero-dependency observation seam; safe-by-default redaction
  (`@Sensitive` / `@Telemetry`) that redacts adorn's own emissions with no annotation required; and a
  build-time sensitive-flow detector.

### Notes

- The only runtime dependency is `tslib`.
- Decorators are the authoring path (`experimentalDecorators` / `emitDecoratorMetadata`). For a value
  with no signature to decorate — a raw `unknown` off the wire, a per-session schema — the same
  constraints are usable directly (`Verify.check`, the `*Contracts` namespaces, `toolSchemaFrom`) with
  those flags off; the escape hatch, not the front door.
- The `@adorn/test` (property-based testing) and `@adorn/otel` (OpenTelemetry) add-ons live in the
  repository but are not yet published to npm.

[0.1.0]: https://github.com/natwhite/adorn/releases/tag/v0.1.0
