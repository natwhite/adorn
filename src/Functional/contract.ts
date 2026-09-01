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
 * ## Failure surfacing — routed through the violation policy (DEC-080)
 *
 * A violation is routed through `setViolationPolicy` exactly as the decorator weave routes one, so a
 * functional contract honours `'warn'`/a handler too (the audit's INC-3/INC-4 parity gap). By default it
 * throws a plain `Error` carrying the descriptor's (redacted) message — the same thing `Verify.that` throws;
 * `'warn'` logs and proceeds (into the body for a precondition, returning the settled value for a
 * postcondition); a handler takes control. `ViolationError` stays package-internal (facts reach a consumer
 * through the sink, not a typed catch). When `observe` is set, the structured {@link ViolationFacts} are ALSO
 * emitted as a `violation` event on the installed {@link getObservationSink} **before** the policy runs, so a
 * sink sees every violation regardless of how control flow is routed (seeing ≠ emitting, DEC-036) — via
 * {@link violationFromCheck} for a descriptor failure (L11, what lets a functional refusal be counted like a
 * decorated one).
 */

import type {ConstraintDescriptor, ConstraintParams} from '../Core/Descriptor';
import {Verify, violationFromCheck} from '../Validation/Verify';
import {evaluatePreconditions} from '../Core/Preconditions';
import {evaluatePostconditions} from '../Core/Postconditions';
import {applyViolationPolicy, DEFAULT_TRUST, type ViolationSite} from '../Core/Configuration';
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

/**
 * The metadata a {@link contract} wrapper carries about itself, hung off the returned function under
 * {@link CONTRACT_META} so the spec is no longer closure-captured and unreadable (voice-agent L19). It
 * makes a functional contract introspectable by exactly the parties the decorator path exposes a class
 * to: `contractSpecOf(fn)` recovers what a function *promises*, and the fuzzer (`@adorn/test`) reads the
 * raw target plus the normalised precondition/postcondition bands so it can fuzz a `contract()` function
 * the way `fuzzMethod` fuzzes a decorated one — checking the bands as an independent oracle (DEC-034).
 */
export interface ContractMeta {
    /** The declaration as written — what {@link contractSpecOf} hands back for introspection. */
    readonly spec: ContractSpec;
    /** The unwrapped function, so a driver can invoke it without the wrapper's own enforcement in the way. */
    readonly target: AnyFn;
    /** The `requires` band, normalised to {@link Precondition}s (the same the wrapper enforces). */
    readonly pres: ReadonlyArray<Precondition>;
    /** The `ensures` band, normalised to {@link Postcondition}s (the same the wrapper enforces). */
    readonly posts: ReadonlyArray<Postcondition>;
}

/** Where {@link ContractMeta} is hung on a wrapper — a non-enumerable symbol, so it never shows up as data. */
const CONTRACT_META = Symbol('adorn.contract.meta');

/**
 * Recover the full {@link ContractMeta} of a {@link contract} wrapper, or `undefined` for any other value.
 * Package-internal (the raw `target` is not something a downstream consumer needs); the fuzzer reads it.
 */
export function contractMetaOf(fn: unknown): ContractMeta | undefined {
    return typeof fn === 'function'
        ? ((fn as unknown as Record<symbol, unknown>)[CONTRACT_META] as ContractMeta | undefined)
        : undefined;
}

/**
 * Recover the {@link ContractSpec} a {@link contract} wrapper enforces — what the function *promises* —
 * or `undefined` if `fn` was not produced by `contract()`. The public half of {@link contractMetaOf}: it
 * closes voice-agent L19's "the spec is closure-captured and unreadable by anyone, adorn's own fuzzer
 * included" — a consumer holding only the wrapped function can now read its contract back.
 */
export function contractSpecOf(fn: unknown): ContractSpec | undefined {
    return contractMetaOf(fn)?.spec;
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

    // The site a violation is routed to (DEC-080). `contract()` now consults `setViolationPolicy` exactly
    // as the decorator weave does, so `'warn'`/a handler governs a functional contract too — the parity the
    // audit's INC-3/INC-4 named. Owner/member are derived from `observe.name` or `fn.name` (best-effort;
    // an anonymous fn yields ''/'anonymous'); trust is the process default (`contract()` models no trust
    // level of its own — a precondition still blames the caller, a postcondition the callee).
    const siteName = (observe && observe.name) || fn.name || 'anonymous';
    const siteDot = siteName.indexOf('.');
    const siteOwner = siteDot > 0 ? siteName.slice(0, siteDot) : '';
    const siteMember = siteDot > 0 ? siteName.slice(siteDot + 1) : siteName;
    const callerSite: ViolationSite = {owner: siteOwner, member: siteMember, trust: DEFAULT_TRUST, blame: 'caller'};
    const calleeSite: ViolationSite = {owner: siteOwner, member: siteMember, trust: DEFAULT_TRUST, blame: 'callee'};

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
                    // Route through the policy (DEC-080): throws by default, or `'warn'`/a handler proceeds
                    // — the loop then continues into the body with the offending argument. The violation
                    // event above already fired, regardless (seeing ≠ emitting, DEC-036).
                    applyViolationPolicy(new Error(r.message), callerSite);
                }
            }
        }

        // 2. Cross-parameter preconditions — the same oracle @Requires runs.
        if (pres.length) {
            const pre = evaluatePreconditions(pres, args);
            if (!pre.ok) {
                emitViolation(closureViolation(pre.failed && pre.failed.description, 'caller'));
                // Policy-routed (DEC-080): `'warn'`/a handler falls through into the call below.
                applyViolationPolicy(
                    new Error(closureMessage('Precondition', pre.failed && pre.failed.description, pre.error)),
                    callerSite,
                );
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
                    // Policy-routed (DEC-080): under `'warn'`/a suppressing handler, `onSettle` does not
                    // throw, so `settle` returns the (contract-violating) value — as the decorator does.
                    applyViolationPolicy(new Error(rr.message), calleeSite);
                }
            }

            // 5. Closure postconditions — the same oracle @Ensures runs.
            if (posts.length) {
                const post = evaluatePostconditions(posts, result, args);
                if (!post.ok) {
                    emitViolation(closureViolation(post.failed && post.failed.description, 'callee'));
                    // Policy-routed (DEC-080): `'warn'`/a suppressing handler returns the value.
                    applyViolationPolicy(
                        new Error(closureMessage('Postcondition', post.failed && post.failed.description, post.error)),
                        calleeSite,
                    );
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

    // Make the wrapper introspectable (voice-agent L19): preserve the wrapped function's own name (a bare
    // `const wrapped = function () {}` would report `"wrapped"`, so a fuzz report could not say what it
    // fuzzed), and hang the spec + raw target + normalised bands off it so the spec is no longer
    // closure-captured and unreadable. The symbol is non-enumerable, so no serialiser or key-walk sees it.
    Object.defineProperty(wrapped, 'name', {value: fn.name, configurable: true});
    Object.defineProperty(wrapped, CONTRACT_META, {
        value: {spec, target: fn, pres, posts} satisfies ContractMeta,
        enumerable: false,
        writable: false,
        configurable: true,
    });

    return wrapped as F;
}
