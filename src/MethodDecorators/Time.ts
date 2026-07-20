/**
 * P3.4 — `@Time`, the roadmap's timing decorator.
 *
 * ## What it is, and what it deliberately is not
 *
 * It measures how long a method takes to **settle** and hands one record to a sink. That is all.
 * There is no aggregation, no percentile tracking, no sampling, no span hierarchy, no registry of
 * timers. Those belong to whatever telemetry system a host already runs, which is exactly why the
 * sink is pluggable: `@Time` produces the measurement, something else decides what to do with it.
 * A profiling framework invented here would be a worse version of one the user already has.
 *
 * ## Settling is the whole difficulty
 *
 * The naive implementation times the *call*:
 *
 * ```ts
 * const start = now();
 * const result = original.apply(this, args);
 * report(now() - start);            // <- for an async method, this is ~0ms
 * ```
 *
 * For a method returning a `Promise` that reports the time taken to *construct* the promise, which
 * is approximately zero and is worse than no measurement at all — it is a number that looks like an
 * answer. So the result is classified and the clock is stopped when the work actually finishes:
 *
 * | Result             | Clock stops                                       |
 * |--------------------|---------------------------------------------------|
 * | anything else      | when the method returns                           |
 * | a thenable         | when it resolves or rejects                       |
 * | an Observable      | when the stream completes or errors                |
 *
 * ## The Observable row is dormant interop, and adorn no longer depends on rxjs
 *
 * `rxjs` was removed from the package entirely — not demoted, removed; `@Memoize` went with it, and
 * a future `@adorn/rx` module is where that functionality is expected to return (see the IDEA entry
 * in `docs/ISSUES.md`). The Observable branch below **stays**, because deleting it would be the
 * worse outcome for the one case it exists to prevent: without it an Observable-returning method
 * falls into the `sync` row and is billed for the time taken to *construct* the stream, which is
 * approximately zero and is precisely the "number that looks like an answer" this whole file is
 * organised against. The branch is duck-typed and reaches rxjs only through a guarded lazy
 * `require`, so with rxjs absent it degrades to `settled: false` — an honest refusal to measure —
 * and with rxjs present in the consumer's tree (still the common case) it measures properly.
 *
 * ## Cold Observables are not subscribed to
 *
 * The obvious way to time an Observable — subscribe and watch — is wrong twice over: it makes a cold
 * Observable's producer run an extra time, duplicating whatever side effects it has, and it forces
 * work the caller may never have asked for. Instead the source is wrapped in a new cold Observable
 * that starts the clock **when the caller subscribes**, which is also the more honest measurement:
 * a cold Observable does no work until subscription, so timing from the method's return would bill
 * it for however long the caller sat on it.
 *
 * A stream that never terminates is never reported. That is correct — it has not finished — but it
 * means `@Time` is not a way to measure an infinite stream, and nothing here pretends otherwise.
 *
 * The wrapper is a plain `Observable`, so a method returning a `Subject` hands its caller something
 * that can be subscribed to but not `next`-ed. That is the standard consequence of wrapping and is
 * why returning a Subject from a public method is already questionable, but it is a real behaviour
 * change and is called out rather than left to be discovered.
 *
 * **The alternative was evaluated and rejected** (SMELL-15). `source.lift(operator)` *does* preserve
 * the source's type — verified against rxjs 6.5.3, where a lifted `Subject` comes back as an
 * `AnonymousSubject` and keeps `next`. It is not used, for two reasons that both matter more than
 * the normalisation does. `lift` is rxjs-internal API, documented as an implementation detail and
 * deprecated outright in rxjs 7, so building on it trades a documented behaviour change for an
 * undocumented breakage on the next major. And it does not exist on the duck-typed interop
 * observables this file deliberately accepts (see {@link isObservableLike}), so it would need the
 * plain-`Observable` path as a fallback anyway — meaning the normalisation would still happen, just
 * unpredictably, depending on which library produced the source. A behaviour change that is uniform
 * and documented beats one that is conditional and surprising.
 *
 * ## Built on the existing installation path (P1.2)
 *
 * This is a plain {@link CreateMethodDecorator} around-behaviour, the first consumer of that factory
 * outside contract enforcement. It needs no descriptor patching of its own and no knowledge of the
 * registry — which is the point of the behaviour seam existing at all.
 */

import {CreateMethodDecorator, InvocationContext} from '../Core/MethodDecoratorFactory';

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** How the timed result was produced, and therefore what "settled" meant for it. */
export type TimedResultKind = 'sync' | 'promise' | 'observable';

/** One completed measurement. */
export interface TimingRecord {
    /** Class name, e.g. `Task`. */
    readonly owner: string;
    /** Method name, e.g. `fetch`. */
    readonly member: string;
    /** `options.label`, or `Owner.member`. What a sink normally keys on. */
    readonly label: string;
    /** Milliseconds, fractional where the platform clock allows. */
    readonly durationMs: number;
    readonly kind: TimedResultKind;
    /** `'returned'` on success, `'threw'` on a sync throw, rejection, or Observable error. */
    readonly outcome: 'returned' | 'threw';
    /**
     * `false` when the duration is the time to *return*, not to finish. Only happens for an
     * Observable result that could not be wrapped (see {@link Time}). A sink should not compare an
     * unsettled duration against settled ones.
     */
    readonly settled: boolean;
}

export type TimingSink = (record: TimingRecord) => void;

export interface TimeOptions {
    /** Overrides the default `Owner.member` label. */
    readonly label?: string;
    /** Overrides the process-wide sink for this method only. */
    readonly sink?: TimingSink;
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

const DEFAULT_SINK: TimingSink = record => {
    if (typeof console === 'undefined' || typeof console.log !== 'function') return;
    const suffix = record.settled ? '' : ' (unsettled — time to return, not to finish)';
    const outcome = record.outcome === 'threw' ? ' [threw]' : '';
    console.log(`[adorn:Time] ${record.label} ${record.durationMs.toFixed(3)}ms${outcome}${suffix}`);
};

let sink: TimingSink = DEFAULT_SINK;

/**
 * Route every `@Time` record somewhere — a metrics client, a log aggregator, a test spy.
 *
 * Pass `null` to restore the default `console.log`. The default is a deliberate placeholder: it
 * exists so the decorator does something visible out of the box, not because logging is the intended
 * destination.
 */
export function setTimingSink(next: TimingSink | null): void {
    sink = next || DEFAULT_SINK;
}

export function getTimingSink(): TimingSink {
    return sink;
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

/**
 * Measure a method until its result settles.
 *
 * ```ts
 * class Api {
 *     @Time()
 *     fetchUser(id: string): Promise<User> { ... }   // measured until the promise resolves
 * }
 * ```
 *
 * Composes with `@Contract()` / `@Validate()`; whichever decorator is applied closest to the method
 * runs innermost, so ordering decides whether contract-check time is inside the measurement.
 */
export function Time(options?: TimeOptions): MethodDecorator {
    const label = options && options.label;
    const local = options && options.sink;

    return CreateMethodDecorator(function (context: InvocationContext, proceed: () => any) {
        const report = buildReporter(context, label, local);
        const started = now();

        let result: any;
        try {
            result = proceed();
        } catch (error) {
            // A synchronous throw is a settled outcome: the method is finished, unsuccessfully.
            report(now() - started, 'sync', 'threw', true);
            throw error;
        }

        if (isThenable(result)) return timeThenable(result, started, report);
        if (isObservableLike(result)) return timeObservable(result, report);

        report(now() - started, 'sync', 'returned', true);
        return result;
    });
}

// ---------------------------------------------------------------------------
// Result kinds
// ---------------------------------------------------------------------------

function isThenable(value: any): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function'
    );
}

/**
 * Duck-typed, never `instanceof`. This is now the *only* way it could work — adorn does not depend
 * on rxjs at all, so there is no `Observable` to be an instance of unless the consumer supplies one.
 * It was already the right choice before that: a second copy of rxjs in `node_modules` breaks
 * `instanceof` across realms, and an interop observable from another library is just as timeable.
 * `subscribe` is the only member required, because it is the only one this file calls.
 */
function isObservableLike(value: any): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.subscribe === 'function'
    );
}

type Report = (
    durationMs: number,
    kind: TimedResultKind,
    outcome: 'returned' | 'threw',
    settled: boolean,
) => void;

/**
 * `Promise.resolve(result)` rather than `result.then(...)` directly.
 *
 * A hand-rolled thenable's `then` is under no obligation to return anything — `{then(resolve) {...}}`
 * is a perfectly legal thenable whose `then` returns `undefined` — so calling it directly and
 * returning the result would hand the caller `undefined` in place of their value. `Promise.resolve`
 * assimilates any thenable into a real Promise and is a no-op for one that already is a Promise.
 *
 * **Consequence, stated rather than hidden:** a method returning a *custom* thenable gets a genuine
 * `Promise` back from the wrapper. That is the same normalisation `await` performs, but it is an
 * identity change and a caller relying on extra properties of their own thenable will not see them.
 */
function timeThenable(result: any, started: number, report: Report): any {
    return Promise.resolve(result).then(
        (value: any) => {
            report(now() - started, 'promise', 'returned', true);
            return value;
        },
        (error: any) => {
            report(now() - started, 'promise', 'threw', true);
            throw error;
        },
    );
}

/**
 * Wrap a source Observable so each subscription is timed independently.
 *
 * Nothing is subscribed here — the wrapper's subscribe function does not run until the caller
 * subscribes, so the source stays exactly as cold as it was. Unsubscribing tears down the source
 * subscription and reports nothing, because an abandoned stream did not finish.
 */
function timeObservable(source: any, report: Report): any {
    const ObservableCtor = loadObservable();
    if (!ObservableCtor) {
        // No rxjs in the consumer's tree — the expected case now that adorn does not depend on it.
        // The source is handed back exactly as the method produced it, unwrapped and unsubscribed.
        // Reporting the time-to-return would be a number that looks like a duration and is not one,
        // so `settled: false` flags it rather than quietly emitting it; a sink must not compare an
        // unsettled duration against settled ones.
        report(0, 'observable', 'returned', false);
        return source;
    }

    return new ObservableCtor((subscriber: any) => {
        const started = now();
        let reported = false;
        const once = (outcome: 'returned' | 'threw') => {
            if (reported) return;
            reported = true;
            report(now() - started, 'observable', outcome, true);
        };

        const subscription = source.subscribe({
            next: (value: any) => subscriber.next(value),
            error: (error: any) => {
                once('threw');
                subscriber.error(error);
            },
            complete: () => {
                once('returned');
                subscriber.complete();
            },
        });

        return () => subscription.unsubscribe();
    });
}

/**
 * Load rxjs's `Observable` lazily, and only once an Observable has actually been seen.
 *
 * This is the seam that lets `@Time` keep an Observable branch while adorn depends on rxjs not at
 * all. A static import would have made rxjs a hard requirement of every consumer of `@Time`,
 * including the ones timing plain synchronous methods. The `require` is reached only from
 * {@link timeObservable}, i.e. only after a method has actually returned something subscribable, so
 * a consumer without rxjs never executes it.
 *
 * **What is loaded, and why an `Observable` is needed at all.** Only to *construct the wrapper* —
 * `timeObservable` returns a new cold Observable that starts the clock on subscribe. The source
 * itself is consumed purely through its duck-typed `subscribe`. Building the wrapper from
 * `source.constructor` instead was considered and rejected: for a `Subject` that is `Subject`, and
 * `new Subject(fn)` ignores the subscribe function entirely, so the wrapper would silently never
 * time anything.
 *
 * **SMELL-16 is still real, and removing the dependency changed its character rather than fixing
 * it.** The argument is a string literal, so a bundler resolves it statically no matter that the
 * call sits inside a guarded function. Previously that meant a bundler would *pull rxjs in*
 * unnecessarily — wasteful, but harmless, and with no victim while rxjs was a hard dependency.
 * Now that rxjs is not in the tree at all, the same static resolution instead finds **nothing**, so
 * a bundled consumer can expect an unresolved-module diagnostic for a dependency they never asked
 * for. That is a live cost, not a hypothetical one, and it is the direct consequence of this
 * removal. It is unverified against a real bundler — reasoned from how static resolution works, and
 * recorded as such rather than asserted (SMELL-16).
 *
 * The previously-recorded fix is now unblocked but is deliberately **not** taken here: injecting the
 * constructor via a `setObservableConstructor()` export was rejected on the grounds that it "invents
 * public API for a problem that has no victim while rxjs is still a hard dependency". That
 * rejection has expired — the victim now exists — but adding a public export is a decision about
 * adorn's API surface, and it belongs with `@adorn/rx` rather than being slipped in alongside a
 * removal. Node/CommonJS consumers, which is who this path is for, are unaffected either way.
 * Hiding the specifier from static analysis (`eval('require')('rxjs')`) remains rejected outright:
 * it breaks under strict CSP and under ESM, and earns a bundler warning rather than avoiding one.
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildReporter(
    context: InvocationContext,
    label: string | undefined,
    local: TimingSink | undefined,
): Report {
    // Resolved once per call rather than once per install: `context.target` is fixed, but reading
    // these is cheap and doing it here keeps the reporter self-contained.
    const owner = ownerNameOf(context.target);
    const member =
        typeof context.propertyKey === 'symbol'
            ? context.propertyKey.toString()
            : String(context.propertyKey);

    return function (durationMs, kind, outcome, settled) {
        const record: TimingRecord = {
            owner,
            member,
            label: label || `${owner}.${member}`,
            durationMs,
            kind,
            outcome,
            settled,
        };
        try {
            (local || sink)(record);
        } catch {
            // Measurement must never become the failure. A broken sink is not the method's problem.
        }
    };
}

function ownerNameOf(target: object): string {
    if (typeof target === 'function') return (target as Function).name || '<anonymous>';
    const constructor = target && (target as {constructor?: Function}).constructor;
    return (constructor && constructor.name) || '<anonymous>';
}

/**
 * Highest-resolution monotonic clock available.
 *
 * `Date.now()` has millisecond granularity and is wall-clock, so an NTP step mid-call can produce a
 * negative duration. `performance.now()` is monotonic and sub-millisecond, which matters because
 * plenty of timed methods take under 1ms and would otherwise all report `0`.
 */
function now(): number {
    const perf = typeof performance !== 'undefined' ? performance : undefined;
    if (perf && typeof perf.now === 'function') return perf.now();
    return Date.now();
}
