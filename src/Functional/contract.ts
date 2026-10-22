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
import type {CheckFailure} from '../Validation/Verify';
import {evaluatePreconditions} from '../Core/Preconditions';
import {evaluatePostconditions} from '../Core/Postconditions';
import {captureOldState} from '../Core/prestate';
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
 * The object form a `requires`/`ensures` entry may take: a predicate of the band's shape plus an optional
 * human `description` and an optional stable `id`. Spec-local (not the registry's `Precondition`/
 * `Postcondition`) so the predicate's `result`/args stay `any` — a caller annotates them without a cast
 * (axiform feedback 2026-10-18 §7) — and so `id` (§5) rides the authoring surface. Normalised to the
 * registry shapes by {@link toPrecondition}/{@link toPostcondition}; the `any`-param predicate is assignable
 * to the registry band's `unknown`-param predicate, so there is no runtime or drift difference.
 */
interface SpecClause<P> {
    readonly predicate: P;
    readonly description?: string;
    readonly id?: string;
}

/**
 * The capturing form of an `ensures` entry (axiform feedback 2026-10-18 §9): a `capture(...args)` run at call
 * ENTRY whose deep-cloned, frozen result is handed to the predicate as a leading `old` — so a postcondition
 * can compare against pre-mutation state that a body-mutating argument would otherwise have overwritten. The
 * predicate reads `(result, old, ...args)`; `old` is typed `any` so the author annotates it (`old: Foo`)
 * without a cast. See `Core/prestate` for the snapshot semantics (cloneable data only; non-cloneable throws).
 */
interface CapturingPostcondition {
    readonly capture: (...args: any[]) => any;
    readonly predicate: (result: any, old: any, ...args: any[]) => boolean;
    readonly description?: string;
    readonly id?: string;
}

/**
 * The declarative contract for {@link contract}. Every field is optional — an all-empty spec is a no-op
 * wrapper. `params` is **positional** (a `null` slot is an argument with nothing to say about it, so it is
 * skipped), mirroring a decorated signature where an undecorated parameter is simply unconstrained.
 */
export interface ContractSpec {
    /** Per-parameter descriptors, positional. `null` = an unconstrained argument (a hole). */
    readonly params?: ReadonlyArray<AnyDescriptor | null>;
    /** Cross-parameter preconditions, `@Requires`-shaped: `(...args) => boolean`, or `{predicate, description?, id?}`. */
    readonly requires?: ReadonlyArray<
        ((...args: any[]) => boolean) | SpecClause<(...args: any[]) => boolean>
    >;
    /**
     * Postconditions, `@Ensures`-shaped: `(result, ...args) => boolean`, or `{predicate, description?, id?}`.
     * `result` is typed `any` (not the registry band's `unknown`) in BOTH forms, so a caller may annotate it
     * — `(r: Foo) => …` or `{predicate: (r: Foo) => …}` — without a cast (axiform feedback 2026-10-18 §7: the
     * object form formerly reused `Postcondition`'s `result: unknown`, so an annotated predicate that
     * type-checked as a bare function failed to type-check as `{predicate}`). The runtime check is unchanged.
     */
    readonly ensures?: ReadonlyArray<
        | ((result: any, ...args: any[]) => boolean)
        | SpecClause<(result: any, ...args: any[]) => boolean>
        | CapturingPostcondition
    >;
    /** Reified return descriptor, `@Returns`-shaped — checked before the closure `ensures`. */
    readonly returns?: AnyDescriptor;
    /** When present, wrap the call in an observation `scope` and emit `completed`/`violation` events. */
    readonly observe?: {readonly kind?: SpanKind; readonly name?: string};
}

/**
 * The band a {@link ContractVerdict} failure occurred in — the enforcement order, minus `'body'` (a throw
 * from the function itself, which is its own verdict arm).
 */
export type VerdictBand = 'params' | 'requires' | 'returns' | 'ensures';

/**
 * One failing clause in a {@link ContractVerdict}: the value-free {@link ViolationFacts} (including the
 * localized `path` for a compositional descriptor, axiform §4) plus the band, the position WITHIN the band,
 * the clause's declared `id` if any (§5), and the redacted `message` — everything an evidence record needs,
 * as data, with no throw.
 */
export interface VerdictFailure {
    readonly band: VerdictBand;
    /**
     * Position within the band: the argument index for `params`, the clause index for `requires`/`ensures`,
     * `RETURN_INDEX` for the single `returns` descriptor.
     */
    readonly index: number;
    /** The clause's declared `id` (a `{predicate, id}` entry in `requires`/`ensures`), if it carried one. */
    readonly id?: string;
    readonly facts: ViolationFacts;
    /** The redacted message the enforcing form would have thrown. */
    readonly message: string;
}

/**
 * The per-call verdict {@link ContractFn.checked} returns INSTEAD of throwing (axiform feedback 2026-10-18
 * §1/§2) — the structured outcome as data, with NO global state: it never routes through `setViolationPolicy`
 * and never emits to the observation sink. The SAME bands the enforcing {@link contract} runs, surfaced
 * rather than thrown, through the SAME oracles (no drift).
 *
 * - `{ok: true, value, durationMs}` — every band held; `value` is the settled return.
 * - `{ok: false, band: 'params'|'requires'|'returns'|'ensures', index, id?, facts, message, value?, failures?}`
 *   — a contract band failed. The top-level fields are the FIRST failure; `value` is the settled return for a
 *   `returns`/`ensures` failure (the body ran) and ABSENT for a `params`/`requires` failure (the body did not
 *   run). With `{evaluate: 'all'}`, `failures` lists every failure in the evaluated bands (`failures[0]` equals
 *   the top-level fields); without it only the first is reported.
 * - `{ok: false, band: 'body', error, durationMs}` — the function itself threw/rejected; the throw is captured
 *   (never swallowed, never re-thrown), and the `returns`/`ensures` bands are skipped, exactly as enforcement
 *   skips them on a body throw.
 */
export type ContractVerdict<R = unknown> =
    | {readonly ok: true; readonly value: R; readonly durationMs: number}
    | ({
          readonly ok: false;
          readonly durationMs: number;
          readonly value?: R;
          readonly failures?: ReadonlyArray<VerdictFailure>;
      } & VerdictFailure)
    | {readonly ok: false; readonly band: 'body'; readonly error: unknown; readonly durationMs: number};

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

const toPrecondition = (
    entry: ((...args: any[]) => boolean) | SpecClause<(...args: any[]) => boolean>,
): Precondition =>
    typeof entry === 'function'
        ? {predicate: entry}
        : {predicate: entry.predicate, description: entry.description, id: entry.id};

const toPostcondition = (
    entry:
        | ((result: any, ...args: any[]) => boolean)
        | SpecClause<(result: any, ...args: any[]) => boolean>
        | CapturingPostcondition,
): Postcondition => {
    if (typeof entry === 'function') return {predicate: entry};
    const capture = 'capture' in entry ? entry.capture : undefined;
    return {
        predicate: entry.predicate,
        description: entry.description,
        id: entry.id,
        ...(capture ? {capture} : {}),
    };
};

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

const closureMessage = (
    band: 'Precondition' | 'Postcondition',
    description: string | undefined,
    error: unknown,
): string => {
    const tail = description ? ` (${description})` : '';
    if (error !== undefined)
        return `${band} threw${tail}: ${String((error as {message?: unknown})?.message ?? error)}`;
    return `${band} not met${tail}`;
};

// ---------------------------------------------------------------------------
// Per-call verdict (axiform §1): the shared failure builders + the pure evaluator `contract.checked` uses.
//
// Both the enforcing path (below) and `contract.checked` construct their failures HERE, so a verdict's
// facts/message/band/index/id are byte-identical to what enforcement emits and throws — the no-drift
// guarantee extends past the shared `Verify.check`/`evaluatePreconditions`/`evaluatePostconditions` oracles to
// the failure DATA itself. Only the SURFACING differs: enforcement emits + routes through the violation policy
// (may throw); `checked` records into the verdict and never touches global state.
// ---------------------------------------------------------------------------

const paramFailure = (index: number, r: CheckFailure): VerdictFailure => ({
    band: 'params',
    index,
    facts: violationFromCheck(r, {index, blame: 'caller'}),
    message: r.message,
});

const requiresFailure = (index: number, failed: Precondition, error: unknown): VerdictFailure => ({
    band: 'requires',
    index,
    ...(failed.id !== undefined ? {id: failed.id} : {}),
    facts: closureViolation(failed.description, 'caller'),
    message: closureMessage('Precondition', failed.description, error),
});

const returnsFailure = (r: CheckFailure): VerdictFailure => ({
    band: 'returns',
    index: RETURN_INDEX,
    facts: violationFromCheck(r, {parameter: 'return', index: RETURN_INDEX, blame: 'callee'}),
    message: r.message,
});

const ensuresFailure = (index: number, failed: Postcondition, error: unknown): VerdictFailure => ({
    band: 'ensures',
    index,
    ...(failed.id !== undefined ? {id: failed.id} : {}),
    facts: closureViolation(failed.description, 'callee'),
    message: closureMessage('Postcondition', failed.description, error),
});

/**
 * Assemble a failure verdict from the collected failures. `failures[0]` is surfaced at the top level; the full
 * list rides `failures` only in `evaluate:'all'` mode. `ran` distinguishes a post-call failure (the body ran —
 * carry `value`, even when it is `undefined`) from a pre-call one (no body ran, so no value).
 */
function failureVerdict<R>(
    failures: ReadonlyArray<VerdictFailure>,
    ran: boolean,
    value: R | undefined,
    durationMs: number,
    all: boolean,
): ContractVerdict<R> {
    const first = failures[0];
    const verdict: Record<string, unknown> = {
        ok: false,
        band: first.band,
        index: first.index,
        facts: first.facts,
        message: first.message,
        durationMs,
    };
    if (first.id !== undefined) verdict.id = first.id;
    if (ran) verdict.value = value;
    if (all) verdict.failures = failures;
    return verdict as ContractVerdict<R>;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as {then?: unknown}).then === 'function';

/**
 * The pure per-call evaluator behind {@link ContractFn.checked}. Runs the bands in enforcement order and
 * returns a {@link ContractVerdict} — it NEVER throws for a contract violation, NEVER consults
 * `setViolationPolicy`, and NEVER emits to the observation sink (the "no global state" axiform §1 asks for). A
 * pre-call failure (params/requires) short-circuits the body: the body is never run on input the contract
 * rejects (evidence integrity, and it matches the enforcing path, which throws before the body on a
 * precondition). The settled value/duration come from the shared {@link settle} classifier, so sync and async
 * are classified exactly as `contract()`/`@Time` classify them. An Observable return is out of scope (this
 * form is sync/Promise-oriented): the stream passes through as the value with the post-bands unchecked.
 */
function evaluateToVerdict<R>(
    fn: AnyFn,
    spec: ContractSpec,
    pres: ReadonlyArray<Precondition>,
    posts: ReadonlyArray<Postcondition>,
    thisArg: unknown,
    args: any[],
    evaluate: 'first' | 'all',
): ContractVerdict<R> | Promise<ContractVerdict<R>> {
    const all = evaluate === 'all';
    const pre: VerdictFailure[] = [];

    // 1. Per-parameter descriptors (positional, left to right).
    if (spec.params) {
        for (let i = 0; i < spec.params.length; i++) {
            const descriptor = spec.params[i];
            if (!descriptor) continue; // a hole
            const r = Verify.check(descriptor, `arg${i}`, args[i]);
            if (!r.ok) {
                pre.push(paramFailure(i, r));
                if (!all) return failureVerdict<R>(pre, false, undefined, 0, false);
            }
        }
    }

    // 2. Cross-parameter preconditions — the SAME evaluator enforcement runs. Per-clause in `all` mode (to
    //    report every failing requirement with its index), the batch call in `first` mode (stops at the first,
    //    matching enforcement). `evaluatePreconditions` is total — it catches a predicate throw — so running it
    //    after a param failure in `all` mode is safe.
    if (pres.length) {
        if (all) {
            for (let i = 0; i < pres.length; i++) {
                const rr = evaluatePreconditions([pres[i]], args);
                if (!rr.ok) pre.push(requiresFailure(i, pres[i], rr.error));
            }
        } else {
            const rr = evaluatePreconditions(pres, args);
            if (!rr.ok) {
                pre.push(requiresFailure(pres.indexOf(rr.failed), rr.failed, rr.error));
                return failureVerdict<R>(pre, false, undefined, 0, false);
            }
        }
    }

    // A pre-call failure (reachable only in `all` mode here — `first` mode returned above): do NOT run the body.
    if (pre.length) return failureVerdict<R>(pre, false, undefined, 0, all);

    // Pre-state snapshot (axiform §9), captured BEFORE the body so a postcondition's `old` is entry-state.
    const olds = posts.length ? captureOldState(posts, args) : undefined;

    // 3. Run the body (timed, async-aware via the shared classifier). The verdict is built in `onSettle`,
    //    which fires once when the call settles — synchronously for a sync body, later for a promise.
    let verdict: ContractVerdict<R> | undefined;
    const onSettle = (s: Settlement<unknown>): void => {
        if (s.outcome !== 'returned') {
            verdict = {ok: false, band: 'body', error: s.error, durationMs: s.durationMs};
            return; // a body throw skips the post bands, exactly as the enforcing path does
        }
        const result = s.value as R;
        const post: VerdictFailure[] = [];

        // 4. Reified return descriptor (checked first, DEC-033).
        if (spec.returns) {
            const rr = Verify.check(spec.returns, 'return', result);
            if (!rr.ok) {
                post.push(returnsFailure(rr));
                if (!all) {
                    verdict = failureVerdict<R>(post, true, result, s.durationMs, false);
                    return;
                }
            }
        }

        // 5. Closure postconditions — the SAME evaluator enforcement runs, with the entry-captured `olds`.
        if (posts.length) {
            if (all) {
                for (let i = 0; i < posts.length; i++) {
                    const pr = evaluatePostconditions([posts[i]], result, args, olds ? [olds[i]] : undefined);
                    if (!pr.ok) post.push(ensuresFailure(i, posts[i], pr.error));
                }
            } else {
                const pr = evaluatePostconditions(posts, result, args, olds);
                if (!pr.ok) post.push(ensuresFailure(posts.indexOf(pr.failed), pr.failed, pr.error));
            }
        }

        verdict =
            post.length > 0
                ? failureVerdict<R>(post, true, result, s.durationMs, all)
                : {ok: true, value: result, durationMs: s.durationMs};
    };

    let out: unknown;
    try {
        out = settle(() => fn.apply(thisArg, args), onSettle);
    } catch {
        // A synchronous body throw: `settle` handed the settlement to `onSettle` (which set the `body` verdict)
        // and then re-threw. We swallow that re-throw — the throw IS the verdict here, not an escape.
        return verdict as ContractVerdict<R>;
    }
    if (isThenable(out)) {
        // Async: `onSettle` fires when the promise settles, BEFORE this continuation runs, so the verdict is
        // built either way. A rejection is a captured `band:'body'` verdict — never a propagated rejection.
        return Promise.resolve(out).then(
            () => verdict as ContractVerdict<R>,
            () => verdict as ContractVerdict<R>,
        );
    }
    // Sync return (verdict set by `onSettle`), or an Observable passthrough (settle fires `onSettle` only on
    // subscription, which has not happened): the stream is handed back as the value, post-bands unchecked.
    return verdict ?? {ok: true, value: out as R, durationMs: 0};
}

/**
 * Wrap `fn` with the contract in `spec`, returning a function of the same signature. See the module header
 * for the enforcement order and no-drift guarantee. The public entry point is the {@link contract} value
 * below (this impl plus its `.checked` twin).
 */
function contractImpl<F extends AnyFn>(spec: ContractSpec, fn: F): F {
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
    const callerSite: ViolationSite = {
        owner: siteOwner,
        member: siteMember,
        trust: DEFAULT_TRUST,
        blame: 'caller',
    };
    const calleeSite: ViolationSite = {
        owner: siteOwner,
        member: siteMember,
        trust: DEFAULT_TRUST,
        blame: 'callee',
    };

    const wrapped = function (this: unknown, ...args: any[]): any {
        const sink = observe ? getObservationSink() : undefined;
        const callId = observe ? nextCallId() : 0;
        const emitViolation = (facts: ViolationFacts): void => {
            if (sink && observation)
                sink.record?.({kind: 'violation', observation, callId, violation: facts});
        };

        // 1. Per-parameter descriptors, left to right (declaration order).
        if (spec.params) {
            for (let i = 0; i < spec.params.length; i++) {
                const descriptor = spec.params[i];
                if (!descriptor) continue; // a hole
                const r = Verify.check(descriptor, `arg${i}`, args[i]);
                if (!r.ok) {
                    // `strict` narrows `r` to the CheckResult failure arm here (DEC-079) — no cast. The facts +
                    // message come from the SHARED builder `contract.checked` uses, so the two cannot drift.
                    const f = paramFailure(i, r);
                    emitViolation(f.facts);
                    // Route through the policy (DEC-080): throws by default, or `'warn'`/a handler proceeds
                    // — the loop then continues into the body with the offending argument. The violation
                    // event above already fired, regardless (seeing ≠ emitting, DEC-036).
                    applyViolationPolicy(new Error(f.message), callerSite);
                }
            }
        }

        // 2. Cross-parameter preconditions — the same oracle @Requires runs.
        if (pres.length) {
            const pre = evaluatePreconditions(pres, args);
            if (!pre.ok) {
                const f = requiresFailure(pres.indexOf(pre.failed), pre.failed, pre.error);
                emitViolation(f.facts);
                // Policy-routed (DEC-080): `'warn'`/a handler falls through into the call below.
                applyViolationPolicy(new Error(f.message), callerSite);
            }
        }

        // Pre-state snapshot (axiform §9): capture BEFORE the body runs, so a postcondition's `old` reflects
        // entry-state even if the body mutates an argument. Computed here (after the pre-call gate, which does
        // not mutate args) and read in the postcondition band below.
        const olds = posts.length ? captureOldState(posts, args) : undefined;

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
                    // `strict` narrows `rr` to the failure arm here (DEC-079) — no cast; shared builder.
                    const f = returnsFailure(rr);
                    emitViolation(f.facts);
                    // Policy-routed (DEC-080): under `'warn'`/a suppressing handler, `onSettle` does not
                    // throw, so `settle` returns the (contract-violating) value — as the decorator does.
                    applyViolationPolicy(new Error(f.message), calleeSite);
                }
            }

            // 5. Closure postconditions — the same oracle @Ensures runs.
            if (posts.length) {
                const post = evaluatePostconditions(posts, result, args, olds);
                if (!post.ok) {
                    const f = ensuresFailure(posts.indexOf(post.failed), post.failed, post.error);
                    emitViolation(f.facts);
                    // Policy-routed (DEC-080): `'warn'`/a suppressing handler returns the value.
                    applyViolationPolicy(new Error(f.message), calleeSite);
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

    // Make the wrapper carry the wrapped function's identity (voice-agent L19/L22): its `name` (a bare
    // `const wrapped = function () {}` reports `"wrapped"`, so a fuzz report could not say what it fuzzed)
    // AND its arity (`length`). A `(...args) => …` wrapper has `length` 0, which erases the signature every
    // arity-aware caller reads — `Function.prototype.bind`, currying helpers, argument-count assertions,
    // and a fuzzer inferring how many positions to generate (L22). Both are restored here; then the spec +
    // raw target + normalised bands are hung off a non-enumerable symbol (invisible to any key-walk) so the
    // spec is no longer closure-captured and unreadable.
    Object.defineProperty(wrapped, 'name', {value: fn.name, configurable: true});
    Object.defineProperty(wrapped, 'length', {value: fn.length, configurable: true});
    Object.defineProperty(wrapped, CONTRACT_META, {
        value: {spec, target: fn, pres, posts} satisfies ContractMeta,
        enumerable: false,
        writable: false,
        configurable: true,
    });

    return wrapped as F;
}

/**
 * The verdict type {@link ContractFn.checked} yields for a function of return type `R`: a bare
 * {@link ContractVerdict} for a sync function, a promise of one for an async (thenable-returning) function.
 */
type CheckedResult<R> = [R] extends [Promise<infer U>] ? Promise<ContractVerdict<U>> : ContractVerdict<R>;

/** The checked twin of a function `F`: the same parameters, a {@link ContractVerdict} in place of the return. */
export type CheckedFn<F extends AnyFn> = (...args: Parameters<F>) => CheckedResult<ReturnType<F>>;

/** The callable `contract` value: the enforcing wrapper, plus `.checked` — its verdict-returning twin. */
export interface ContractFn {
    <F extends AnyFn>(spec: ContractSpec, fn: F): F;
    /**
     * The non-throwing twin of {@link contract} (axiform feedback 2026-10-18 §1): wraps `fn` so each call
     * returns a {@link ContractVerdict} — the structured per-call outcome as DATA — instead of throwing. No
     * global state: it never routes through `setViolationPolicy` and never emits to the observation sink, so
     * it is safe for async and concurrent callers (the gaps the sink-swap workaround had). `{evaluate: 'all'}`
     * reports every failure in the evaluated bands via `failures`, rather than only the first.
     */
    readonly checked: <F extends AnyFn>(
        spec: ContractSpec,
        fn: F,
        options?: {readonly evaluate?: 'first' | 'all'},
    ) => CheckedFn<F>;
}

function checked<F extends AnyFn>(
    spec: ContractSpec,
    fn: F,
    options?: {readonly evaluate?: 'first' | 'all'},
): CheckedFn<F> {
    const pres = (spec.requires || []).map(toPrecondition);
    const posts = (spec.ensures || []).map(toPostcondition);
    const evaluate: 'first' | 'all' = options && options.evaluate === 'all' ? 'all' : 'first';
    const run = function (this: unknown, ...args: any[]): ContractVerdict | Promise<ContractVerdict> {
        return evaluateToVerdict(fn, spec, pres, posts, this, args, evaluate);
    };
    // Carry the wrapped function's identity, exactly as the enforcing wrapper does (voice-agent L19/L22).
    Object.defineProperty(run, 'name', {value: fn.name, configurable: true});
    Object.defineProperty(run, 'length', {value: fn.length, configurable: true});
    return run as CheckedFn<F>;
}

/**
 * `contract(spec, fn)` ENFORCES a contract on a plain function — throwing (or routing through
 * `setViolationPolicy`) on a violation, and emitting to the observation sink when `observe` is set.
 * `contract.checked(spec, fn)` is its non-throwing twin (axiform §1): it returns a {@link ContractVerdict} —
 * the per-call outcome as data — with no global state. Both run the SAME bands through the SAME oracles, and
 * construct any failure through the SAME builders, so a verdict and a thrown/emitted violation cannot disagree.
 */
export const contract: ContractFn = Object.assign(contractImpl, {checked});
