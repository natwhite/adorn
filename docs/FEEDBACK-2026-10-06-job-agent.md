# Feedback from job-agent, 2026-10-06 (plan-4 application agent)

Measured against adorn `8a8b79a` through `file:../adorn` (symlinked `dist/`). The consumer is
job-agent `src/agent/*` (`memory.ts`, `snapshot.ts`, `decide.ts`, `walls.ts`, `audit.ts`,
`asks.ts`): six `@Contract()` classes, one strict OpenAI tool schema from `toolSchemaFrom`,
and `Verify.check` on every line read from disk. An adversarial review drove the contracts
with crafted inputs; what follows is what that exercise said about adorn.

## What worked

- **`@Contract()` + `@Validate()` + `@Requires` on an instance method enforces, including on
  internal calls.** `Memory.correct` calls `this.add(...)`; the `@Requires` on `add` (no
  government identifier in the text) threw through that internal path. That is the property
  the whole design leans on: one wall, declared once, holds on every route to the method.
- **`Verify.check` messages redact the offending value** (`[REDACTED]`). The agent writes
  `Verify` failures into an audit log that must never carry a typed value; the redaction made
  that safe without a wrapper. Worth a line in the README under `Verify`: consumers logging
  verification failures can rely on it.
- **Strict-mode projection is complete.** `toolSchemaFrom({...}, { providerStrict: true })`
  over nested `ObjectContracts.Fields` with `ArrayContracts.ArrayOf`, `NullableContracts.
  Nullable` and `EnumContracts.OneOf([true, false])` produced `required` listing every property
  and `additionalProperties: false` at every object level; nullable strings project as
  `type: ["string", "null"]` plus the pattern; the boolean enum projects as
  `{type: "boolean", enum: [true, false]}`. OpenAI's Responses API accepted it on ~40 calls.

## Findings

1. **`@NotEmpty()` accepts whitespace.** `'   '` passes (length-based, not trimmed). In
   job-agent a whitespace-only `text` reached `Memory.add`, was stored trimmed as `""`, and
   the stored line then failed the `\S` pattern in `EntryShape` on every later read, so one
   bad `--add` broke every subsequent load. Fixed on our side with an explicit
   `@Requires(text => text.trim().length > 0)`. Suggestion: either trim in `@NotEmpty` (a
   string of spaces is empty to every caller I can imagine) or offer `@NotBlank()` and say in
   the README which one does what.

2. **Without `@Contract()` on the class, per-method `@Validate()` silently does nothing.**
   The reviewer's scratch test: a plain class with `@Validate() @Requires(...)` on a method
   enforced nothing in either decorator order, with no warning. Every class in job-agent has
   `@Contract()`, so nothing was affected, but a consumer who forgets it gets a method that
   looks guarded and is not. A console warning (or a throw) when `@Validate` runs on a method
   of a class that was never wrapped by `@Contract` would turn a silent miss into a loud one.

3. **Decorator order is load-bearing and undocumented at the point of use.** `@Ensures` and
   `@Requires` must sit below `@Validate()` in source order (recorded in an earlier feedback
   doc; still true at `8a8b79a`). A one-line note in each decorator's JSDoc would save the
   next consumer the probe.

## Request

None blocking. The three above are quality-of-life; (1) is the one that bit.
