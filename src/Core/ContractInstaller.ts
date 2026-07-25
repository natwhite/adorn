/**
 * P1.3 — registry-driven installation.
 *
 * ## The one annotation that replaces the monkey-patch
 *
 * ```ts
 * @Contract()
 * class Task {
 *     test(@StringMinLength(10) message: string) { ... }
 * }
 * ```
 *
 * TypeScript emits member decorators before class decorators:
 *
 * ```js
 * __decorate([__param(0, StringMinLength(10))], Task.prototype, "test", null);
 * Task = __decorate([Contract()], Task);
 * ```
 *
 * By the time `Contract()` runs, two things are true and both matter:
 *
 * 1. **Every constraint on the class has been recorded.** Class decorators run last, so unlike a
 *    parameter decorator, an installer here sees complete metadata — for every method at once,
 *    which is what makes one annotation per class sufficient.
 * 2. **`__decorate`'s trailing `Object.defineProperty(target, key, r)` has already happened.** The
 *    write that used to clobber the wrapper is behind us, so installing with a plain
 *    `defineProperty` is safe and `OverrideObjectDefineProperty` has nothing left to protect
 *    (DEC-005 → P1.4).
 *
 * That second point is the entire justification for the sequencing. Removing the patch first would
 * have broken parameter decorators outright.
 *
 * ## Why class-level and not per-method (plan P1.3, option A1)
 *
 * A per-method `@Validate()` would work equally well mechanically, and is offered below for
 * fine-grained control. `@Contract()` is the recommended form because it does three jobs at once:
 * it installs, it is a marker that lets `getContractedClasses()` exist at all (a `WeakMap` cannot
 * be enumerated — DEC-011), and it is the same class-scoped topology a standard-decorator adapter
 * will need (DEC-003). One annotation, three responsibilities that would otherwise need three.
 *
 * The two differ in **scope, not visibility** — `@Validate()` enumerates its class as well (Q-12,
 * settled at its definition below).
 *
 * ## The cost, stated plainly
 *
 * This is a **breaking change**: `@StringMinLength(10)` alone no longer takes effect. Forgetting
 * `@Contract()` silently disables every contract on the class. The mandatory countermeasure lives
 * in `ContractDiagnostics` and is not optional — see the note there.
 *
 * ## Trust (P3.2 / DEC-008)
 *
 * Both annotations accept `{trust}`, classifying what they install as a `guard` (validates untrusted
 * input; survives production) or an `assert` (internal self-check; stripped in production). It
 * defaults to `guard`, and the gate is evaluated once per call at the top of the wrapper — see
 * {@link enforcementBehavior} and the header of `Configuration.ts` for why a single global boolean
 * was rejected.
 */

import {
    getContract,
    getContracts,
    getEffectiveContractKeys,
    getEffectivePostconditionKeys,
    getEffectivePostconditions,
    getEffectiveReturnConstraints,
    getPostconditionKeys,
    markInstalled,
    MethodKey,
    Postcondition,
    registerContractedClass,
} from './ContractRegistry';
import {ConstraintDescriptor} from './Descriptor';
import {shouldDiscloseValue} from './redaction';
import {evaluatePostconditions, postconditionMessage} from './Postconditions';
import {
    applyViolationPolicy,
    ContractTrust,
    resolveTrust,
    shouldEnforce,
    TrustOptions,
    ViolationSite,
} from './Configuration';
import {
    buildParameterEnforcement,
    getEffectiveStagedMethodKeys,
    getStagedMethodKeys,
    markStagedInstalled,
} from './ParameterDecoratorFactory';
import {
    CreateMethodDecorator,
    findMethod,
    InvocationContext,
    installMethodWrapper,
    MethodBehavior,
} from './MethodDecoratorFactory';
import {noteContractInstalled} from './ContractDiagnostics';
import {
    ErrorFacts,
    getObservationSink,
    NOOP_SINK,
    Observation,
    ObservationEvent,
    ObservationSink,
    ownsCompletion,
    RETURN_INDEX,
    ViolationFacts,
} from './Observation';
import {ViolationError} from './ViolationError';

/**
 * Class decorator that installs every contract recorded against the class, and registers it for
 * projection enumeration.
 *
 * Covers instance methods (recorded against `Class.prototype`) and static methods (recorded against
 * the constructor). Methods with no recorded contracts are left completely untouched — decorating a
 * class costs nothing for its undecorated members.
 *
 * Idempotent: installing twice is a no-op for already-installed methods, so re-applying it or
 * decorating a subclass whose parent is already contracted does not double-wrap.
 */
export function Contract(options?: TrustOptions): ClassDecorator {
    return function (constructor: Function) {
        installContracts(constructor, options);
        return constructor as any;
    } as ClassDecorator;
}

/**
 * The imperative form of {@link Contract}, for classes built without decorator syntax and for
 * tests. Same effect, no decorator involved.
 *
 * `options.trust` classifies every contract on the class (P3.2 / DEC-008). It defaults to `guard`,
 * so contracts survive production unless an author deliberately says they are internal self-checks.
 */
export function installContracts(constructor: Function, options?: TrustOptions): void {
    if (typeof constructor !== 'function') {
        throw new TypeError('@Contract() must be applied to a class');
    }

    const trust = resolveTrust(options);

    registerContractedClass(constructor);

    // Statics are recorded against the constructor itself, instance methods against the prototype.
    installOn(constructor, trust);
    if (constructor.prototype) installOn(constructor.prototype, trust);
}

/**
 * Per-method opt-in (plan P1.3, option A2).
 *
 * Installs the contracts for exactly the method it is written on. Useful when a class should not be
 * wholesale-annotated, and it is the shape that composes with other method decorators.
 *
 * ## It registers its class for enumeration (Q-12, settled)
 *
 * It did not, originally: `@Contract()` was the sole enumeration marker, so `getContractedClasses()`
 * meant *"deliberately published"* and a class carrying only `@Validate()` was enforced yet absent
 * from documentation and fuzzing. That was defensible — but it made adorn enforce a guarantee it
 * would not admit to, and *silently missing from a generated artifact* is the failure the plan
 * singles out as worse than being unenforced, because nothing ever throws to reveal it (plan §8).
 * Anything adorn enforces must be describable.
 *
 * So **installation implies enumeration**, and `getContractedClasses()` now means "classes adorn has
 * installed enforcement on". The two annotations differ in *scope*, not in visibility: `@Contract()`
 * covers a class, `@Validate()` covers one method. A sibling method that `@Validate()` does not cover
 * still appears in the artifact — correctly flagged `installed: false`, which is a far more useful
 * document than one silently omitting the whole class.
 *
 * Suppressing a class from a generated artifact is a projection-level concern; an enforcement
 * decorator is the wrong lever for it.
 */
export function Validate(options?: TrustOptions): MethodDecorator {
    const trust = resolveTrust(options);

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        const original = descriptor && descriptor.value;
        if (typeof original !== 'function') {
            throw new TypeError(
                `@Validate() must be applied to a method; ${String(propertyKey)} is not one.`,
            );
        }

        // Q-12: registered whether or not anything is installed below, matching `@Contract()`,
        // which enumerates a constraint-free class too. Enumeration marks intent to be visible; a
        // method whose constraints have not been written yet should not make its class vanish.
        registerOwningClass(target);

        if (isInstalled(target, propertyKey)) return descriptor;

        const enforce = buildParameterEnforcement(target, propertyKey, original);
        // Both postcondition bands are read effectively (inheritance-aware): the `@Ensures` closure
        // band AND the reified `@Returns` descriptor band (DEC-033). Note the ordering caveat: because
        // `@Validate()` runs at member-decoration time, it only sees clauses that recorded first —
        // i.e. `@Ensures`/`@Returns` must sit *below* `@Validate()` in source. Class-level `@Contract()`
        // runs last and has no such caveat (see the `@Ensures`/`@Returns` docs).
        const posts = getEffectivePostconditions(target, propertyKey);
        const returns = getEffectiveReturnConstraints(target, propertyKey);
        if (!enforce && posts.length === 0 && returns.length === 0) {
            // Nothing recorded. Returning the descriptor untouched keeps `@Validate()` harmless on
            // a method that has neither parameter constraints nor postconditions (yet).
            return descriptor;
        }

        // If an INNER `@Observe` already owns the `{kind:'completed'}` emit, enforcement must not emit a
        // second one (plan §5). Detected here off the method being wrapped — zero per-call cost.
        const observed = ownsCompletion(original);
        const decorate = CreateMethodDecorator(
            enforcementBehavior(enforce, posts, returns, target, propertyKey, trust, observed),
        );
        const result = decorate(target, propertyKey, descriptor as any) || descriptor;

        noteInstalled(target, propertyKey);
        return result as any;
    } as MethodDecorator;
}

/**
 * Register the class owning a decorated member.
 *
 * A method decorator is handed the prototype for an instance method and the constructor itself for a
 * static — the same two key bands `getContractsForClass` exists to reconcile (Q-9). Enumeration keys
 * on the constructor in both cases.
 */
function registerOwningClass(target: object): void {
    const constructor =
        typeof target === 'function'
            ? (target as Function)
            : target && (target as {constructor?: Function}).constructor;

    if (typeof constructor === 'function') registerContractedClass(constructor);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Install on one host object — a constructor (statics) or a prototype (instance methods).
 *
 * The set of methods to install is the union of two sources: the `ContractRegistry`, which holds
 * reified `ConstraintDescriptor`s, and the adapter's staging table, which holds hand-written
 * `CreateSimpleDecorator` closures the registry cannot represent. Both must be installed or the
 * legacy authoring form would silently stop working.
 *
 * ## Overrides that declare nothing (DEC-022, Q-15)
 *
 * Own-scoped enumeration is precisely how an override used to escape enforcement. A subclass that
 * overrides a contracted method **without decorating it** has no own entry in either source, so no
 * key was collected, nothing was installed, and the override — which shadows the base's wrapper —
 * ran unchecked. Overriding a contracted method was a silent way to delete its contract.
 *
 * So the chain is consulted as well, and a key found only on an ancestor is installed **when this
 * host owns the method**. That own-ness test is doing real work in both directions:
 *
 * - **Owned (an override).** The base's wrapper is shadowed and unreachable, so a wrapper must be
 *   installed here or the inherited constraints are lost. `planChecks` resolves them effectively,
 *   so this class is checked against its ancestors' constraints plus any of its own.
 * - **Not owned (plain inheritance).** The base's own wrapper is still what a call reaches through
 *   the prototype chain, so it is already enforced. Installing anyway would double-check every
 *   inherited constraint and — worse — conjure an own property onto a prototype that had none,
 *   changing `Object.getOwnPropertyNames` and re-attributing violation messages from the declaring
 *   class to the inheriting one. Enforcing an inherited implementation is the declaring class's job.
 *
 * A key that is owned but is not a plain method (an accessor, or a value that is not a function) is
 * skipped rather than throwing: the recorded constraint belongs to an ancestor, so the
 * "no such method" diagnostic below would blame a declaration the author of *this* class never
 * wrote. Own keys keep the existing throw, because there the blame is correct.
 */
function installOn(host: object, trust: ContractTrust): void {
    const own = new Set<MethodKey>();
    getContracts(host).forEach((_contract, key) => own.add(key));
    getStagedMethodKeys(host).forEach(key => own.add(key));
    getPostconditionKeys(host).forEach(key => own.add(key));

    const keys = new Set<MethodKey>(own);

    const inherited = new Set<MethodKey>();
    getEffectiveContractKeys(host).forEach(key => inherited.add(key));
    getEffectiveStagedMethodKeys(host).forEach(key => inherited.add(key));
    getEffectivePostconditionKeys(host).forEach(key => inherited.add(key));

    inherited.forEach(key => {
        if (own.has(key)) return;
        if (!overridesMethod(host, key)) return;
        keys.add(key);
    });

    if (keys.size === 0) return;

    keys.forEach(key => installMethod(host, key, trust));
}

/** Whether `host` itself declares `key` as a plain method, shadowing anything inherited. */
function overridesMethod(host: object, key: MethodKey): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(host, key);
    return !!descriptor && typeof descriptor.value === 'function';
}

function installMethod(host: object, key: MethodKey, trust: ContractTrust): void {
    if (isInstalled(host, key)) return;

    const original = findMethod(host, key);
    if (!original) {
        throw new TypeError(
            `adorn: @Contract() found constraints recorded for '${String(key)}' but no such method ` +
                'exists on the class. If this is an arrow-function class property it is an instance ' +
                'field and cannot be contracted (plan P1.6 / Tier 2).',
        );
    }

    const enforce = buildParameterEnforcement(host, key, original);
    const posts = getEffectivePostconditions(host, key);
    const returns = getEffectiveReturnConstraints(host, key);
    if (!enforce && posts.length === 0 && returns.length === 0) return;

    // An inner `@Observe` (applied before the class decorator ran) already owns the completed emit;
    // enforcement then defers its own so the sink sees `completed` once (plan §5). Zero per-call cost.
    const observed = ownsCompletion(original);
    installMethodWrapper(host, key, enforcementBehavior(enforce, posts, returns, host, key, trust, observed));
    noteInstalled(host, key);
}

/**
 * The trust postconditions run under (plan A §5.2, adopted).
 *
 * A postcondition audits the method's **own output** against its **own promise** — the definitional
 * internal self-check, blaming the callee — so it defaults to `assert`: stripped in production, like a
 * C `assert`. That is the mirror of a precondition, which guards *untrusted input*, blames the caller,
 * and defaults to `guard` (survives production). The two directions of blame set the two trust
 * defaults, and both reuse the one `shouldEnforce` gate — no new machinery.
 *
 * Per-postcondition trust (plan A's `@Ensures({trust})`, e.g. opting a paranoid invariant back up to
 * `guard`) is deferred; v1 fixes postconditions at `assert`.
 */
const POSTCONDITION_TRUST: ContractTrust = 'assert';

/**
 * The combined enforcement `MethodBehavior`: gate → check preconditions → `proceed()` → check
 * postconditions. Any part may be absent — a method may carry only parameter constraints, only
 * postconditions (of either band), or any mix.
 *
 * **Two postcondition bands run after `proceed()` (DEC-033):** the reified `@Returns` descriptor band
 * (`returns`) and the `@Ensures` closure band (`posts`). Both are checked against the *same* settled
 * value, under the *same* single {@link POSTCONDITION_TRUST} gate and the *same* callee-blamed
 * {@link ViolationSite} — no new trust machinery. **Cross-band ordering is pinned reified-first:** the
 * descriptor band is checked before the closure band, so when a call breaks both the more precise,
 * projectable, groupable guarantee is the one reported first (first-failure-wins across the two bands).
 *
 * **Each gate is evaluated once per call, not once per predicate** (plan P3.2). Preconditions run
 * under the method/class `trust`; postconditions run under {@link POSTCONDITION_TRUST}. They are
 * separate gates so that in production a default class keeps its `guard` preconditions while stripping
 * its `assert` postconditions — which is the whole point of the blame-sets-trust default.
 *
 * The two {@link ViolationSite}s are built here, at install time, because they are fixed for the life
 * of the wrapper; per-call name resolution would put string work on the hot path for something that
 * only matters when a violation fires. They differ only in `trust` and `blame`.
 *
 * `proceed()` stays **outside** every `try` — a failure thrown by the method itself is not adorn's,
 * must not be routed through the violation policy, and must not have its stack rewritten. A throw
 * therefore skips both postcondition bands entirely (there is no return value to check) and propagates
 * untouched; only the checks are guarded (plan §5).
 *
 * ## Observation emission is strictly additive (O1b, DEC-035/DEC-036)
 *
 * When — and only when — an {@link ObservationSink} is installed, this weave *also* emits structured
 * telemetry around the unchanged check flow: a value-free `{kind:'violation'}` event for a
 * precondition **and** both postcondition bands, and a `{kind:'completed'}` event when the call
 * settles. The emission is a non-authoritative **side-channel**: it fires *before and independent of*
 * `applyViolationPolicy` (a sink is not a `ViolationHandler` — it cannot influence control flow), fires
 * under `'warn'` and a suppressing handler alike, and a sink that throws is contained so it can never
 * become the method's failure. The uninstalled path is one `===` compare and byte-for-byte identical to
 * the pre-O1b flow — no `Observation` built, no allocation, no behaviour change. "Seeing ≠ emitting":
 * the reified `@Returns` band carries full {@link ViolationFacts} from its descriptor while an
 * `@Ensures` closure degrades to a low-fidelity `_OTHER` fact, and the emitted `error.message` is the
 * already-redacted-by-default violation message (DEC-030), never a raw value.
 */
function enforcementBehavior(
    enforce: ((context: InvocationContext) => void) | undefined,
    posts: ReadonlyArray<Postcondition>,
    returns: ReadonlyArray<ConstraintDescriptor>,
    host: object,
    key: MethodKey,
    trust: ContractTrust,
    observed: boolean = false,
): MethodBehavior {
    const owner = ownerNameOf(host);
    const member = typeof key === 'symbol' ? key.toString() : String(key);

    const callerSite: ViolationSite = {owner, member, trust, blame: 'caller'};
    const calleeSite: ViolationSite = {owner, member, trust: POSTCONDITION_TRUST, blame: 'callee'};

    // Built once at install time, like the sites: the structural facts of this method, fixed for the
    // life of the wrapper. `parameters` stays empty in O1b — the per-parameter disclosure resolver is
    // O1c; the violation event carries the offending parameter's facts directly on `ViolationFacts`.
    const siteObservation: Observation = {
        owner,
        member,
        name: `${owner}.${member}`,
        isStatic: typeof host === 'function',
        detail: 'always',
        kind: 'internal',
        parameters: [],
    };
    // Frozen so an event handed to a sink cannot mutate the shared, per-install facts.
    Object.freeze(siteObservation.parameters);
    Object.freeze(siteObservation);

    // Either postcondition band makes the after-call stage live.
    const hasPostChecks = posts.length > 0 || returns.length > 0;

    return function (context, proceed) {
        // The one branch the uninstalled path pays — a single reference compare (plan §4a).
        const sink = getObservationSink();
        const observing = sink !== NOOP_SINK;
        // Emitter for a postcondition-band violation, or `undefined` when unobserved so the check
        // functions run byte-for-byte as before. Allocated only when a sink is installed. Violations
        // always emit while observing — they are never suppressed by the completed-emit reconciliation.
        const observeViolation = observing
            ? (facts: ViolationFacts, error: unknown) => emitViolation(sink, siteObservation, facts, error)
            : undefined;
        // Whether THIS wrapper owns the `{kind:'completed'}` emit. Suppressed when an inner `@Observe`
        // already owns it (plan §5) — the sole thing `observed` changes; checks and violations are
        // untouched, so contract semantics and the Fuzzing-Phase-B no-drift behaviour are preserved.
        const observeCompletions = observing && !observed;

        // --- preconditions ---------------------------------------------------
        if (enforce && shouldEnforce(trust)) {
            try {
                enforce(context);
            } catch (violation) {
                // Side-channel: emitted before, and independent of, the policy. A reified precondition
                // throws a ViolationError carrying facts; a hand-written closure (SMELL-14) is invisible
                // here and emits nothing, exactly as it is invisible to every projection.
                if (observing && violation instanceof ViolationError) {
                    emitViolation(
                        sink,
                        siteObservation,
                        {...violation.facts, trust, blame: 'caller'},
                        violation,
                    );
                }
                // Rethrows unless the configured policy suppresses it ('warn', or a handler that
                // returns). Suppression falls through deliberately: 'warn' stages a contract over
                // live traffic, so the call must still happen.
                applyViolationPolicy(violation, callerSite);
            }
        }

        // Nothing to check after the call, or postconditions are stripped in this build.
        if (!hasPostChecks || !shouldEnforce(POSTCONDITION_TRUST)) {
            if (!observeCompletions) return proceed();
            // proceed() stays outside every try; the completion is observed without altering the
            // returned value (a sync throw propagates untouched and is not a completed event here).
            const started = now();
            const result = proceed();
            return observeCompletion(sink, siteObservation, started, result);
        }

        const started = observeCompletions ? now() : 0;
        // Outside the try — see the header. A method throw skips postconditions and propagates.
        const result = proceed();

        if (isThenable(result)) {
            // Await the settled value, then check — mirroring `@Time`'s thenable handling. A REJECTED
            // promise is not caught here, so it skips both bands and propagates (the async twin of the
            // sync-throw rule); an async violation surfaces as a rejected Promise carrying the
            // postcondition Error, which is the correct shape.
            const checked = Promise.resolve(result).then(value => {
                // Reified band first (DEC-033), then the closure band — see the header.
                checkReturnConstraints(returns, value, calleeSite, observeViolation);
                checkPostconditions(posts, value, context.args, calleeSite, observeViolation);
                return value;
            });
            // Observe the settled outcome of the checked promise without changing what is returned.
            if (observeCompletions) observeSettledPromise(sink, siteObservation, started, checked);
            return checked;
        }

        // Observables and other non-thenable objects are checked as the raw value (rxjs is gone —
        // DEC-019; real settling is deferred, plan §5).
        checkReturnConstraints(returns, result, calleeSite, observeViolation);
        checkPostconditions(posts, result, context.args, calleeSite, observeViolation);
        if (observeCompletions) emitCompleted(sink, siteObservation, now() - started, 'returned', true);
        return result;
    };
}

/**
 * Evaluate the reified `@Returns` descriptor band against one settled outcome (DEC-033) and route the
 * first failure through the same violation policy preconditions and the closure band use. Returns
 * normally when they hold OR when the policy suppresses (`'warn'`/handler), so the method's value is
 * still returned to the caller.
 *
 * Each descriptor is checked with its **own** `predicate` (DEC-010 — the same predicate parameter
 * enforcement runs and the fuzzer will call; never re-derived here), and its **own** `message` renders
 * the violation. A return carries no `@Sensitive` marking (Q-23), so disclosure follows the global
 * switch alone — `shouldDiscloseValue(false)` — and the value redacts by default (DEC-030), exactly as
 * `postconditionMessage` does for the closure band. First-failure-wins, mirroring
 * {@link evaluatePostconditions}.
 */
function checkReturnConstraints(
    returns: ReadonlyArray<ConstraintDescriptor>,
    result: unknown,
    site: ViolationSite,
    observe?: (facts: ViolationFacts, error: unknown) => void,
): void {
    for (const descriptor of returns) {
        if (descriptor.predicate(result)) continue;

        const message = descriptor.message({
            value: result,
            paramName: 'return value',
            disclose: shouldDiscloseValue(false),
        });
        const error = new Error(message);
        // Full-fidelity facts: a `@Returns` is a reified descriptor (DEC-033), so the violation is as
        // groupable as a precondition's — the O1b payoff. Emitted before the policy, as a side-channel.
        if (observe) {
            observe(
                {
                    constraint: descriptor.constraint,
                    kind: descriptor.kind,
                    params: descriptor.params,
                    expectation: descriptor.describe(),
                    parameterName: 'return value',
                    parameterIndex: RETURN_INDEX,
                    trust: site.trust,
                    blame: site.blame,
                },
                error,
            );
        }
        applyViolationPolicy(error, site);
        return; // first-failure-wins, base-most first (getEffectiveContract().post orders it so)
    }
}

/**
 * Evaluate the postconditions against one settled outcome and route a failure through the same
 * violation policy preconditions use. Returns normally when they hold OR when the policy suppresses
 * (`'warn'`/handler), so the method's value is still returned to the caller.
 *
 * This calls the exact {@link evaluatePostconditions} the fuzz driver will call — one oracle, checked
 * and enforced through the same function (plan §8).
 */
function checkPostconditions(
    posts: ReadonlyArray<Postcondition>,
    result: unknown,
    args: ReadonlyArray<unknown>,
    site: ViolationSite,
    observe?: (facts: ViolationFacts, error: unknown) => void,
): void {
    const outcome = evaluatePostconditions(posts, result, args);
    if (outcome.ok || !outcome.failed) return;

    const message = postconditionMessage(site.owner, site.member, outcome.failed, result);
    const error = new Error(message);
    // Low-fidelity by nature: an `@Ensures` closure carries no identity or serialisable params (Q-3,
    // SMELL-14), so it degrades to the `_OTHER` semconv fallback — no `constraint` dimension. Stated,
    // not hidden. `error.type` becomes `_OTHER` from the sentinel constraint below.
    if (observe) {
        observe(
            {
                constraint: OTHER_CONSTRAINT,
                kind: 'generic',
                params: {},
                expectation: outcome.failed.description || '',
                parameterIndex: RETURN_INDEX,
                trust: site.trust,
                blame: site.blame,
            },
            error,
        );
    }
    applyViolationPolicy(error, site);
}

// ---------------------------------------------------------------------------
// Observation emission (O1b) — strictly additive, side-channel only
// ---------------------------------------------------------------------------

/** The OpenTelemetry semconv fallback for an error/constraint with no reified identity. */
const OTHER_CONSTRAINT = '_OTHER';

/**
 * Hand one event to the sink's `record`, guarded. A telemetry sink that throws must never become the
 * method's failure (plan §6): the throw is swallowed here, and `record` being absent is a no-op.
 */
function recordObservation(sink: ObservationSink, event: ObservationEvent): void {
    try {
        if (sink.record) sink.record(event);
    } catch {
        // Contained: enforcement is authoritative, observation is not.
    }
}

/** Emit one value-free `{kind:'violation'}` event, deriving `error.type` from the constraint identity. */
function emitViolation(
    sink: ObservationSink,
    observation: Observation,
    facts: ViolationFacts,
    error: unknown,
): void {
    recordObservation(sink, {
        kind: 'violation',
        observation,
        violation: facts,
        error: violationErrorFacts(error, facts.constraint),
    });
}

/**
 * Emit a `{kind:'completed'}` event. `error` is present iff the call settled by throwing — the around
 * seam sees the raw outcome (as `@Time` does), and the structured `ErrorFacts` is what an adapter needs
 * to `recordException`.
 */
function emitCompleted(
    sink: ObservationSink,
    observation: Observation,
    durationMs: number,
    outcome: 'returned' | 'threw',
    settled: boolean,
    error?: unknown,
): void {
    recordObservation(
        sink,
        outcome === 'threw'
            ? {kind: 'completed', observation, durationMs, outcome, settled, error: toErrorFacts(error)}
            : {kind: 'completed', observation, durationMs, outcome, settled},
    );
}

/**
 * Observe a completion on the no-postcondition path without altering the returned value. A thenable is
 * observed through a passive `.then` on a `Promise.resolve` clone — the original value is returned to
 * the caller unchanged, so async/return identity is preserved exactly. Non-thenables (including
 * Observables, which enforcement treats as raw values) settle as a synchronous `'returned'`.
 */
function observeCompletion(
    sink: ObservationSink,
    observation: Observation,
    started: number,
    result: any,
): any {
    if (isThenable(result)) {
        Promise.resolve(result).then(
            () => emitCompleted(sink, observation, now() - started, 'returned', true),
            (error: unknown) => emitCompleted(sink, observation, now() - started, 'threw', true, error),
        );
        return result;
    }
    emitCompleted(sink, observation, now() - started, 'returned', true);
    return result;
}

/**
 * Observe the settled outcome of the already-checked promise on the postcondition path, without
 * changing what is returned. A postcondition throw makes `checked` reject, so it is reported as a
 * `'threw'` completion; the violation event itself was already emitted inside the check functions.
 */
function observeSettledPromise(
    sink: ObservationSink,
    observation: Observation,
    started: number,
    checked: Promise<unknown>,
): void {
    checked.then(
        () => emitCompleted(sink, observation, now() - started, 'returned', true),
        (error: unknown) => emitCompleted(sink, observation, now() - started, 'threw', true, error),
    );
}

/** Structured facts for a *violation* error: `adorn.<constraint>`, or `_OTHER` for a degraded closure. */
function violationErrorFacts(error: unknown, constraint: string): ErrorFacts {
    const type =
        constraint && constraint !== OTHER_CONSTRAINT ? `adorn.${constraint}` : OTHER_CONSTRAINT;
    return {type, message: errorMessage(error), stack: errorStack(error)};
}

/** Structured facts for an arbitrary thrown value: its `name`, or `_OTHER` when it has none. */
function toErrorFacts(error: unknown): ErrorFacts {
    if (error && typeof error === 'object') {
        const named = (error as {name?: unknown}).name;
        const type = typeof named === 'string' && named ? named : OTHER_CONSTRAINT;
        return {type, message: errorMessage(error), stack: errorStack(error)};
    }
    return {type: OTHER_CONSTRAINT, message: String(error)};
}

function errorMessage(error: unknown): string | undefined {
    const message = error && (error as {message?: unknown}).message;
    return typeof message === 'string' ? message : undefined;
}

function errorStack(error: unknown): string | undefined {
    const stack = error && (error as {stack?: unknown}).stack;
    return typeof stack === 'string' ? stack : undefined;
}

/**
 * Highest-resolution monotonic clock available, for the `completed` event's `durationMs`. Matches the
 * clock `@Time`/`settle` read (`performance.now()` where available, `Date.now()` otherwise).
 */
function now(): number {
    const perf = typeof performance !== 'undefined' ? performance : undefined;
    if (perf && typeof perf.now === 'function') return perf.now();
    return Date.now();
}

/**
 * The same three-line duck-type `@Time` uses (`Time.ts`). A thenable is checked after it settles, not
 * as the Promise object — reading `result.id` off a Promise is "a number that looks like an answer".
 */
function isThenable(value: unknown): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as {then?: unknown}).then === 'function'
    );
}

function ownerNameOf(host: object): string {
    if (typeof host === 'function') return (host as Function).name || '<anonymous class>';
    const constructor = host && (host as {constructor?: Function}).constructor;
    return (constructor && constructor.name) || '<anonymous class>';
}

/**
 * Which `(host, key)` pairs already carry a wrapper.
 *
 * Kept here rather than inferred from `MethodContract.installed`, because a method contracted only
 * through `CreateSimpleDecorator` closures has no registry entry at all — and creating a phantom,
 * parameter-less entry just to hold a boolean would put a method into `getContracts()` that a
 * documentation projection would then render as "contracted, no constraints". The registry should
 * describe contracts it can actually represent.
 */
const installedByHost = new WeakMap<object, Set<MethodKey>>();

function isInstalled(host: object, key: MethodKey): boolean {
    const keys = installedByHost.get(host);
    return !!keys && keys.has(key);
}

function noteInstalled(host: object, key: MethodKey): void {
    let keys = installedByHost.get(host);
    if (!keys) {
        keys = new Set<MethodKey>();
        installedByHost.set(host, keys);
    }
    keys.add(key);

    // Only flip the registry's flag where the registry actually holds this method; see above.
    if (getContract(host, key)) markInstalled(host, key);

    markStagedInstalled(host, key);
    noteContractInstalled(host, key);
}
