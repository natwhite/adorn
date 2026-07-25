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
 * ## Settling is the whole difficulty — now shared (O1a, DEC-035)
 *
 * The naive implementation times the *call*, which for an `async` method measures how long it took to
 * *construct* a promise — approximately zero, and worse than no measurement because it looks like an
 * answer. So the result is classified and the clock is stopped when the work actually finishes:
 *
 * | Result             | Clock stops                                       |
 * |--------------------|---------------------------------------------------|
 * | anything else      | when the method returns                           |
 * | a thenable         | when it resolves or rejects                       |
 * | an Observable      | when the stream completes or errors                |
 *
 * That classifier — the hard, already-correct part, including the rxjs-absent `settled: false` honest
 * refusal (SMELL-16) and the cold-Observable non-subscription (plan risk 4) — now lives in
 * {@link settle} (`Core/settle.ts`), extracted verbatim so `@Time`, a future `@Observe`, and the
 * `@adorn/otel` span adapter compute *one* duration from *one* classifier and can never drift (DEC-006).
 * `@Time` is that extraction's first consumer and proves it: the decorator becomes a thin `settle` call
 * whose `Settlement<T>` it maps onto a {@link TimingRecord}, ignoring the settled value/error. Its name,
 * options, console output, Observable coldness/normalisation (SMELL-15), and `setTimingSink` are all
 * unchanged.
 */

import {CreateMethodDecorator, InvocationContext} from '../Core/MethodDecoratorFactory';
import {settle} from '../Core/settle';

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

        // The whole timing story is now `settle` (Core/settle.ts): it owns the try/catch around the
        // call, the sync/thenable/observable classification, and the clock. `@Time` maps the resulting
        // `Settlement` onto a `TimingRecord` and ignores the settled value/error — a timer needs neither.
        return settle(proceed, settlement =>
            report(settlement.durationMs, settlement.kind, settlement.outcome, settlement.settled),
        );
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The sink-facing report shape. `kind` is `TimedResultKind`, structurally the `settle` `SettleKind`. */
type Report = (
    durationMs: number,
    kind: TimedResultKind,
    outcome: 'returned' | 'threw',
    settled: boolean,
) => void;

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
