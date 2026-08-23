/**
 * `@adorn/otel` — the OpenTelemetry binding for adorn's O1 observation stream (DEC-041, DEC-044/045).
 *
 * ## What this is
 *
 * A single factory, {@link createOtelSink}, that returns an {@link ObservationSink} a host installs via
 * the public `setObservationSink(...)`. It is a *pure projection* of the frozen O1 seam onto
 * OpenTelemetry: it consumes ONLY the package's public surface (`../../index`) — exactly as a published
 * downstream consumer would — and names no core internal. `@opentelemetry/api` is the add-on's declared
 * **peer** (a devDependency in this repo, for building and testing); it never enters core and never
 * reaches `dist/` (asserted by `isolation.test.ts`, the DEC-019/DEC-044 lesson applied to OTel).
 *
 * ## The mapping (DEC-041 §3)
 *
 *   - **`scope(call, proceed)` → an active span.** `tracer.startActiveSpan(name, {kind}, span => …)` so
 *     the span is the active context while the synchronous prefix runs and nested decorated methods /
 *     auto-instrumented I/O parent under it. The `settle` classifier records the span's OUTCOME (status,
 *     and a developer-authored throw's exception) at settlement — never a re-timed clock, never a
 *     reimplementation of the sync/thenable/observable classification. The span is **ended by its
 *     correlated `completed` event** (below), not inside `scope` — see "The span lifecycle" note.
 *   - **`completed` → ends the method's own span (Q-27) + a duration histogram** (histogram optional,
 *     opt-in via a `Meter`). Correlated to its `scope` span by the per-call `callId` (DEC-047), the
 *     completion lands the disclosed RETURN rendering on the span and ends it at `startTime + durationMs`,
 *     so the span duration IS the settled number `@Time` and the metric report and cannot drift (DEC-006).
 *     An `async` method returns a pending promise in ~0 ms, but its completion — and thus its span end —
 *     fires only when the promise settles, so spans are never "flat" or early-ended.
 *   - **`violation` → `span.recordException` + error status + a value-free span event** carrying the
 *     `ViolationFacts` (constraint / kind / trust / blame / expectation) as attributes, plus an optional
 *     `adorn.contract.violations` counter. Because adorn's enforcement wrapper is *outside* `@Observe`'s
 *     span, a violation never coincides with its own method's live span (a precondition throws before the
 *     span opens; a postcondition after it has settled). So a violation is recorded on the **currently
 *     active** span (the enclosing observed operation) when one exists, and otherwise on a short
 *     standalone span, so the exception is never silently lost.
 *   - **`message` → a span event** on the active-or-standalone span.
 *
 * ## The span lifecycle — end at the correlated `completed`, not inside `scope` (Q-27, DEC-047)
 *
 * DEC-046 ended the span inside `scope` via `settle` because the event union carried no per-call
 * correlation token, so under concurrent same-method async a record-path event could not be matched back
 * to its span. That is now fixed: `ObservationCall` and every `ObservationEvent` carry a `callId`
 * (Q-27), so this sink opens the span in `scope`, registers it under that id, and ends it when its
 * **own** `completed` event arrives (Option B). The single win DEC-046 could not have: the disclosed
 * **return-value** rendering only exists on the `completed` record event, and now lands on the method's
 * own span (`adorn.return`) before it closes — impossible under the old end-in-`scope` lifecycle, where
 * the span was already gone by the time the rendering was produced. Duration is unaffected: the span is
 * ended at `startTime + completed.durationMs`, the same settled number the metric and completion carry
 * (DEC-006, no re-timed clock). Active-context nesting is unaffected too — the span is still active only
 * for the synchronous prefix inside `startActiveSpan`'s callback, exactly as before. `scope` always
 * emits a correlated `completed` (returned or threw), so a registered span is always ended, exactly once.
 *
 * ## "Seeing ≠ emitting" (DEC-036), preserved end-to-end
 *
 * Span attributes come **only** from pre-disclosed data: the `EmittedValue[]` on the `scope` call (the
 * arguments) and on the `completed` event (arguments + the return rendering), each already `[REDACTED]`
 * unless a `@Telemetry` opt-in permitted it (and never when `@Sensitive` vetoes) — an un-opted return
 * carries no `EmittedValue` at all, so nothing about it reaches the span. This sink forwards those
 * renderings verbatim; it **never** reads a raw argument or return value to put on a span. The `scope`
 * around-wrapper *does* see the raw settled value/error through its own `settle` (as `@Time` does) — but
 * it uses that only for control flow (span status, and `recordException` on a developer-authored thrown
 * error, DEC-025), never to emit an argument/return.
 */

import {
    settle,
    RETURN_INDEX,
    type ObservationSink,
    type ObservationCall,
    type ObservationEvent,
    type Observation,
    type EmittedValue,
    type ViolationFacts,
    type ErrorFacts,
    type Attributes as AdornAttributes,
    type SpanKind as AdornSpanKind,
    type Settlement,
} from '../../index';
import {
    trace,
    context as otelContext,
    metrics as otelMetrics,
    SpanKind as OtelSpanKind,
    SpanStatusCode,
    type Tracer,
    type Meter,
    type Span,
    type Context,
    type Attributes as OtelAttributes,
    type AttributeValue as OtelAttributeValue,
    type Exception,
    type Histogram,
    type Counter,
} from '@opentelemetry/api';

/** The add-on's own version, used to name the default `Tracer`/`Meter` (OTel instrumentation-scope). */
export const ADORN_OTEL_VERSION = '0.1.0';

/** Options for {@link createOtelSink}. Every field is optional — the zero-config case wires the globals. */
export interface OtelSinkOptions {
    /**
     * The `Tracer` spans are created on. Defaults to the global provider's
     * `trace.getTracer('@adorn/otel', {@link ADORN_OTEL_VERSION})`, so a host that has registered its own
     * SDK gets its tracer with no wiring; a test passes an in-memory-exporter tracer explicitly.
     */
    readonly tracer?: Tracer;
    /**
     * The `Meter` metrics are recorded on. Metrics are a *secondary nicety* and strictly opt-in: when this
     * is omitted **no** instruments are created and the record path stays span-only. Pass a meter (or set
     * {@link OtelSinkOptions.useGlobalMeter}) to record a duration histogram and a violations counter.
     */
    readonly meter?: Meter;
    /**
     * When `true` and no {@link OtelSinkOptions.meter} is given, resolve the global
     * `metrics.getMeter('@adorn/otel', …)`. Left `false` by default so metrics never appear unless asked
     * for (a no-op meter provider would otherwise create dormant instruments).
     */
    readonly useGlobalMeter?: boolean;
    /**
     * Namespace for the attribute/metric/event keys this sink writes. Defaults to `'adorn'`, producing
     * `adorn.param.<name>`, `adorn.return`, `adorn.violation.constraint`, `adorn.method.duration`, …
     */
    readonly attributePrefix?: string;
}

/**
 * Build an {@link ObservationSink} that projects adorn's O1 stream onto OpenTelemetry. Install it with the
 * public `setObservationSink(createOtelSink({tracer, meter}))`; the host owns and wires its OTel SDK.
 *
 * @example
 *   import {setObservationSink} from 'adorn';
 *   import {createOtelSink} from '@adorn/otel';
 *   import {trace, metrics} from '@opentelemetry/api';
 *
 *   setObservationSink(createOtelSink({tracer: trace.getTracer('app'), meter: metrics.getMeter('app')}));
 */
export function createOtelSink(options: OtelSinkOptions = {}): ObservationSink {
    const tracer: Tracer = options.tracer || trace.getTracer('@adorn/otel', ADORN_OTEL_VERSION);
    const meter: Meter | undefined =
        options.meter ||
        (options.useGlobalMeter ? otelMetrics.getMeter('@adorn/otel', ADORN_OTEL_VERSION) : undefined);
    const prefix = options.attributePrefix || 'adorn';

    // Instruments are built once, only when a meter is supplied — spans+exceptions are the required core,
    // metrics are the opt-in add-on (DEC-041 §3).
    const durationHistogram: Histogram | undefined = meter
        ? meter.createHistogram(`${prefix}.method.duration`, {
              unit: 'ms',
              description: 'Duration of an adorn-observed method, from the shared settle classifier.',
          })
        : undefined;
    const violationCounter: Counter | undefined = meter
        ? meter.createCounter(`${prefix}.contract.violations`, {
              description: 'adorn contract violations, dimensioned by the value-free ViolationFacts.',
          })
        : undefined;

    // Spans opened by `scope` but not yet ended, keyed by the per-call correlation id (Q-27, DEC-047).
    // The `completed` record event for that same id ends the span — after enriching it with the disclosed
    // RETURN rendering, which only exists on the record path. Per-sink (a closure field, not a module
    // global) so a fresh `createOtelSink` starts clean. See the header's "The span lifecycle" note.
    const pendingSpans = new Map<number, PendingSpan>();

    // Every span this sink creates, retained (bounded, oldest-evicted) so a later `completed` carrying a
    // `parentCallId` (L15, DEC-076) can nest under the parent's span even after it has ended — the record-only
    // TREE case, where the parent is not a live active context. Bounded so a long-running process cannot grow it.
    const retainedSpans = new Map<number, Span>();
    const retainSpan = (callId: number, span: Span): void => {
        retainedSpans.set(callId, span);
        if (retainedSpans.size > RETAINED_SPAN_CAP) {
            const oldest = retainedSpans.keys().next().value;
            if (oldest !== undefined) retainedSpans.delete(oldest);
        }
    };

    return {
        scope<T>(call: ObservationCall, proceed: () => T): T {
            const observation = call.observation;
            // One epoch-ms clock for BOTH the span's start and its later explicit end (in finishPendingSpan),
            // so the span's duration is EXACTLY the settled `completed.durationMs` and cannot drift (DEC-006).
            const startTime = Date.now();
            return tracer.startActiveSpan(
                observation.name,
                {
                    kind: mapSpanKind(observation.kind),
                    startTime,
                    // Pre-disclosed argument renderings only — never a raw value (DEC-036).
                    attributes: attributesFromValues(call.values, prefix),
                },
                (span: Span) => {
                    // Q-27/DEC-047: register the span under the per-call id so the correlated `completed`
                    // event can end it AFTER adding the disclosed return rendering (which does not exist
                    // yet — it is produced when the call settles, on the record path). The span is active
                    // only for the synchronous prefix here, exactly as before; only the END is deferred.
                    pendingSpans.set(call.callId, {span, startTime});
                    retainSpan(call.callId, span); // available as a parentCallId target (L15)
                    // The SHARED settle classifier still owns the outcome (status + a developer-authored
                    // throw's exception) from the raw settlement — control-flow only, emitting no value
                    // (DEC-036/DEC-025). It no longer ends the span; finishPendingSpan does, at `completed`.
                    return settle(proceed, (settlement: Settlement<T>) => markSpanOutcome(span, settlement));
                },
            );
        },

        record(event: ObservationEvent): void {
            switch (event.kind) {
                case 'completed': {
                    // End the method's own span (opened by `@Observe`'s `scope`) once its correlated
                    // completion arrives, landing the disclosed return rendering on it (Q-27 — the win).
                    const pending = pendingSpans.get(event.callId);
                    if (pending) {
                        finishPendingSpan(pendingSpans, event, prefix);
                    } else if (event.startedAt !== undefined) {
                        // Record-only positioning (L14): a completion whose id opened no `scope` span, but
                        // carries an explicit `startedAt`, is placed on the timeline at `[startedAt, +duration]`
                        // — nested under `parentCallId` (L15) when that parent span is still retained.
                        createPositionedSpan(
                            tracer,
                            event,
                            prefix,
                            parentContextFor(retainedSpans, event.parentCallId),
                            retainSpan,
                        );
                    }
                    // else: an enforcement-weave completion (no scope span, no explicit start) still opens none.
                    if (durationHistogram) {
                        durationHistogram.record(event.durationMs, {
                            [`${prefix}.method`]: event.observation.name,
                            [`${prefix}.outcome`]: event.outcome,
                            [`${prefix}.kind`]: event.observation.kind,
                        });
                    }
                    return;
                }
                case 'violation':
                    recordViolation(tracer, event.observation, event.violation, event.error, prefix);
                    if (violationCounter) {
                        violationCounter.add(1, {
                            [`${prefix}.violation.constraint`]: event.violation.constraint,
                            [`${prefix}.violation.kind`]: event.violation.kind,
                            [`${prefix}.violation.trust`]: event.violation.trust,
                            [`${prefix}.violation.blame`]: event.violation.blame,
                        });
                    }
                    return;
                case 'message':
                    recordMessage(tracer, event, prefix);
                    return;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Span lifecycle — settle sets the outcome, the correlated `completed` ends it (Q-27, DEC-047)
// ---------------------------------------------------------------------------

/** An opened-but-not-yet-ended span and the epoch-ms start it will be ended relative to (DEC-006). */
interface PendingSpan {
    readonly span: Span;
    readonly startTime: number;
}

/**
 * Record the settled OUTCOME on the span from the raw settlement — the span's status, and, on a throw, the
 * developer-authored exception (DEC-025). Control-flow only: it emits no argument/return (DEC-036). It does
 * NOT end the span — the end is deferred to {@link finishPendingSpan} so the disclosed return rendering,
 * which only exists once the call has settled on the record path, can land on the span before it closes.
 */
function markSpanOutcome<T>(span: Span, settlement: Settlement<T>): void {
    if (settlement.outcome === 'threw') {
        span.recordException(toException(settlement.error));
        span.setStatus({code: SpanStatusCode.ERROR, message: exceptionMessage(settlement.error)});
    } else {
        span.setStatus({code: SpanStatusCode.OK});
    }
}

/**
 * End the pending span correlated to a `completed` event by its per-call id (Q-27, DEC-047) — the concrete
 * close of the DEC-046 correlation gap. This is where the disclosed RETURN rendering (an `EmittedValue` at
 * `RETURN_INDEX`, pre-disclosed on the record path — `[REDACTED]`/absent unless a `@Telemetry.result()`
 * opt-in permitted it, DEC-036) finally lands on the method's OWN span, which the previous end-in-`scope`
 * lifecycle could not attach because the rendering did not exist until after the span had closed.
 *
 * A completion whose id opened no span here — an enforcement-weave completion, which never opens a `scope`
 * — matches nothing and ends nothing, exactly as before (it still feeds the duration histogram above).
 *
 * The span is ended at `startTime + durationMs`, so its duration IS the settled `completed.durationMs`
 * (produced upstream by the shared `settle` classifier) and cannot drift from the metric or the completion
 * (DEC-006) — the property DEC-046 secured by ending in `scope`, preserved here without a re-timed clock.
 */
function finishPendingSpan(
    pending: Map<number, PendingSpan>,
    event: Extract<ObservationEvent, {kind: 'completed'}>,
    prefix: string,
): void {
    const entry = pending.get(event.callId);
    if (!entry) return;
    pending.delete(event.callId);
    // Only the RETURN rendering — the arguments were already attached at span start by `scope`. Forwarded
    // verbatim as the disclosure OUTCOME; no raw value is ever read (DEC-036). Absent on a throw.
    const returns = (event.values || []).filter(value => value.index === RETURN_INDEX);
    if (returns.length > 0) entry.span.setAttributes(attributesFromValues(returns, prefix));
    entry.span.end(entry.startTime + event.durationMs);
}

/** Bound on the retained-span map, so a long-running process cannot grow it without limit (L15, DEC-076). */
const RETAINED_SPAN_CAP = 2048;

/** The parent context to create a span under, when a `completed` event names a still-retained `parentCallId`. */
function parentContextFor(retained: Map<number, Span>, parentCallId: number | undefined): Context | undefined {
    if (parentCallId === undefined) return undefined;
    const parent = retained.get(parentCallId);
    return parent ? trace.setSpan(otelContext.active(), parent) : undefined;
}

/**
 * Create a span POSITIONED from a record-only `completed` event's explicit `startedAt` (L14/L15, DEC-076) —
 * the retroactive interval that opened no `scope` span. Placed at `[startedAt, startedAt + durationMs]`, so its
 * duration is exactly the settled `durationMs` (no re-timed clock, DEC-006); nested under `parentCtx` when a
 * `parentCallId` resolved to a retained span. A record-only completion carries ALL disclosed values (args AND
 * return renderings) on `event.values`, so they are attached at creation. Retained as a parent for its children.
 */
function createPositionedSpan(
    tracer: Tracer,
    event: Extract<ObservationEvent, {kind: 'completed'}>,
    prefix: string,
    parentCtx: Context | undefined,
    retain: (callId: number, span: Span) => void,
): void {
    const startTime = event.startedAt as number;
    const span = tracer.startSpan(
        event.observation.name,
        {
            kind: mapSpanKind(event.observation.kind),
            startTime,
            attributes: attributesFromValues(event.values || [], prefix),
        },
        parentCtx,
    );
    if (event.outcome === 'threw' && event.error) {
        span.recordException({name: event.error.type, message: event.error.message});
        span.setStatus({code: SpanStatusCode.ERROR, message: event.error.message});
    } else {
        span.setStatus({code: SpanStatusCode.OK});
    }
    span.end(startTime + event.durationMs);
    retain(event.callId, span);
}

// ---------------------------------------------------------------------------
// Violations and messages — recorded on the active span, else a standalone one
// ---------------------------------------------------------------------------

/**
 * Record a contract violation. The enforcement wrapper is outside `@Observe`'s span, so the violated
 * method's own span is never live here — the violation is attributed to the enclosing observed operation's
 * span when one is active, and otherwise gets a short standalone span so it is never silently dropped.
 */
function recordViolation(
    tracer: Tracer,
    observation: Observation,
    facts: ViolationFacts,
    error: ErrorFacts | undefined,
    prefix: string,
): void {
    const attributes = violationAttributes(facts, prefix);
    withTargetSpan(tracer, observation, span => {
        if (error) span.recordException(errorFactsToException(error));
        span.addEvent(`${prefix}.contract.violation`, attributes);
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error && error.message) || facts.expectation,
        });
    });
}

/** Record an O1 `message` event as a span event on the active-or-standalone span. */
function recordMessage(
    tracer: Tracer,
    event: Extract<ObservationEvent, {kind: 'message'}>,
    prefix: string,
): void {
    const attributes: OtelAttributes = {
        [`${prefix}.log.level`]: event.level,
        ...toOtelAttributes(event.attributes),
        ...attributesFromValues(event.values || [], prefix),
    };
    withTargetSpan(tracer, event.observation, span => {
        span.addEvent(event.message || `${prefix}.message`, attributes);
    });
}

/**
 * Run `use` against the currently active span if it is recording; otherwise open a short standalone span
 * named after the observation, run `use`, and end it. Either way the caller's enrichment lands on a span.
 */
function withTargetSpan(tracer: Tracer, observation: Observation, use: (span: Span) => void): void {
    const active = trace.getActiveSpan();
    if (active && active.isRecording()) {
        use(active);
        return;
    }
    const span = tracer.startSpan(observation.name, {kind: mapSpanKind(observation.kind)});
    try {
        use(span);
    } finally {
        span.end();
    }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

/** adorn's string `SpanKind` → the OTel enum. `'internal'` is the default and fabricates nothing. */
export function mapSpanKind(kind: AdornSpanKind): OtelSpanKind {
    switch (kind) {
        case 'server':
            return OtelSpanKind.SERVER;
        case 'client':
            return OtelSpanKind.CLIENT;
        case 'producer':
            return OtelSpanKind.PRODUCER;
        case 'consumer':
            return OtelSpanKind.CONSUMER;
        case 'internal':
        default:
            return OtelSpanKind.INTERNAL;
    }
}

/**
 * Project pre-disclosed `EmittedValue[]` onto OTel span attributes. Keyed `adorn.param.<name|index>` for a
 * parameter, `adorn.return` for the canonical return rendering, and `adorn.return.<name>` for any OTHER named
 * fact a consumer attaches at close (voice-agent L13) — so several named close-time facts each get a slot
 * instead of colliding. The `rendering` is forwarded verbatim — it is already the disclosure OUTCOME
 * (`[REDACTED]`, a value under an opt-in, or a surrogate), so no raw value is ever read. A `null` rendering
 * becomes the string `'null'` because OTel attributes cannot hold a null scalar.
 */
export function attributesFromValues(values: ReadonlyArray<EmittedValue>, prefix = 'adorn'): OtelAttributes {
    const attributes: OtelAttributes = {};
    for (const value of values) {
        attributes[attributeKey(value, prefix)] = renderingToAttribute(value.rendering);
    }
    return attributes;
}

function attributeKey(value: EmittedValue, prefix: string): string {
    if (value.index === RETURN_INDEX) {
        // The canonical single return rendering carries name `'return'` (the decorator path) or none → the
        // bare `.return` key, UNCHANGED (voice-agent L13). Any OTHER name is a distinct fact a consumer
        // attached at close — token counts, disposition, turn count — and earns its own `.return.<name>` slot,
        // so several named facts no longer collide on one attribute (last-write-wins). Backward compatible:
        // treating `'return'` as the sentinel is what keeps every existing `@Telemetry.result()` key exactly
        // `adorn.return` (the return EmittedValue is built with `name:'return'`, not `undefined`).
        return value.name !== undefined && value.name !== 'return'
            ? `${prefix}.return.${value.name}`
            : `${prefix}.return`;
    }
    const suffix = value.name !== undefined ? value.name : value.index;
    return `${prefix}.param.${suffix}`;
}

function renderingToAttribute(rendering: string | number | boolean | null): OtelAttributeValue {
    return rendering === null ? 'null' : rendering;
}

/** The value-free `ViolationFacts` as span-event/counter attributes — safe unconditionally (DEC-035). */
export function violationAttributes(facts: ViolationFacts, prefix = 'adorn'): OtelAttributes {
    const attributes: OtelAttributes = {
        [`${prefix}.violation.constraint`]: facts.constraint,
        [`${prefix}.violation.kind`]: facts.kind,
        [`${prefix}.violation.expectation`]: facts.expectation,
        [`${prefix}.violation.trust`]: facts.trust,
        [`${prefix}.violation.blame`]: facts.blame,
        [`${prefix}.violation.parameterIndex`]: facts.parameterIndex,
    };
    if (facts.parameterName !== undefined)
        attributes[`${prefix}.violation.parameterName`] = facts.parameterName;
    if (facts.parameterType !== undefined)
        attributes[`${prefix}.violation.parameterType`] = facts.parameterType;
    return attributes;
}

/** Narrow an adorn `Attributes` map (low-cardinality, `undefined`-tolerant) to an OTel attribute map. */
function toOtelAttributes(attributes: AdornAttributes): OtelAttributes {
    const out: OtelAttributes = {};
    for (const key of Object.keys(attributes)) {
        const value = attributes[key];
        if (value !== undefined) out[key] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/** Structured, value-free `ErrorFacts` → an OTel `Exception`. `message` is redacted-by-default (BUG-19). */
function errorFactsToException(error: ErrorFacts): Exception {
    return {name: error.type, message: error.message, stack: error.stack};
}

/**
 * A raw thrown value → an OTel `Exception`. A real `Error` passes through (its `name`/`message`/`stack` are
 * developer-authored — DEC-025); anything else becomes a message-only exception. Never reads an argument.
 */
function toException(error: unknown): Exception {
    if (error instanceof Error) return error;
    if (error && typeof error === 'object') {
        const e = error as {name?: unknown; message?: unknown; stack?: unknown};
        return {
            name: typeof e.name === 'string' ? e.name : undefined,
            message: typeof e.message === 'string' ? e.message : String(error),
            stack: typeof e.stack === 'string' ? e.stack : undefined,
        };
    }
    return {message: String(error)};
}

function exceptionMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
        const message = (error as {message?: unknown}).message;
        if (typeof message === 'string') return message;
    }
    return String(error);
}
