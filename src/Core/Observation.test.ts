/**
 * O1a — the observation seam: the settable/gettable sink, its no-op default, and the frozen event
 * surface. The meaningful behaviour (a violation/completed event flowing on a real call) is pinned in
 * `test/violation-telemetry.test.ts`; this file pins the slot itself.
 */

import {
    getObservationSink,
    setObservationSink,
    RETURN_INDEX,
    ObservationEvent,
    ObservationSink,
    EmittedValue,
} from './Observation';

afterEach(() => setObservationSink(null));

describe('the sink slot', () => {
    it('defaults to a frozen no-op sink with neither surface', () => {
        setObservationSink(null);
        const sink = getObservationSink();

        expect(sink.record).toBeUndefined();
        expect(sink.scope).toBeUndefined();
        expect(Object.isFrozen(sink)).toBe(true);
    });

    it('returns the SAME no-op reference every time — the one `===` fast path', () => {
        setObservationSink(null);
        expect(getObservationSink()).toBe(getObservationSink());
    });

    it('installs and reads back a sink', () => {
        const sink: ObservationSink = {record: () => undefined};
        setObservationSink(sink);
        expect(getObservationSink()).toBe(sink);
    });

    it('restores the no-op default when set to null', () => {
        setObservationSink({record: () => undefined});
        const installed = getObservationSink();
        setObservationSink(null);
        const restored = getObservationSink();

        expect(restored).not.toBe(installed);
        expect(restored.record).toBeUndefined();
    });

    it('accepts a record-only sink and a scope-only sink independently', () => {
        const events: ObservationEvent[] = [];
        setObservationSink({record: e => events.push(e)});
        getObservationSink().record?.({
            kind: 'completed',
            observation: {
                owner: 'A',
                member: 'm',
                name: 'A.m',
                isStatic: false,
                detail: 'always',
                kind: 'internal',
                parameters: [],
            },
            callId: 1,
            durationMs: 1,
            outcome: 'returned',
            settled: true,
        });
        expect(events).toHaveLength(1);

        // A scope-only sink omits `record`; calling the optional member is simply a no-op.
        setObservationSink({scope: (_call, proceed) => proceed()});
        expect(() => getObservationSink().record?.({} as ObservationEvent)).not.toThrow();
    });
});

describe('constants and payload shapes', () => {
    it('RETURN_INDEX is the -1 return sentinel, distinct from any parameter index', () => {
        expect(RETURN_INDEX).toBe(-1);
    });

    it('an EmittedValue carries the disclosure OUTCOME, not a raw value', () => {
        const disclosed: EmittedValue = {index: 0, name: 'amount', disclosed: true, rendering: 42};
        const redacted: EmittedValue = {index: 1, name: 'memo', disclosed: false, rendering: '[REDACTED]'};

        expect(disclosed.disclosed).toBe(true);
        expect(redacted.rendering).toBe('[REDACTED]');
    });
});
