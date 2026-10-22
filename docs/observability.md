# Observability & privacy

[← README](../README.md) · [Decorators & contracts](decorators.md) · [Schemas & projections](schemas.md) · [Functional API](functional-api.md) · [Add-ons](add-ons.md)

adorn emits what happens at a contract boundary — violations and completions — through a neutral, zero-dependency
sink, and it renders sensitive values as `[REDACTED]` **by default, without reading any annotation**. This guide
covers the observation seam (on the `adorn/observe` subpath) and the safe-by-default redaction model.

## The observation seam

A neutral, zero-dependency observation seam. `setObservationSink` / `getObservationSink` install one
around-shaped `ObservationSink`; the enforcement weave emits **value-free violation facts** and completions
through it, and `@Observe` emits completions carrying pre-disclosed values (redacted by default — *"seeing ≠
emitting"*). `settle` is the shared sync/thenable/observable settling classifier; `RETURN_INDEX` marks the return
value; `nextCallId` is the one shared correlation-id sequence a consumer's own emitter draws from (below);
`consoleObservationSink` is a ready-made opt-in JSON-to-console sink. The event union (`ObservationEvent`,
`ViolationFacts`, `EmittedValue`, `Settlement<T>`, …) is exported and additive.

> Installing a sink stays on the root (`setObservationSink` is a configuration verb, like `setViolationPolicy`);
> *reading* or *constructing* observation data lives on `adorn/observe`.

### Emitting without decorators

The stream isn't decorator-only — a functional codebase (no classes to `@Observe`) emits point events straight to
the installed sink, the observation analog of `Verify.check`:

```ts
import { getObservationSink, nextCallId } from 'adorn/observe';
import type { Observation } from 'adorn/observe';

const observation: Observation = {
    owner: 'reminders', member: 'schedule', name: 'reminders.schedule',
    isStatic: false, detail: 'always', kind: 'internal', parameters: [],
};
getObservationSink().record?.({
    kind: 'completed', observation, callId: nextCallId(),
    durationMs: 12, outcome: 'returned', settled: true,
    // startedAt?: number    — position a retroactive interval (epoch ms)
    // parentCallId?: number — nest it under another call's span
});
```

Draw the `callId` from **`nextCallId()`** — the one shared, monotonic sequence adorn's own wrappers use — so your
ids never collide with adorn's (a sink may key per-call state by `callId`, e.g. `createOtelSink`'s span nesting).
For an interval you *time* rather than *wrap*, add **`startedAt`** (epoch ms) so the sink can *position* the span,
and **`parentCallId`** to *nest* it: a record-only sink can then build a full waterfall tree with no context
manager.

`record` is the fire-and-forget point-event surface (`completed` / `violation` / `message`); `scope` is the
around-wrapper for span nesting. **If you drive `scope` yourself, mind the lifecycle:** `scope` *opens* the span,
but its correlated `completed` event *ends* it — matched by `callId`. Do **not** end the span inside `scope`, or
every async span is flat (it closes before the promise settles). Because
[`createOtelSink`](add-ons.md) maps *only* the public `ObservationSink`, a well-formed event you emit this way
becomes an OTel span/metric with no decorator in sight.

## `@Sensitive` / `@Telemetry` and safe-by-default redaction

`Sensitive()` marks a field, parameter, or class as holding sensitive data (record-only). The **redaction
runtime** makes it matter: every path adorn can emit a value through — `@Log`, violation messages, observation
events — renders `[REDACTED]` **by default, without reading any annotation**. `setValueDisclosure('all')` turns
raw values back on for local debugging; a `@Sensitive` marking *vetoes* even that (and the veto is surfaced, not
silenced). The safe default holds with zero `@Sensitive` anywhere — the annotation is defence-in-depth.
`Telemetry.value()` / `.redact(strategy)` / `.result()` opt a value *into* disclosure on the observation path.
See [`docs/sensitive.md`](sensitive.md).

The **privacy review** projection (`telemetryForClass` / `generateTelemetryReport`, on `adorn/privacy`) is the
static companion: a pure registry read reporting the disclosure each parameter and return carries, with no code
executed. The build-time [sensitive-flow detector](schemas.md#the-sensitive-flow-detector) catches `@Sensitive`
values that reach an adorn emitter.

> **The `@Sensitive` primitive-parameter gap is permanent.** `transfer(ssn: string)` must be marked on the
> parameter; JavaScript's value semantics destroy the link to a `@Sensitive` field. A method *return* likewise
> can't be directly `@Sensitive`; `@Telemetry.result()` gives the opt-in half, the veto half needs class-level
> `@Sensitive`.
