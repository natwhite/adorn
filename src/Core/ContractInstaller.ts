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
 * it installs, it is the marker that lets `getContractedClasses()` exist at all (a `WeakMap` cannot
 * be enumerated — DEC-011), and it is the same class-scoped topology a standard-decorator adapter
 * will need (DEC-003). One annotation, three responsibilities that would otherwise need three.
 *
 * ## The cost, stated plainly
 *
 * This is a **breaking change**: `@StringMinLength(10)` alone no longer takes effect. Forgetting
 * `@Contract()` silently disables every contract on the class. The mandatory countermeasure lives
 * in `ContractDiagnostics` and is not optional — see the note there.
 */

import {
    getContract,
    getContracts,
    markInstalled,
    MethodKey,
    registerContractedClass,
} from './ContractRegistry';
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
export function Contract(): ClassDecorator {
    return function (constructor: Function) {
        installContracts(constructor);
        return constructor as any;
    } as ClassDecorator;
}

/**
 * The imperative form of {@link Contract}, for classes built without decorator syntax and for
 * tests. Same effect, no decorator involved.
 */
export function installContracts(constructor: Function): void {
    if (typeof constructor !== 'function') {
        throw new TypeError('@Contract() must be applied to a class');
    }

    registerContractedClass(constructor);

    // Statics are recorded against the constructor itself, instance methods against the prototype.
    installOn(constructor);
    if (constructor.prototype) installOn(constructor.prototype);
}

/**
 * Per-method opt-in (plan P1.3, option A2).
 *
 * Installs the contracts for exactly the method it is written on. Useful when a class should not be
 * wholesale-annotated, and it is the shape that composes with other method decorators.
 *
 * **It is not a substitute for `@Contract()`** for anything beyond enforcement: a class carrying
 * only `@Validate()` is enforced but never enters the enumerable registry, so it stays invisible to
 * documentation and fuzzing (DEC-011). Reach for it when that is what you want, not by default.
 */
export function Validate(): MethodDecorator {
    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        const original = descriptor && descriptor.value;
        if (typeof original !== 'function') {
            throw new TypeError(
                `@Validate() must be applied to a method; ${String(propertyKey)} is not one.`,
            );
        }

        if (isInstalled(target, propertyKey)) return descriptor;

        const enforce = buildParameterEnforcement(target, propertyKey, original);
        if (!enforce) {
            // Nothing recorded. Returning the descriptor untouched keeps `@Validate()` harmless on
            // a method that has no parameter constraints (yet).
            return descriptor;
        }

        const decorate = CreateMethodDecorator(enforcementBehavior(enforce));
        const result = decorate(target, propertyKey, descriptor as any) || descriptor;

        noteInstalled(target, propertyKey);
        return result as any;
    } as MethodDecorator;
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
function installOn(host: object): void {
    const keys = new Set<MethodKey>();
    getContracts(host).forEach((_contract, key) => keys.add(key));
    getStagedMethodKeys(host).forEach(key => keys.add(key));
    if (keys.size === 0) return;

    keys.forEach(key => installMethod(host, key));
}

function installMethod(host: object, key: MethodKey): void {
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

    installMethodWrapper(host, key, enforcementBehavior(enforce));
    noteInstalled(host, key);
}

/**
 * Validation as a `MethodBehavior`: check, then proceed.
 *
 * `proceed()` is deliberately outside any `try`/`catch` — a failure thrown by the method itself is
 * not adorn's, and its stack must not be rewritten. Only the checks are guarded, inside
 * `buildParameterEnforcement`.
 */
function enforcementBehavior(enforce: (context: InvocationContext) => void): MethodBehavior {
    return function (context, proceed) {
        enforce(context);
        return proceed();
    };
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
