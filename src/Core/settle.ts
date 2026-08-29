/**
 * O1a — the shared settling classifier (Q-24/R1), extracted from `@Time`.
 *
 * ## One classifier, so durations can never disagree (DEC-006)
 *
 * `@Time`, a future `@Observe`, and the `@adorn/otel` span adapter all need to know *when work
 * settles* — not when a method *returns*, which for an `async` method is ~0ms and worse than no
 * measurement because it looks like an answer. That classification (sync vs thenable vs Observable, and
 * the honest `settled: false` refusal when rxjs is absent) is the hard, already-correct part; it lived
 * inside `Time.ts`. Extracting it here — verbatim in behaviour — is what guarantees the three consumers
 * compute *one* duration from *one* classifier and can never drift. `@Time` is its first consumer and
 * proves the extraction; the O2 adapter ends its span using this exported `settle`, never a
 * reimplementation, which is the concrete mechanism preventing the "flat, early-ended spans" failure.
 *
 * ## The corrected arity (Q-24/R1) — value XOR error, in ONE object
 *
 * The seam extracted here is re-pinned to a single object-shaped, discriminated callback carrying the
 * settled value **or** the thrown error, so an adapter can both read the value (return-derived span
 * attributes) and `recordException` the error — the gap the adversarial review (F2) found. Because the
 * union discriminates on the *string* literal `outcome`, `Settlement<T>` is a real discriminated union that
 * narrows cleanly — the house style since `settle` (it did so even under the former `strict:false`, unlike a
 * boolean discriminant, the choice DEC-079 later generalised by flipping strict on). One arity, one object,
 * forever — a later field is an additive change, never an arity break (Q-6).
 *
 * ## Takes a thunk, not a pre-evaluated result
 *
 * `settle(operation, onSettle)` runs `operation()` itself, so a **synchronous throw** is classified and
 * handed to `onSettle` before it re-throws — exactly what lets an adapter `recordException` on *every*
 * outcome, contract or not. This is the try/catch `@Time` previously owned around `proceed()`, moved
 * inside `settle` unchanged.
 *
 * ## Zero third-party imports
 *
 * Nothing outside `Core/`. The Observable branch reaches rxjs only through a guarded lazy `require`
 * (SMELL-16, unchanged by the move): with rxjs absent it degrades to `settled: false`, with rxjs
 * present in the consumer's tree it measures properly. No new specifier is created — this is the same
 * `require('rxjs')` string literal that already lived in `Time.ts`.
 */

/** How the result was produced, and therefore what "settled" meant for it. Twin of `TimedResultKind`. */
export type SettleKind = 'sync' | 'promise' | 'observable';

/**
 * The one settlement fact, discriminated on `outcome`. `value` XOR `error`.
 *
 * - `outcome: 'returned'` narrows to a `value: T` (the settled value; `undefined` for an Observable
 *   completion, which has no single value).
 * - `outcome: 'threw'` narrows to an `error: unknown` (a sync throw, a rejection, or a stream error).
 *
 * `settled` is `false` only for an Observable that could not be wrapped (rxjs absent), where
 * `durationMs` is `0` and is the time to *return*, not to finish — a sink must not compare it against
 * settled durations.
 */
export type Settlement<T> =
    | {
          readonly outcome: 'returned';
          readonly value: T;
          readonly durationMs: number;
          readonly kind: SettleKind;
          readonly settled: boolean;
      }
    | {
          readonly outcome: 'threw';
          readonly error: unknown;
          readonly durationMs: number;
          readonly kind: SettleKind;
          readonly settled: boolean;
      };

/** The callback `settle` invokes exactly once, when the work settles. */
export type OnSettle<T> = (settlement: Settlement<T>) => void;

/**
 * Run `operation`, classify how its result settles, and invoke `onSettle` exactly once when it does —
 * passing the settled value or the thrown error. Returns the value / assimilated promise / wrapped
 * Observable to the caller, preserving `@Time`'s existing normalisation (SMELL-15) and rxjs-absent
 * honest refusal (SMELL-16).
 *
 * `onSettle` is the caller's business and should not throw; `@Time`'s reporter guards its own sink, and
 * the enforcement weave guards its own emit, exactly as before. `settle` does not wrap `onSettle`, so it
 * does not mask a re-thrown error.
 */
export function settle<T>(operation: () => T, onSettle: OnSettle<T>): T {
    const started = now();

    let result: T;
    try {
        result = operation();
    } catch (error) {
        // A synchronous throw is a settled outcome: the work is finished, unsuccessfully. Hand it over
        // before re-throwing, so an adapter can recordException on it (Q-24/F2 wall 1).
        onSettle({outcome: 'threw', error, durationMs: now() - started, kind: 'sync', settled: true});
        throw error;
    }

    if (isThenable(result)) return settleThenable(result, started, onSettle) as any;
    if (isObservableLike(result)) return settleObservable(result, onSettle) as any;

    onSettle({outcome: 'returned', value: result, durationMs: now() - started, kind: 'sync', settled: true});
    return result;
}

// ---------------------------------------------------------------------------
// Result kinds — duck-typed, never `instanceof` (extracted verbatim from Time.ts)
// ---------------------------------------------------------------------------

function isThenable(value: any): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function'
    );
}

/**
 * Duck-typed, never `instanceof`. adorn does not depend on rxjs, so there is no `Observable` to be an
 * instance of unless the consumer supplies one; and a second copy of rxjs in `node_modules` breaks
 * `instanceof` across realms anyway. `subscribe` is the only member required — the only one called.
 */
function isObservableLike(value: any): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.subscribe === 'function'
    );
}

/**
 * `Promise.resolve(result)` rather than `result.then(...)` directly, so a hand-rolled thenable whose
 * `then` returns `undefined` still hands the caller their value. This is the same normalisation `await`
 * performs (SMELL-15): a method returning a *custom* thenable gets a genuine `Promise` back.
 */
function settleThenable<T>(result: any, started: number, onSettle: OnSettle<T>): any {
    return Promise.resolve(result).then(
        (value: any) => {
            onSettle({
                outcome: 'returned',
                value,
                durationMs: now() - started,
                kind: 'promise',
                settled: true,
            });
            return value;
        },
        (error: any) => {
            onSettle({outcome: 'threw', error, durationMs: now() - started, kind: 'promise', settled: true});
            throw error;
        },
    );
}

/**
 * Wrap a source Observable so each subscription is timed independently, from the caller's subscribe —
 * never subscribing here, so the source stays exactly as cold as it was and its producer is not run an
 * extra time. Unsubscribing tears down the source subscription and reports nothing (an abandoned stream
 * did not finish). With rxjs absent there is nothing to wrap with, so the source passes through by
 * identity and the measurement is honestly flagged `settled: false`.
 */
function settleObservable<T>(source: any, onSettle: OnSettle<T>): any {
    const ObservableCtor = loadObservable();
    if (!ObservableCtor) {
        onSettle({outcome: 'returned', value: source, durationMs: 0, kind: 'observable', settled: false});
        return source;
    }

    return new ObservableCtor((subscriber: any) => {
        const started = now();
        let reported = false;
        const once = (settlement: Settlement<T>) => {
            if (reported) return;
            reported = true;
            onSettle(settlement);
        };

        const subscription = source.subscribe({
            next: (value: any) => subscriber.next(value),
            error: (error: any) => {
                once({
                    outcome: 'threw',
                    error,
                    durationMs: now() - started,
                    kind: 'observable',
                    settled: true,
                });
                subscriber.error(error);
            },
            complete: () => {
                // A stream has no single settled value, so `value` is honestly `undefined`.
                once({
                    outcome: 'returned',
                    value: undefined as any,
                    durationMs: now() - started,
                    kind: 'observable',
                    settled: true,
                });
                subscriber.complete();
            },
        });

        return () => subscription.unsubscribe();
    });
}

/**
 * Load rxjs's `Observable` lazily, and only once an Observable has actually been seen — the seam that
 * lets the Observable branch exist while adorn depends on rxjs not at all. The `require` is reached only
 * from {@link settleObservable}, so a consumer without rxjs never executes it and degrades to
 * `settled: false`. SMELL-16 is unchanged by the extraction: the string literal is statically
 * resolvable by a bundler, exactly as it was in `Time.ts`; no new specifier is created.
 */
let observableCtor: any;
let observableLookupDone = false;

function loadObservable(): any {
    if (observableLookupDone) return observableCtor;
    observableLookupDone = true;
    try {
        observableCtor = require('rxjs').Observable;
    } catch {
        observableCtor = undefined;
    }
    return observableCtor;
}

/**
 * Highest-resolution monotonic clock available. `performance.now()` is monotonic and sub-millisecond,
 * which matters because plenty of settled work takes under 1ms; `Date.now()` is the wall-clock fallback.
 */
function now(): number {
    const perf = typeof performance !== 'undefined' ? performance : undefined;
    if (perf && typeof perf.now === 'function') return perf.now();
    return Date.now();
}
