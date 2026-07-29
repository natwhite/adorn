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
 *     the span is the active context while the body runs and nested decorated methods / auto-instrumented
 *     I/O parent under it. The span is **ended at *settlement*** using the exported `settle` classifier —
 *     never a re-timed clock and never a reimplementation of the sync/thenable/observable classification,
 *     so the span's duration is the same settled number `@Time` and the `completed` event report and
 *     cannot drift (DEC-006). This is the concrete mechanism that prevents "flat, early-ended spans": an
 *     `async` method returns a pending promise in ~0 ms, but the span ends only when that promise settles.
 *   - **`completed` → a duration histogram** (optional, opt-in via a `Meter`). The span is already owned
 *     by `scope`; the record path adds the metric.
 *   - **`violation` → `span.recordException` + error status + a value-free span event** carrying the
 *     `ViolationFacts` (constraint / kind / trust / blame / expectation) as attributes, plus an optional
 *     `adorn.contract.violations` counter. Because adorn's enforcement wrapper is *outside* `@Observe`'s
 *     span, a violation never coincides with its own method's live span (a precondition throws before the
 *     span opens; a postcondition after it has settled). So a violation is recorded on the **currently
 *     active** span (the enclosing observed operation) when one exists, and otherwise on a short
 *     standalone span, so the exception is never silently lost.
 *   - **`message` → a span event** on the active-or-standalone span.
 *
 * ## "Seeing ≠ emitting" (DEC-036), preserved end-to-end
 *
 * Span attributes come **only** from pre-disclosed data: the `EmittedValue[]` on the `scope` call and the
 * record events, each already `[REDACTED]` unless a `@Telemetry` opt-in permitted it (and never when
 * `@Sensitive` vetoes). This sink forwards those renderings verbatim; it **never** reads a raw argument or
 * return value to put on a span. The `scope` around-wrapper *does* see the raw settled value/error through
 * its own `settle` (as `@Time` does) — but it uses that only for control flow (span status, and
 * `recordException` on a developer-authored thrown error, DEC-025), never to emit an argument/return.
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
    metrics as otelMetrics,
    SpanKind as OtelSpanKind,
    SpanStatusCode,
    type Tracer,
    type Meter,
    type Span,
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

    return {
        scope<T>(call: ObservationCall, proceed: () => T): T {
            const observation = call.observation;
            return tracer.startActiveSpan(
                observation.name,
                {
                    kind: mapSpanKind(observation.kind),
                    // Pre-disclosed argument renderings only — never a raw value (DEC-036).
                    attributes: attributesFromValues(call.values, prefix),
                },
                (span: Span) =>
                    // End at settlement via the SHARED classifier — never a re-timed clock (DEC-006).
                    // The around-wrapper sees the raw settled value/error here, but emits neither: the
                    // value never reaches an attribute, and only a developer-authored throw is recorded.
                    settle(proceed, (settlement: Settlement<T>) => finishSpan(span, settlement)),
            );
        },

        record(event: ObservationEvent): void {
            switch (event.kind) {
                case 'completed':
                    if (durationHistogram) {
                        durationHistogram.record(event.durationMs, {
                            [`${prefix}.method`]: event.observation.name,
                            [`${prefix}.outcome`]: event.outcome,
                            [`${prefix}.kind`]: event.observation.kind,
                        });
                    }
                    return;
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
// Span lifecycle — end via the shared settle classifier
// ---------------------------------------------------------------------------

/**
 * End the method's own span at settlement. On a throw the raw error is developer-authored (DEC-025) and is
 * recorded as the span's exception with an ERROR status; on a return the span carries no value (the
 * disclosed return rendering, if any, is not correlatable to this span through the seam and stays off it).
 */
function finishSpan<T>(span: Span, settlement: Settlement<T>): void {
    try {
        if (settlement.outcome === 'threw') {
            span.recordException(toException(settlement.error));
            span.setStatus({code: SpanStatusCode.ERROR, message: exceptionMessage(settlement.error)});
        } else {
            span.setStatus({code: SpanStatusCode.OK});
        }
    } finally {
        // Always end — a broken status/exception path must never leak an unfinished span.
        span.end();
    }
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
 * parameter and `adorn.return` for the return value. The `rendering` is forwarded verbatim — it is already
 * the disclosure OUTCOME (`[REDACTED]`, a value under an opt-in, or a surrogate), so no raw value is ever
 * read. A `null` rendering becomes the string `'null'` because OTel attributes cannot hold a null scalar.
 */
export function attributesFromValues(values: ReadonlyArray<EmittedValue>, prefix = 'adorn'): OtelAttributes {
    const attributes: OtelAttributes = {};
    for (const value of values) {
        attributes[attributeKey(value, prefix)] = renderingToAttribute(value.rendering);
    }
    return attributes;
}

function attributeKey(value: EmittedValue, prefix: string): string {
    if (value.index === RETURN_INDEX) return `${prefix}.return`;
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
