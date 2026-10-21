/**
 * Observability — the neutral O1 observation seam.
 *
 * Install ONE `ObservationSink` and adorn routes value-free violation facts and completions through
 * it. `@Observe` opens a span; the enforcement weave reports violations; and a functional codebase
 * (no classes) can emit the same events by hand — the observation analog of `Verify.check`.
 *
 *   Run:  npx ts-node examples/07-observability.ts
 */
import {Contract, Observe, GreaterThan, setObservationSink} from '../index';
// Reading the sink, the id sequence, and the ready-made console sink live in `adorn/observe` (DEC-097).
import {getObservationSink, nextCallId, consoleObservationSink} from '../observe';
import type {Observation, ObservationEvent} from '../observe';

// A tiny sink that captures events so we can print them plainly.
const events: ObservationEvent[] = [];
setObservationSink({record: e => events.push(e)});

@Contract()
class Api {
    @Observe({kind: 'server'})
    handle(@GreaterThan(0) id: number): string {
        return `handled ${id}`;
    }
}

const api = new Api();
api.handle(42); // a well-formed call → a `completed` event
try {
    api.handle(-1); // violates @GreaterThan(0) → a value-free `violation` event (and throws)
} catch {
    /* the violation was emitted before the throw */
}

console.log('=== events from decorated calls ===');
for (const e of events) console.log(`${e.kind.padEnd(10)} ${e.observation.name}`);

// Non-decorator emit: a functional codebase emits point events straight to the sink. Draw the
// callId from nextCallId() — the one shared sequence — so it can never collide with adorn's own ids.
const nightly: Observation = {
    owner: 'jobs',
    member: 'nightly',
    name: 'jobs.nightly',
    isStatic: false,
    detail: 'always',
    kind: 'internal',
    parameters: [],
};
getObservationSink().record?.({
    kind: 'completed',
    observation: nightly,
    callId: nextCallId(),
    durationMs: 42,
    outcome: 'returned',
    settled: true,
});
console.log('\n=== after a manual (non-decorator) emit ===');
const last = events[events.length - 1];
console.log(`${last.kind.padEnd(10)} ${last.observation.name}`);

// `consoleObservationSink` is a ready-made JSON-to-console sink (opt-in; never installed automatically).
console.log('\n=== consoleObservationSink writes one JSON line per event ===');
setObservationSink(consoleObservationSink);
api.handle(7);
setObservationSink(null); // detach
