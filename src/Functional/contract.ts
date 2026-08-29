/**
 * `contract()` — the functional twin of the contract & observation decorators (voice-agent L9, DEC-074).
 *
 * ## Why this exists
 *
 * adorn already gives three decorator jobs a functional form — `@Tool` → `toolSchemaFrom`, the markers →
 * `ToolParamSpec`, per-parameter contracts → `Verify.check`. This is the fourth: `@Contract` + `@Requires`
 * + `@Ensures` + `@Returns` + `@Observe`, available as a function, so a codebase with **zero classes** (an
 * LLM tool-runner, a reducer, a functional service) can enforce a contract on a plain function without a
 * decoration point. It completes the descriptor-first surface; it is not a new paradigm (decorators remain
 * the ergonomic front-end, and are themselves thin adapters over these same descriptors).
 *
 * ## No drift, by construction (DEC-006 / DEC-010)
 *
 * Every check here is the SAME oracle the decorator weave runs — per-parameter and return descriptors via
 * `Verify.check` (the descriptor's own predicate + message), preconditions via {@link evaluatePreconditions},
 * postconditions via {@link evaluatePostconditions}. There is not one re-implemented comparison. `settle`
 * (the shared classifier `@Time`/`@Observe` use) times the call and awaits an async result before the
 * return/postcondition band runs, so `contract()` and the decorator path cannot disagree.
 *
 * ## Enforcement order (matches `@Contract` installed outermost, DEC-043/DEC-015)
 *
 * per-parameter (left to right) → preconditions → **call** → return descriptor (reified band first, DEC-033)
 * → postconditions. A precondition failure throws before the body runs (no `completed` event); a
 * postcondition failure throws after it returns (a `completed` event, then a `violation`). A throw from the
 * body itself skips the postconditions, exactly as a decorated method does.
 *
 * ## Failure surfacing
 *
 * A violation throws a plain `Error` carrying the descriptor's (redacted) message — the same thing
 * `Verify.that` throws — because `ViolationError` is deliberately package-internal (facts reach a consumer
 * through the sink, not a typed catch). When `observe` is set, the structured {@link ViolationFacts} are
 * ALSO emitted as a `violation` event on the installed {@link getObservationSink}, via {@link violationFromCheck}
 * for a descriptor failure — which is L11, and is what lets a functional refusal be counted like a decorated one.
 */

import type {ConstraintDescriptor, ConstraintParams} from '../Core/Descriptor';
import {Verify, violationFromCheck} from '../Validation/Verify';
import {evaluatePreconditions} from '../Core/Preconditions';
import {evaluatePostconditions} from '../Core/Postconditions';
import type {Precondition, Postcondition} from '../Core/ContractRegistry';
import {settle, Settlement} from '../Core/settle';
import {
    getObservationSink,
    nextCallId,
    RETURN_INDEX,
    Observation,
    ObservationCall,
    ViolationFacts,
    SpanKind,
} from '../Core/Observation';

/** Any descriptor, for a positional `params` slot; `null` is a deliberate hole (an argument with no contract). */
type AnyDescriptor = ConstraintDescriptor<ConstraintParams, unknown>;

/** A function of any shape — the thing {@link contract} wraps, returning one of the same signature. */
type AnyFn = (...args: any[]) => any;

/**
 * The declarative contract for {@link contract}. Every field is optional — an all-empty spec is a no-op
 * wrapper. `params` is **positional** (a `null` slot is an argument with nothing to say about it, so it is
 * skipped), mirroring a decorated signature where an undecorated parameter is simply unconstrained.
 */
export interface ContractSpec {
    /** Per-parameter descriptors, positional. `null` = an unconstrained argument (a hole). */
    readonly params?: ReadonlyArray<AnyDescriptor | null>;
    /** Cross-parameter preconditions, `@Requires`-shaped: `(...args) => boolean`, or `{predicate, description}`. */
    readonly requires?: ReadonlyArray<((...args: any[]) => boolean) | Precondition>;
    /**
     * Postconditions, `@Ensures`-shaped: `(result, ...args) => boolean`, or `{predicate, description}`.
     * `result` is typed `any` (not the decorator band's `unknown`), so a caller may annotate it — `(r: Foo)
     * => …` — without a cast; the runtime check is unchanged.
     */
    readonly ensures?: ReadonlyArray<((result: any, ...args: any[]) => boolean) | Postcondition>;
    /** Reified return descriptor, `@Returns`-shaped — checked before the closure `ensures`. */
    readonly returns?: AnyDescriptor;
    /** When present, wrap the call in an observation `scope` and emit `completed`/`violation` events. */
    readonly observe?: {readonly kind?: SpanKind; readonly name?: string};
}

const toPrecondition = (entry: ((...args: any[]) => boolean) | Precondition): Precondition =>
    typeof entry === 'function' ? {predicate: entry} : entry;

const toPostcondition = (entry: ((result: any, ...args: any[]) => boolean) | Postcondition): Postcondition =>
    typeof entry === 'function' ? {predicate: entry} : entry;

function makeObservation(observe: {kind?: SpanKind; name?: string}, fn: AnyFn): Observation {
    const name = observe.name || fn.name || 'anonymous';
    const dot = name.indexOf('.');
    return {
        owner: dot > 0 ? name.slice(0, dot) : '',
        member: dot > 0 ? name.slice(dot + 1) : name,
        name,
        isStatic: false,
        detail: 'always',
        kind: observe.kind || 'internal',
        parameters: [],
    };
}

/** Synthesise value-free facts for a CLOSURE (`requires`/`ensures`) failure — no descriptor, so `_OTHER`. */
function closureViolation(description: string | undefined, blame: 'caller' | 'callee'): ViolationFacts {
    return {
        constraint: '_OTHER',
        kind: 'generic',
        params: {},
        expectation: description || '',
        parameterIndex: blame === 'callee' ? RETURN_INDEX : 0,
        trust: 'guard',
        blame,
    };
}

const closureMessage = (band: 'Precondition' | 'Postcondition', description: string | undefined, error: unknown): string => {
    const tail = description ? ` (${description})` : '';
    if (error !== undefined) return `${band} threw${tail}: ${String((error as {message?: unknown})?.message ?? error)}`;
    return `${band} not met${tail}`;
};

/**
 * Wrap `fn` with the contract in `spec`, returning a function of the same signature. See the module header
 * for the enforcement order and no-drift guarantee.
 */
export function contract<F extends AnyFn>(spec: ContractSpec, fn: F): F {
    const pres = (spec.requires || []).map(toPrecondition);
    const posts = (spec.ensures || []).map(toPostcondition);
    const observe = spec.observe;
    const observation = observe ? makeObservation(observe, fn) : undefined;

    const wrapped = function (this: unknown, ...args: any[]): any {
        const sink = observe ? getObservationSink() : undefined;
        const callId = observe ? nextCallId() : 0;
        const emitViolation = (facts: ViolationFacts): void => {
            if (sink && observation) sink.record?.({kind: 'violation', observation, callId, violation: facts});
        };

        // 1. Per-parameter descriptors, left to right (declaration order).
        if (spec.params) {
            for (let i = 0; i < spec.params.length; i++) {
                const descriptor = spec.params[i];
                if (!descriptor) continue; // a hole
                const r = Verify.check(descriptor, `arg${i}`, args[i]);
                if (!r.ok) {
                    // `strict` narrows `r` to the CheckResult failure arm here (DEC-079) — no cast.
                    emitViolation(violationFromCheck(r, {index: i, blame: 'caller'}));
                    throw new Error(r.message);
                }
            }
        }

        // 2. Cross-parameter preconditions — the same oracle @Requires runs.
        if (pres.length) {
            const pre = evaluatePreconditions(pres, args);
            if (!pre.ok) {
                emitViolation(closureViolation(pre.failed && pre.failed.description, 'caller'));
                throw new Error(closureMessage('Precondition', pre.failed && pre.failed.description, pre.error));
            }
        }

        // 3. Call, timed and async-aware. The return/postcondition band runs on the SETTLED value; an
        // onSettle throw propagates (sync) or rejects the returned promise (async) — that IS the enforcement.
        const onSettle = (s: Settlement<unknown>): void => {
            if (sink && observation) {
                sink.record?.({
                    kind: 'completed',
                    observation,
                    callId,
                    durationMs: s.durationMs,
                    outcome: s.outcome,
                    settled: s.settled,
                });
            }
            if (s.outcome !== 'returned') return; // the body threw — a throw skips postconditions
            const result = s.value;

            // 4. Return descriptor (reified band first, DEC-033).
            if (spec.returns) {
                const rr = Verify.check(spec.returns, 'return', result);
                if (!rr.ok) {
                    // `strict` narrows `rr` to the failure arm here (DEC-079) — no cast.
                    emitViolation(violationFromCheck(rr, {parameter: 'return', index: RETURN_INDEX, blame: 'callee'}));
                    throw new Error(rr.message);
                }
            }

            // 5. Closure postconditions — the same oracle @Ensures runs.
            if (posts.length) {
                const post = evaluatePostconditions(posts, result, args);
                if (!post.ok) {
                    emitViolation(closureViolation(post.failed && post.failed.description, 'callee'));
                    throw new Error(closureMessage('Postcondition', post.failed && post.failed.description, post.error));
                }
            }
        };

        const invoke = (): unknown => settle(() => fn.apply(this, args), onSettle);
        if (sink && sink.scope && observation) {
            const call: ObservationCall = {observation, thisArg: this, values: [], callId};
            return sink.scope(call, invoke);
        }
        return invoke();
    };

    return wrapped as F;
}
