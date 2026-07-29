/**
 * O1c — the one `MethodBehavior` `@Observe` becomes sugar over (DEC-035, DEC-036, plan §4 / Q-24 R5).
 *
 * ## What it does
 *
 * When — and only when — an {@link ObservationSink} is installed, it opens the sink's around-shaped
 * `scope` for the call and emits a `{kind:'completed'}` event when the work *settles* (via the shared
 * {@link settle} classifier, so `@Observe`, `@Time`, and an `@adorn/otel` span can never disagree on one
 * duration — DEC-006). The completed event carries the per-call **pre-disclosed** `EmittedValue[]` and, on
 * a throw, structured {@link ErrorFacts}.
 *
 * ## Two requirements, not optimisations (plan §4)
 *
 * - **The uninstalled path is one reference compare.** No `Observation` is built, no value rendered, no
 *   string formatted, until a sink is installed. A `@Contract()`-only method installs no observation
 *   behaviour at all; a `@Observe()` method with no sink pays exactly one `=== NOOP_SINK`.
 * - **The `Observation` is built once at install time**, cached in the per-decorator closure: owner,
 *   member, name, isStatic, span kind, and each parameter's *resolved disclosure*. The per-call path never
 *   re-resolves policy — it reads the pre-resolved decision and renders.
 *
 * ## "Seeing ≠ emitting" (DEC-036)
 *
 * The `record` path carries ONLY pre-disclosed data — `renderValues` composes the shared disclosure
 * resolver + a total scalar renderer, so a value is `[REDACTED]` unless a `@Telemetry` opt-in permitted it
 * and `@Sensitive` did not veto it. The `scope` path is the around-wrapper: it is definitionally inside the
 * call and sees the raw outcome through its own `proceed()`, exactly as `@Time` does — adorn hands it the
 * pre-disclosed `values` as the ergonomic safe default and never a raw value on the record path.
 *
 * ## Layering (DEC-012)
 *
 * Adapter-side Core: it knows {@link InvocationContext} (like `enforcementBehavior` and `Time.ts`), but no
 * decorator type. The disclosure *decision* is the decorator-agnostic `telemetryDisclosure` resolver; this
 * module only *renders* it.
 */

import {InvocationContext, MethodBehavior} from './MethodDecoratorFactory';
import {settle, Settlement} from '../../Core/settle';
import {
    EmittedValue,
    ErrorFacts,
    getObservationSink,
    nextCallId,
    NOOP_SINK,
    Observation,
    ObservationCall,
    ObservationEvent,
    ObservationSink,
    ObservedParameter,
    ParameterDisclosure,
    RETURN_INDEX,
    SpanKind,
    ObservationDetail,
} from '../../Core/Observation';
import {MethodKey} from '../../Core/ContractRegistry';
import {DecoratorFactory} from '../../Core/common';
import {REDACTED} from '../../Core/redaction';
import {getObservationVerbosity} from '../../Core/Configuration';
import {reportDiagnostic} from './ContractDiagnostics';
import {
    resolveParameterDisclosure,
    resolveReturnDisclosure,
    ResolvedDisclosure,
} from '../../Core/telemetryDisclosure';

/** The install-time options `@Observe` resolves and hands to {@link observeBehavior}. */
export interface ObserveConfig {
    readonly kind: SpanKind;
    readonly detail: ObservationDetail;
}

/** A parameter's resolved disclosure, kept internal — `vetoed` is not on the public {@link ObservedParameter}. */
interface ResolvedParameter {
    readonly index: number;
    readonly name?: string;
    readonly type?: string;
    readonly disclosure: ParameterDisclosure;
    readonly vetoed: boolean;
}

/** Everything built once at install time for one decorated method. */
interface BuiltObservation {
    readonly observation: Observation;
    readonly parameters: ReadonlyArray<ResolvedParameter>;
    readonly returnDisclosure: ResolvedDisclosure;
}

/**
 * Build the {@link MethodBehavior} `@Observe` installs. `observation`/disclosures are resolved lazily on the
 * first *observed* call and cached, so an uninstalled decorator pays one reference compare and nothing else.
 */
export function observeBehavior(config: ObserveConfig): MethodBehavior {
    let built: BuiltObservation | undefined;

    return function (context: InvocationContext, proceed: () => any): any {
        const sink = getObservationSink();
        if (sink === NOOP_SINK) return proceed(); // the fast path — one `===`, no allocation

        if (!built) built = buildObservation(context, config);

        // The detail gate: a `detail`-level site is silent under `'normal'` verbosity even with a sink
        // installed (DEC-035). Default `'always'` clears it, so a plain `@Observe()` always emits.
        if (built.observation.detail === 'detail' && getObservationVerbosity() === 'normal') {
            return proceed();
        }

        // Rendered before the call — what the method was actually handed, not what it may have mutated.
        // Total by construction, but guarded anyway: rendering telemetry must never break the call.
        let values: EmittedValue[];
        try {
            values = renderValues(built.parameters, context.args);
        } catch {
            values = [];
        }

        // ONE correlation id per observed invocation (Q-27), stamped on BOTH this call's `scope`
        // `ObservationCall` and its `completed` event, so a sink can correlate the completion back to the
        // span this `@Observe` wrapper opened — even under concurrent same-method async, where the frozen
        // `Observation` reference is shared and non-unique.
        const callId = nextCallId();

        const call: ObservationCall = {
            observation: built.observation,
            thisArg: context.thisArg,
            values,
            callId,
        };
        const run = () => proceed();
        const scoped = sink.scope ? () => sink.scope!(call, run) : run;

        return settle(scoped, settlement => recordCompleted(sink, built!, values, settlement, callId));
    };
}

// ---------------------------------------------------------------------------
// Install-time construction
// ---------------------------------------------------------------------------

function buildObservation(context: InvocationContext, config: ObserveConfig): BuiltObservation {
    const target = context.target;
    const key = context.propertyKey;
    const owner = ownerNameOf(target);
    const member = memberName(key);

    const names = DecoratorFactory.getParamNames(context.original);
    const types = reflectTypes(target, key);

    const parameters: ResolvedParameter[] = names.map((recoveredName: string, index: number) => {
        const resolved = resolveParameterDisclosure(target, key, index);
        return {
            index,
            // The explicit-name hatch (DEC-OBS-4) wins over the recovered name, which degrades under
            // minification; fall back to the recovered name, then to nothing (index-only, never `arg0`).
            name: resolved.name || recoveredName || undefined,
            type: types[index],
            disclosure: resolved.disclosure,
            vetoed: resolved.vetoed,
        };
    });

    const returnDisclosure = resolveReturnDisclosure(target, key);

    // Surface the `@Sensitive`-veto-of-an-explicit-opt-in collision (Q-24 R8): the value stays redacted, but
    // the collision is announced once (this build runs once per decorated method) rather than silenced.
    const vetoed = parameters.filter(p => p.vetoed).map(p => `#${p.index}${p.name ? ` (${p.name})` : ''}`);
    if (returnDisclosure.vetoed) vetoed.push('return');
    if (vetoed.length > 0) {
        reportDiagnostic(
            `[adorn] @Telemetry opt-in on ${owner}.${member} ${vetoed.join(', ')} is overridden by ` +
                '@Sensitive; the value stays redacted (the veto wins, DEC-025). Remove @Sensitive to ' +
                'disclose it, or drop the @Telemetry opt-in to silence this notice.',
        );
    }

    const publicParameters: ObservedParameter[] = parameters.map(p => {
        const op: ObservedParameter = {index: p.index, disclosure: p.disclosure};
        return Object.freeze(
            p.name !== undefined
                ? p.type !== undefined
                    ? {...op, name: p.name, type: p.type}
                    : {...op, name: p.name}
                : p.type !== undefined
                  ? {...op, type: p.type}
                  : op,
        );
    });
    Object.freeze(publicParameters);

    const observation: Observation = Object.freeze({
        owner,
        member,
        name: `${owner}.${member}`,
        isStatic: typeof target === 'function',
        detail: config.detail,
        kind: config.kind,
        parameters: publicParameters,
    });

    return {observation, parameters, returnDisclosure};
}

// ---------------------------------------------------------------------------
// Per-call rendering — the record path carries only pre-disclosed data
// ---------------------------------------------------------------------------

function renderValues(parameters: ReadonlyArray<ResolvedParameter>, args: any[]): EmittedValue[] {
    const out: EmittedValue[] = [];
    for (const p of parameters) {
        // Only positions the method was actually handed — an omitted optional parameter discloses nothing.
        if (p.index >= args.length) continue;
        out.push(renderOne(p, args[p.index]));
    }
    return out;
}

function renderOne(p: ResolvedParameter, value: unknown): EmittedValue {
    const base = {index: p.index, name: p.name, type: p.type};
    if (p.disclosure === 'value') {
        return {...base, disclosed: true, rendering: renderScalar(value)};
    }
    if (typeof p.disclosure === 'object') {
        return {...base, disclosed: true, rendering: applyStrategy(p.disclosure.redact, value)};
    }
    // 'deny' — REDACTED. Flag a vetoed explicit opt-in so a sink can tell it apart from a plain default.
    return p.vetoed
        ? {...base, disclosed: false, rendering: REDACTED, vetoed: true}
        : {...base, disclosed: false, rendering: REDACTED};
}

/** The return `EmittedValue`, or `[]` when the return carries no opt-in (and was not vetoed). */
function renderReturnValues(
    returnDisclosure: ResolvedDisclosure,
    settlement: Settlement<unknown>,
): EmittedValue[] {
    if (returnDisclosure.vetoed) {
        return [{index: RETURN_INDEX, name: 'return', disclosed: false, rendering: REDACTED, vetoed: true}];
    }
    if (!returnDisclosure.declared || settlement.outcome !== 'returned') return [];
    const disclosure = returnDisclosure.disclosure;
    if (disclosure === 'value') {
        return [
            {index: RETURN_INDEX, name: 'return', disclosed: true, rendering: renderScalar(settlement.value)},
        ];
    }
    if (typeof disclosure === 'object') {
        return [
            {
                index: RETURN_INDEX,
                name: 'return',
                disclosed: true,
                rendering: applyStrategy(disclosure.redact, settlement.value),
            },
        ];
    }
    return [];
}

function recordCompleted(
    sink: ObservationSink,
    built: BuiltObservation,
    values: EmittedValue[],
    settlement: Settlement<unknown>,
    callId: number,
): void {
    const allValues = values.concat(renderReturnValues(built.returnDisclosure, settlement));
    const event: ObservationEvent =
        settlement.outcome === 'threw'
            ? {
                  kind: 'completed',
                  observation: built.observation,
                  callId,
                  durationMs: settlement.durationMs,
                  outcome: 'threw',
                  settled: settlement.settled,
                  values: allValues,
                  error: toErrorFacts(settlement.error),
              }
            : {
                  kind: 'completed',
                  observation: built.observation,
                  callId,
                  durationMs: settlement.durationMs,
                  outcome: 'returned',
                  settled: settlement.settled,
                  values: allValues,
              };
    recordSafely(sink, event);
}

// ---------------------------------------------------------------------------
// Total value rendering — never throws (a broken render must not break the call)
// ---------------------------------------------------------------------------

/** A scalar rendering for an `EmittedValue`. Primitives pass through; everything else is a safe string. */
function renderScalar(value: unknown): string | number | boolean | null {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value as string | number | boolean;
    if (t === 'undefined') return 'undefined';
    if (t === 'bigint') return `${String(value)}n`;
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    } catch {
        return '[unserializable]';
    }
}

/** Apply a `@Telemetry.redact` surrogate strategy. Honest by construction — the strategy names its output. */
function applyStrategy(strategy: string, value: unknown): string | number | boolean | null {
    if (strategy === 'type') return typeName(value);
    if (strategy === 'length') {
        const len =
            value && typeof (value as {length?: unknown}).length === 'number'
                ? (value as {length: number}).length
                : null;
        return len;
    }
    // Unknown strategy is rejected at decoration time; if one slips through, redact rather than guess.
    return REDACTED;
}

function typeName(value: unknown): string {
    if (value === null) return 'null';
    const t = typeof value;
    if (t !== 'object') return t;
    const ctor = (value as {constructor?: {name?: string}}).constructor;
    return (ctor && ctor.name) || 'Object';
}

function toErrorFacts(error: unknown): ErrorFacts {
    if (error && typeof error === 'object') {
        const named = (error as {name?: unknown}).name;
        const type = typeof named === 'string' && named ? named : '_OTHER';
        return {type, message: stringField(error, 'message'), stack: stringField(error, 'stack')};
    }
    return {type: '_OTHER', message: String(error)};
}

function stringField(error: object, field: 'message' | 'stack'): string | undefined {
    const v = (error as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : undefined;
}

/** Hand one event to `record`, guarded — a telemetry sink that throws must never become the call's failure. */
function recordSafely(sink: ObservationSink, event: ObservationEvent): void {
    try {
        if (sink.record) sink.record(event);
    } catch {
        // Contained: observation is not authoritative.
    }
}

// ---------------------------------------------------------------------------
// A ready-made zero-dependency console sink (opt-in; not installed by default)
// ---------------------------------------------------------------------------

/**
 * A plain, zero-dependency {@link ObservationSink} that writes one JSON line per event to `console.log`,
 * for out-of-the-box local visibility. Record-only (its `scope` would just be `proceed()`, so it is
 * omitted). It renders exactly the pre-disclosed `values` the resolver produced — a value shows only when a
 * `@Telemetry` opt-in (or `setValueDisclosure('all')`) permitted it, and `[REDACTED]` otherwise. Install it
 * with `setObservationSink(consoleObservationSink)`; it is never installed automatically (the automatic
 * signal stays quiet until a sink is chosen).
 */
export const consoleObservationSink: ObservationSink = {
    record(event: ObservationEvent): void {
        if (typeof console === 'undefined' || typeof console.log !== 'function') return;
        try {
            console.log(`[adorn:observe] ${JSON.stringify(summarize(event))}`);
        } catch {
            // A logging sink must never fail the call it is observing.
        }
    },
};

function summarize(event: ObservationEvent): object {
    const name = event.observation.name;
    if (event.kind === 'completed') {
        return {
            kind: 'completed',
            name,
            durationMs: Number(event.durationMs.toFixed(3)),
            outcome: event.outcome,
            settled: event.settled,
            ...(event.values && event.values.length ? {values: event.values} : {}),
            ...(event.error ? {error: event.error} : {}),
        };
    }
    if (event.kind === 'violation') {
        return {
            kind: 'violation',
            name,
            violation: event.violation,
            ...(event.error ? {error: event.error} : {}),
        };
    }
    return {
        kind: 'message',
        name,
        level: event.level,
        ...(event.message ? {message: event.message} : {}),
        attributes: event.attributes,
        ...(event.values && event.values.length ? {values: event.values} : {}),
    };
}

// ---------------------------------------------------------------------------
// Small internals
// ---------------------------------------------------------------------------

function reflectTypes(target: object, key: MethodKey): Array<string | undefined> {
    const reflect: any = typeof Reflect === 'object' ? Reflect : undefined;
    if (!reflect || typeof reflect.getMetadata !== 'function') return [];
    let types: unknown;
    try {
        types = reflect.getMetadata('design:paramtypes', target, key);
    } catch {
        return [];
    }
    if (!Array.isArray(types)) return [];
    return (types as unknown[]).map(entry =>
        typeof entry === 'function' && entry.name ? entry.name : undefined,
    );
}

function ownerNameOf(target: object): string {
    if (typeof target === 'function') return (target as Function).name || '<anonymous class>';
    const constructor = target && (target as {constructor?: Function}).constructor;
    return (constructor && constructor.name) || '<anonymous class>';
}

function memberName(key: MethodKey): string {
    return typeof key === 'symbol' ? key.toString() : String(key);
}
