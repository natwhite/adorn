/**
 * `@adorn/otel` — the O1 → OpenTelemetry mapping, proven against REAL spans (DEC-041).
 *
 * Uses `@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter` so the assertions are about spans an OTel
 * backend would actually receive — not a mock of the API. It pins the contract the task requires:
 *
 *   - a `@Contract()`+`@Observe()` method produces one span named `Owner.method`, with the declared
 *     `SpanKind`, a duration *close to the settled duration*, and completes exactly once (DEC-037);
 *   - a contract violation produces `recordException` + an ERROR status + a value-free facts span event;
 *   - "seeing ≠ emitting" (DEC-036): an un-opted parameter renders `[REDACTED]` on the span while a
 *     `@Telemetry.value()` one renders its value, and the raw un-opted value appears nowhere on the span;
 *   - an async method's span ends on *settlement*, not on its ~0 ms return;
 *   - the opt-in metrics (duration histogram + violations counter).
 *
 * Decorators and the sink installer are imported from the package root (`../../index`) — the add-on is a
 * downstream consumer of the frozen public surface (DEC-045), reaching no `src/` internal from production
 * code. The two `reset*` helpers below are test scaffolding, as in the rest of the suite.
 */

import {SpanKind as OtelSpanKind, SpanStatusCode, type Meter} from '@opentelemetry/api';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
    type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import {Contract, Observe, Telemetry, GreaterThan, setObservationSink} from '../../index';
import {
    RETURN_INDEX,
    type ObservationEvent,
    type ObservationSink,
    type ObservationCall,
    type EmittedValue,
    type Observation,
} from '../../observe';
import {createOtelSink, mapSpanKind, attributesFromValues} from './index';

// Test scaffolding (not the public surface) — global registry/config reset between cases, as elsewhere.
import {resetRegistry} from '../../src/Core/ContractRegistry';
import {resetConfiguration} from '../../src/Core/Configuration';
import {resetValueDisclosure} from '../../src/Core/redaction';

// ---------------------------------------------------------------------------
// Harness — an in-memory exporter plus a completed/violation capture
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let completed: Array<Extract<ObservationEvent, {kind: 'completed'}>>;

/** Install the otel sink, wrapped so we can also see the raw `completed` durationMs the seam produced. */
function install(options: {meter?: Meter} = {}): void {
    const tracer = provider.getTracer('adorn-otel-test');
    const otel = createOtelSink({tracer, meter: options.meter});
    const sink: ObservationSink = {
        scope: otel.scope,
        record: event => {
            if (event.kind === 'completed') completed.push(event);
            otel.record!(event);
        },
    };
    setObservationSink(sink);
}

function finishedSpans(): ReadableSpan[] {
    return exporter.getFinishedSpans();
}

function hrToMs(hr: [number, number]): number {
    return hr[0] * 1e3 + hr[1] / 1e6;
}

function eventNamed(span: ReadableSpan, name: string) {
    return span.events.find(e => e.name === name);
}

beforeEach(() => {
    resetRegistry();
    resetConfiguration();
    resetValueDisclosure();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter)]});
    completed = [];
});

afterEach(() => {
    setObservationSink(null);
    exporter.reset();
});

// ---------------------------------------------------------------------------
// scope → span: name, kind, duration, single completion
// ---------------------------------------------------------------------------

describe('scope maps a @Contract()+@Observe() call to one span', () => {
    it('produces a span named Owner.method with the internal kind and one completion', () => {
        install();

        @Contract()
        class Ledger {
            @Observe()
            debit(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        expect(new Ledger().debit(10)).toBe(10); // the value is unchanged

        const spans = finishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('Ledger.debit');
        expect(spans[0].kind).toBe(OtelSpanKind.INTERNAL);
        expect(spans[0].status.code).toBe(SpanStatusCode.OK);

        // The DEC-037 reconciliation, seen from the consumer side: the sink sees `completed` exactly once.
        expect(completed).toHaveLength(1);
    });

    it('honours the declared @Observe({kind}) → OTel SpanKind (Q-24 R7)', () => {
        install();

        class Api {
            @Observe({kind: 'client'})
            fetch(id: string): string {
                return id;
            }
        }

        new Api().fetch('u1');
        expect(finishedSpans()[0].kind).toBe(OtelSpanKind.CLIENT);
    });

    it('ends the span with a duration close to the settled duration (one number, no re-time)', () => {
        install();

        class Svc {
            @Observe()
            work(n: number): number {
                return n * 2;
            }
        }

        new Svc().work(21);

        const spanMs = hrToMs(finishedSpans()[0].duration);
        expect(spanMs).toBeGreaterThanOrEqual(0);
        // The span is ended via the SAME `settle` classifier the `completed` event came from, so the two
        // durations agree to within timing jitter — never a re-measured wall clock that could drift.
        expect(Math.abs(spanMs - completed[0].durationMs)).toBeLessThan(5);
    });

    it('records a body throw as the span exception + ERROR status, and still propagates', () => {
        install();

        class Svc {
            @Observe()
            boom(): number {
                throw new TypeError('nope');
            }
        }

        expect(() => new Svc().boom()).toThrow(/nope/);

        const span = finishedSpans()[0];
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        const exception = eventNamed(span, 'exception');
        expect(exception?.attributes?.['exception.type']).toBe('TypeError');
        expect(exception?.attributes?.['exception.message']).toBe('nope');
        // Exactly ONE exception event: `markSpanOutcome` records it (from the raw settlement) and
        // `finishPendingSpan` must NOT record it again on the @Observe ordering (L18/DEC-081 regression guard).
        expect(span.events.filter(e => e.name === 'exception')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// async settlement — the span ends when the work settles, not when it returns
// ---------------------------------------------------------------------------

describe('an async span ends on settlement, not on return', () => {
    it('spans an awaited delay rather than the ~0ms promise return', async () => {
        install();

        class Svc {
            @Observe()
            async load(): Promise<string> {
                await new Promise(resolve => setTimeout(resolve, 30));
                return 'done';
            }
        }

        expect(await new Svc().load()).toBe('done');

        const spans = finishedSpans();
        expect(spans).toHaveLength(1);
        // Had the span ended on the synchronous promise return it would be ~0ms; ending on settlement it
        // spans the full awaited delay.
        expect(hrToMs(spans[0].duration)).toBeGreaterThan(20);
        expect(spans[0].status.code).toBe(SpanStatusCode.OK);
        expect(completed).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// violation → recordException + error status + value-free facts
// ---------------------------------------------------------------------------

describe('a contract violation is recorded as a span exception with value-free facts', () => {
    it('records the exception, sets ERROR status, and carries the value-free ViolationFacts', () => {
        install();

        @Contract()
        class Ledger {
            @Observe()
            debit(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        expect(() => new Ledger().debit(-1)).toThrow(/greater than 0/); // enforcement is untouched

        // The precondition throws before @Observe's scope opens, so there is no method span and no
        // active span; the violation lands on a standalone span so the exception is never lost.
        const violationSpan = finishedSpans().find(s => eventNamed(s, 'adorn.contract.violation'));
        expect(violationSpan).toBeDefined();
        expect(violationSpan!.name).toBe('Ledger.debit');
        expect(violationSpan!.status.code).toBe(SpanStatusCode.ERROR);

        // recordException fired.
        expect(eventNamed(violationSpan!, 'exception')).toBeDefined();

        // The facts on the span event are value-free and groupable (DEC-035).
        const facts = eventNamed(violationSpan!, 'adorn.contract.violation')!.attributes!;
        expect(facts['adorn.violation.constraint']).toBe('greaterThan');
        expect(facts['adorn.violation.trust']).toBe('guard');
        expect(facts['adorn.violation.blame']).toBe('caller');

        // No completion — the method threw before proceed() (matches the in-core DEC-037 pin).
        expect(completed).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// "seeing ≠ emitting" (DEC-036) — end to end onto span attributes
// ---------------------------------------------------------------------------

describe('disclosure is honoured on span attributes ("seeing ≠ emitting")', () => {
    it('renders an opted-in value and REDACTS an un-opted one, leaking the raw value nowhere', () => {
        install();

        class Accounts {
            @Observe()
            transfer(@Telemetry.value() amount: number, memo: string): number {
                return amount;
            }
        }

        new Accounts().transfer(42, 'lunch');

        const span = finishedSpans()[0];
        expect(span.attributes['adorn.param.amount']).toBe(42); // opted-in → the value
        expect(span.attributes['adorn.param.memo']).toBe('[REDACTED]'); // un-opted → redacted

        // The raw un-opted value never reaches the exported span in any form.
        expect(JSON.stringify(span.attributes)).not.toContain('lunch');
    });

    it('renders a @Telemetry.redact(type) surrogate rather than the value', () => {
        install();

        class Accounts {
            @Observe()
            open(@Telemetry.redact('type') account: object): void {}
        }

        new Accounts().open({iban: 'SECRET'});

        const span = finishedSpans()[0];
        expect(span.attributes['adorn.param.account']).toBe('Object'); // the type name, not the value
        expect(JSON.stringify(span.attributes)).not.toContain('SECRET');
    });
});

// ---------------------------------------------------------------------------
// The Q-27 win — the disclosed return-value rendering now lands on the method's own span,
// correlated via callId (DEC-047). Impossible under DEC-046's end-in-scope lifecycle.
// ---------------------------------------------------------------------------

describe('the disclosed return value lands on the method span, correlated via callId (Q-27)', () => {
    it('renders a @Telemetry.result() return as adorn.return on the span', () => {
        install();

        class Accounts {
            @Observe()
            @Telemetry.result()
            balance(): number {
                return 99;
            }
        }

        new Accounts().balance();

        const span = finishedSpans()[0];
        // The return rendering — produced only on the `completed` record event — is correlated back onto
        // the span this call's `scope` opened, and lands as `adorn.return`.
        expect(span.attributes['adorn.return']).toBe(99);
        expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('keeps an un-opted return OFF the span, so disclosure still holds (DEC-036)', () => {
        install();

        class Accounts {
            @Observe()
            secret(): string {
                return 'topsecret'; // no @Telemetry.result() opt-in
            }
        }

        new Accounts().secret();

        const span = finishedSpans()[0];
        // An un-opted return carries no EmittedValue at all, so `adorn.return` is absent (stronger than a
        // [REDACTED] placeholder) and the raw value appears nowhere on the exported span.
        expect(span.attributes['adorn.return']).toBeUndefined();
        expect(JSON.stringify(span.attributes)).not.toContain('topsecret');
    });

    it('still ends the span exactly once, with the settled duration (DEC-006)', () => {
        install();

        class Accounts {
            @Observe()
            @Telemetry.result()
            balance(): number {
                return 7;
            }
        }

        new Accounts().balance();

        const spans = finishedSpans();
        expect(spans).toHaveLength(1); // ended exactly once, by its correlated completion
        expect(completed).toHaveLength(1);
        expect(Math.abs(hrToMs(spans[0].duration) - completed[0].durationMs)).toBeLessThan(5);
    });
});

describe('named facts attached at close each get their own return attribute (voice-agent L13)', () => {
    it('keeps the canonical return as adorn.return and keys other named facts as adorn.return.<name>', () => {
        const values: EmittedValue[] = [
            {index: RETURN_INDEX, name: 'return', disclosed: true, rendering: 99}, // the decorator's canonical return
            {index: RETURN_INDEX, name: 'tokens', disclosed: true, rendering: 1500},
            {index: RETURN_INDEX, name: 'disposition', disclosed: true, rendering: 'booked'},
        ];
        const attrs = attributesFromValues(values, 'adorn');
        // Backward compatible: `name:'return'` (the decorator path) stays `adorn.return`, no last-write-wins.
        expect(attrs['adorn.return']).toBe(99);
        expect(attrs['adorn.return.tokens']).toBe(1500);
        expect(attrs['adorn.return.disposition']).toBe('booked');
    });

    it('an unnamed return value still keys as adorn.return', () => {
        const attrs = attributesFromValues([{index: RETURN_INDEX, disclosed: true, rendering: 7}], 'adorn');
        expect(attrs['adorn.return']).toBe(7);
    });
});

describe('record-only positioning and nesting (voice-agent L14 / L15)', () => {
    const obs = (name: string): Observation => ({
        owner: name.split('.')[0],
        member: name.split('.')[1] || name,
        name,
        isStatic: false,
        detail: 'always',
        kind: 'internal',
        parameters: [],
    });
    const parentIdOf = (span: ReadableSpan): string | undefined =>
        (span as {parentSpanId?: string; parentSpanContext?: {spanId?: string}}).parentSpanId ??
        (span as {parentSpanContext?: {spanId?: string}}).parentSpanContext?.spanId;

    it('L14 — a completed event with startedAt but no scope becomes a positioned span', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const start = Date.now() - 5000; // clearly in the past — proves it is placed, not stamped "now"
        sink.record!({
            kind: 'completed',
            observation: obs('Turn.betweenCallAndReply'),
            callId: 1,
            startedAt: start,
            durationMs: 626,
            outcome: 'returned',
            settled: true,
        });
        const spans = finishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('Turn.betweenCallAndReply');
        expect(hrToMs(spans[0].duration)).toBeCloseTo(626, 0); // measured length
        expect(Math.abs(hrToMs(spans[0].startTime) - start)).toBeLessThan(5); // positioned, not "now"
    });

    it('a completed event with NEITHER a scope span NOR startedAt still opens no span (unchanged)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        sink.record!({
            kind: 'completed',
            observation: obs('Weave.completion'),
            callId: 2,
            durationMs: 10,
            outcome: 'returned',
            settled: true,
        });
        expect(finishedSpans()).toHaveLength(0);
    });

    it('L15 — a child completed nests under its parentCallId span (same trace, parent edge)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const start = Date.now() - 5000;
        sink.record!({
            kind: 'completed',
            observation: obs('Turn.answer'),
            callId: 10,
            startedAt: start,
            durationMs: 675,
            outcome: 'returned',
            settled: true,
        });
        sink.record!({
            kind: 'completed',
            observation: obs('Model.composesCall'),
            callId: 11,
            parentCallId: 10,
            startedAt: start + 40,
            durationMs: 626,
            outcome: 'returned',
            settled: true,
        });
        const spans = finishedSpans();
        expect(spans).toHaveLength(2);
        const parent = spans.find(s => s.name === 'Turn.answer')!;
        const child = spans.find(s => s.name === 'Model.composesCall')!;
        expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
        expect(parentIdOf(child)).toBe(parent.spanContext().spanId);
    });

    it('an unresolved parentCallId degrades to a root span, not a crash', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const start = Date.now() - 5000;
        expect(() =>
            sink.record!({
                kind: 'completed',
                observation: obs('Orphan.child'),
                callId: 20,
                parentCallId: 999, // never seen
                startedAt: start,
                durationMs: 5,
                outcome: 'returned',
                settled: true,
            }),
        ).not.toThrow();
        expect(finishedSpans()).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// completed.attributes → span attributes (voice-agent L17, DEC-078). A non-decorator emitter attaches
// low-cardinality facts (e.g. semconv gen_ai.usage.*) to the completion; the sink lands them on the span,
// distinct from the disclosure-gated adorn.return.<name> value channel, and honoured as `message` already is.
// ---------------------------------------------------------------------------

describe('completed.attributes land on the span (voice-agent L17)', () => {
    const obs = (name: string): Observation => ({
        owner: name.split('.')[0],
        member: name.split('.')[1] || name,
        name,
        isStatic: false,
        detail: 'always',
        kind: 'client',
        parameters: [],
    });

    it('applies a completion’s attributes to a record-only positioned span (the functional-emitter case)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const start = Date.now() - 5000;
        sink.record!({
            kind: 'completed',
            observation: obs('Reasoning.answer'),
            callId: 300,
            startedAt: start,
            durationMs: 1300,
            outcome: 'returned',
            settled: true,
            attributes: {'gen_ai.usage.output_tokens': 4096, 'gen_ai.response.model': 'o4-mini'},
        });
        const span = finishedSpans().find(s => s.name === 'Reasoning.answer')!;
        expect(span.attributes['gen_ai.usage.output_tokens']).toBe(4096);
        expect(span.attributes['gen_ai.response.model']).toBe('o4-mini');
    });

    it('applies a completion’s attributes to the method’s own scope span (pending-span path)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const call: ObservationCall = {
            observation: obs('Reasoning.answer'),
            thisArg: undefined,
            values: [],
            callId: 301,
        };
        sink.scope!(call, () => 'ok');
        sink.record!({
            kind: 'completed',
            observation: obs('Reasoning.answer'),
            callId: 301,
            durationMs: 1300,
            outcome: 'returned',
            settled: true,
            attributes: {'gen_ai.usage.output_tokens': 512},
        });
        const span = finishedSpans().find(s => s.name === 'Reasoning.answer')!;
        expect(span.attributes['gen_ai.usage.output_tokens']).toBe(512);
    });

    it('coexists with the disclosed adorn.return.<name> value channel (both land, neither disturbs the other)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const start = Date.now() - 5000;
        sink.record!({
            kind: 'completed',
            observation: obs('Reasoning.answer'),
            callId: 302,
            startedAt: start,
            durationMs: 900,
            outcome: 'returned',
            settled: true,
            values: [{index: RETURN_INDEX, name: 'reasoningTokens', disclosed: true, rendering: 128}],
            attributes: {'gen_ai.response.model': 'o4-mini'},
        });
        const span = finishedSpans().find(s => s.name === 'Reasoning.answer')!;
        expect(span.attributes['adorn.return.reasoningTokens']).toBe(128); // disclosure channel intact
        expect(span.attributes['gen_ai.response.model']).toBe('o4-mini'); // attributes channel too
    });
});

// ---------------------------------------------------------------------------
// L18 (DEC-081) — a THROWN completion on the scope path must land its error on the span, even when a
// functional emitter records its completion from INSIDE its own settle (so finishPendingSpan runs before
// scope's markSpanOutcome, ending the span green before the outcome could be marked).
// ---------------------------------------------------------------------------

describe('a thrown completion on the scope path lands its error on the span (voice-agent L18)', () => {
    const obs = (name: string): Observation => ({
        owner: name.split('.')[0],
        member: name.split('.')[1] || name,
        name,
        isStatic: false,
        detail: 'always',
        kind: 'client',
        parameters: [],
    });

    it('a functional emitter that records its completion from inside proceed gets ERROR + the raw exception', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const callId = 700;
        const call: ObservationCall = {
            observation: obs('Reasoning.answer'),
            thisArg: undefined,
            values: [],
            callId,
        };
        class RateLimitError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'RateLimitError';
            }
        }
        // Mirror `observed()`: proceed emits the completion from INSIDE its own settle (so finishPendingSpan
        // runs FIRST and only enriches + waits), then the throw propagates out to scope's markSpanOutcome —
        // which, thanks to the join, runs on a still-open span and records the RAW error before ending it.
        expect(() =>
            sink.scope!(call, () => {
                sink.record!({
                    kind: 'completed',
                    observation: obs('Reasoning.answer'),
                    callId,
                    durationMs: 5,
                    outcome: 'threw',
                    settled: true,
                    error: {type: 'RateLimitError', message: 'boom'},
                });
                throw new RateLimitError('boom');
            }),
        ).toThrow(/boom/);

        const span = finishedSpans().find(s => s.name === 'Reasoning.answer')!;
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        const exceptions = span.events.filter(e => e.name === 'exception');
        expect(exceptions).toHaveLength(1); // single source: markSpanOutcome, on the still-open span
        expect(exceptions[0].attributes?.['exception.type']).toBe('RateLimitError');
    });

    it('a returned completion on the same path gets an explicit OK (never falsely errored)', () => {
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        const callId = 701;
        const call: ObservationCall = {
            observation: obs('Reasoning.answer'),
            thisArg: undefined,
            values: [],
            callId,
        };
        sink.scope!(call, () => {
            sink.record!({
                kind: 'completed',
                observation: obs('Reasoning.answer'),
                callId,
                durationMs: 5,
                outcome: 'returned',
                settled: true,
            });
            return 'ok';
        });
        const span = finishedSpans().find(s => s.name === 'Reasoning.answer')!;
        // markSpanOutcome sets OK on the still-open span (the join) — not UNSET, as it was when the span was
        // ended before markSpanOutcome could run.
        expect(span.status.code).toBe(SpanStatusCode.OK);
        expect(span.events.filter(e => e.name === 'exception')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Metrics (opt-in) — duration histogram + violations counter
// ---------------------------------------------------------------------------

describe('metrics are recorded when a Meter is supplied (opt-in)', () => {
    function stubMeter() {
        const histogram: Array<{value: number; attrs: Record<string, unknown>}> = [];
        const counter: Array<{value: number; attrs: Record<string, unknown>}> = [];
        const meter = {
            createHistogram: () => ({record: (value: number, attrs: any) => histogram.push({value, attrs})}),
            createCounter: () => ({add: (value: number, attrs: any) => counter.push({value, attrs})}),
        } as unknown as Meter;
        return {meter, histogram, counter};
    }

    it('records the settled duration on the histogram for a completion', () => {
        const {meter, histogram} = stubMeter();
        install({meter});

        class Svc {
            @Observe()
            work(n: number): number {
                return n;
            }
        }
        new Svc().work(5);

        expect(histogram).toHaveLength(1);
        expect(histogram[0].value).toBe(completed[0].durationMs);
        expect(histogram[0].attrs['adorn.method']).toBe('Svc.work');
        expect(histogram[0].attrs['adorn.outcome']).toBe('returned');
    });

    it('increments the violations counter dimensioned by the value-free facts', () => {
        const {meter, counter} = stubMeter();
        install({meter});

        @Contract()
        class Ledger {
            debit(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }
        expect(() => new Ledger().debit(-1)).toThrow();

        expect(counter).toHaveLength(1);
        expect(counter[0].value).toBe(1);
        expect(counter[0].attrs['adorn.violation.constraint']).toBe('greaterThan');
    });
});

// ---------------------------------------------------------------------------
// message events + the pure mapping helpers
// ---------------------------------------------------------------------------

describe('message events and mapping helpers', () => {
    it('records a message event as a span event on a standalone span', () => {
        install();

        const observation = {
            owner: 'Svc',
            member: 'ping',
            name: 'Svc.ping',
            isStatic: false,
            detail: 'always' as const,
            kind: 'internal' as const,
            parameters: [],
        };
        const event: ObservationEvent = {
            kind: 'message',
            observation,
            callId: 1,
            level: 'info',
            message: 'hello',
            attributes: {route: '/x', count: 3},
        };
        const sink = createOtelSink({tracer: provider.getTracer('m')});
        sink.record!(event);

        const span = finishedSpans().find(s => s.name === 'Svc.ping')!;
        const msg = eventNamed(span, 'hello')!;
        expect(msg.attributes?.['adorn.log.level']).toBe('info');
        expect(msg.attributes?.['route']).toBe('/x');
        expect(msg.attributes?.['count']).toBe(3);
    });

    it('mapSpanKind maps every adorn kind onto the OTel enum', () => {
        expect(mapSpanKind('internal')).toBe(OtelSpanKind.INTERNAL);
        expect(mapSpanKind('server')).toBe(OtelSpanKind.SERVER);
        expect(mapSpanKind('client')).toBe(OtelSpanKind.CLIENT);
        expect(mapSpanKind('producer')).toBe(OtelSpanKind.PRODUCER);
        expect(mapSpanKind('consumer')).toBe(OtelSpanKind.CONSUMER);
    });
});
