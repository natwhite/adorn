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
    markInstalled,
    MethodKey,
    registerContractedClass,
} from './ContractRegistry';
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
        if (!enforce) {
            // Nothing recorded. Returning the descriptor untouched keeps `@Validate()` harmless on
            // a method that has no parameter constraints (yet).
            return descriptor;
        }

        const decorate = CreateMethodDecorator(enforcementBehavior(enforce, target, propertyKey, trust));
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
 */
function installOn(host: object, trust: ContractTrust): void {
    const keys = new Set<MethodKey>();
    getContracts(host).forEach((_contract, key) => keys.add(key));
    getStagedMethodKeys(host).forEach(key => keys.add(key));
    if (keys.size === 0) return;

    keys.forEach(key => installMethod(host, key, trust));
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
    if (!enforce) return;

    installMethodWrapper(host, key, enforcementBehavior(enforce, host, key, trust));
    noteInstalled(host, key);
}

/**
 * Validation as a `MethodBehavior`: gate, check, route, proceed.
 *
 * **The gate is evaluated once per call, at the top** — not once per predicate (plan P3.2). A method
 * carrying eight constraints pays for one `shouldEnforce`, not eight, and a stripped `assert`
 * contract costs a single boolean test rather than the whole check list.
 *
 * The {@link ViolationSite} is built here, at install time, because it is fixed for the life of the
 * wrapper — resolving the class and method names per call would put string work on the hot path for
 * something that only matters when a violation actually fires.
 *
 * `proceed()` stays outside the `try` — a failure thrown by the method itself is not adorn's, must
 * not be routed through the violation policy, and must not have its stack rewritten. Only the checks
 * are guarded.
 */
function enforcementBehavior(
    enforce: (context: InvocationContext) => void,
    host: object,
    key: MethodKey,
    trust: ContractTrust,
): MethodBehavior {
    const site: ViolationSite = {
        owner: ownerNameOf(host),
        member: typeof key === 'symbol' ? key.toString() : String(key),
        trust,
    };

    return function (context, proceed) {
        if (!shouldEnforce(trust)) return proceed();

        try {
            enforce(context);
        } catch (violation) {
            // Rethrows unless the configured policy suppresses it ('warn', or a custom handler that
            // returns). Suppression falls through to `proceed()` deliberately: 'warn' exists to
            // stage a new contract over live traffic, which means the call must still happen.
            applyViolationPolicy(violation, site);
        }

        return proceed();
    };
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
