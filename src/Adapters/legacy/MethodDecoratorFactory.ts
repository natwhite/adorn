/**
 * P1.2 — the method decorator factory: **the only sanctioned way a wrapper is installed**.
 *
 * ## Why this file is the whole point of DEC-005
 *
 * `tslib`'s `__decorate`, for a member carrying decorators, is emitted as a four-argument call
 * with `desc === null`:
 *
 * ```js
 * __decorate([__param(0, StringMinLength(10))], Task.prototype, "test", null);
 * ```
 *
 * and resolves that `null` to `Object.getOwnPropertyDescriptor(target, key)` **before** any
 * decorator runs, then unconditionally re-applies it:
 *
 * ```js
 * return c > 3 && r && Object.defineProperty(target, key, r), r;
 * ```
 *
 * A parameter decorator's return value is ignored, so `r` is still the *original* descriptor and
 * that trailing write restores the original method — discarding anything a parameter decorator
 * imperatively assigned to `target[key]`. The old `OverrideObjectDefineProperty` global patch
 * existed solely to swallow that one call.
 *
 * A **method** decorator does not have that problem, because `__decorate` honours what it returns:
 * `r = d(target, key, r) || r`. Return a descriptor and `__decorate` writes *that* back. Nothing
 * needs patching. Installation therefore has exactly two supported entry points, both here:
 *
 * - {@link CreateMethodDecorator} — for `@Something()` written directly on a method, where
 *   `__decorate` hands us a descriptor and takes our replacement.
 * - {@link installMethodWrapper} — for an installer running *after* all member decoration has
 *   finished (the `@Contract()` class decorator, P1.3). By then `__decorate`'s trailing write has
 *   already happened, so a direct `Object.defineProperty` is safe.
 *
 * Both routes build the wrapper through {@link wrapMethod}, so identity preservation and
 * `this`-handling exist in one place rather than three.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * This module knows about property descriptors and `MethodDecorator`, so it is adapter-side, not
 * core-agnostic. It deliberately knows **nothing** about constraints, the registry, or validation:
 * a behaviour is an opaque around-function. That is what lets `@Contract()` (P1.3), `@Validate()`
 * and later `@Time` (P3.4) all share one installation path without this file growing knowledge of
 * any of them.
 */

import {MethodKey} from '../../Core/ContractRegistry';

// ---------------------------------------------------------------------------
// Behaviour contract
// ---------------------------------------------------------------------------

/** Everything a behaviour can see about one invocation. */
export interface InvocationContext {
    /** The object the wrapper was installed on — a prototype, or a constructor for a static. */
    readonly target: object;
    readonly propertyKey: MethodKey;
    /** The function being wrapped. */
    readonly original: Function;
    /**
     * The installed wrapper itself.
     *
     * Exposed so a behaviour can use it as a stack boundary — `Error.captureStackTrace(e, wrapper)`
     * elides every frame up to and including it, which is how SMELL-2's hardcoded
     * `stack.split('\n').slice(3)` frame-counting is retired.
     */
    readonly wrapper: Function;
    /** The receiver. `undefined` for a detached call, exactly as for the undecorated method. */
    readonly thisArg: unknown;
    /** The actual arguments. Mutating this array *does* change what the method receives. */
    readonly args: any[];
}

/**
 * An **around** behaviour: it receives the invocation and a `proceed` thunk, and is responsible for
 * calling it (or not).
 *
 * One shape, deliberately, rather than a `before`/`after`/`onError` triple. Around subsumes all
 * three, and a lifecycle-hook object would be an abstraction invented before anything needed it
 * (plan risk 10). Parameter validation is `check(); return proceed();`; `@Time` (P3.4) will be
 * `const t = now(); try { return proceed(); } finally { report(now() - t); }`.
 *
 * Note this factory does **not** wrap `proceed()` in a `try`/`catch`. An exception thrown by the
 * *method itself* is the caller's business and must propagate with its stack untouched; only a
 * behaviour knows which failures are its own.
 */
export type MethodBehavior = (context: InvocationContext, proceed: () => any) => any;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a method decorator from a behaviour.
 *
 * The returned decorator **replaces `descriptor.value` and returns the descriptor**, which is the
 * contract `__decorate` honours. This is the mechanism the old design lacked and the reason it
 * needed a global monkey-patch.
 *
 * Evaluation order note: when a method carries both parameter decorators and a method decorator,
 * TypeScript emits them in one `__decorate` array and applies it back-to-front, with the `__param`
 * entries last in the array and therefore applied *first*. Any metadata parameter decorators
 * recorded is fully populated by the time the returned decorator runs.
 */
export function CreateMethodDecorator(behavior: MethodBehavior): MethodDecorator {
    assertBehavior(behavior, 'CreateMethodDecorator');

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(
                `adorn: a method decorator was applied to ${describeMember(target, propertyKey)}, which is ` +
                    'not a method. Arrow-function class properties are instance fields and carry no ' +
                    'prototype descriptor at decoration time; they are not supported as decoration ' +
                    'targets (plan P1.6 / Tier 2).',
            );
        }

        descriptor.value = wrapMethod(descriptor.value, target, propertyKey, behavior);
        return descriptor;
    } as MethodDecorator;
}

/**
 * Wrap `original` without installing it anywhere. Exposed so an installer can decide for itself
 * where the result goes (a descriptor it returns, or a `defineProperty` it performs).
 */
export function wrapMethod(
    original: Function,
    target: object,
    propertyKey: MethodKey,
    behavior: MethodBehavior,
): Function {
    if (typeof original !== 'function') {
        throw new TypeError(
            `adorn: cannot wrap ${describeMember(target, propertyKey)} — it is not a function`,
        );
    }
    assertBehavior(behavior, 'wrapMethod');

    // A `function` expression, never an arrow: the wrapper must receive the caller's `this` so a
    // prototype method still sees its instance. (Detaching the method loses `this`, but that is
    // equally true undecorated — not adorn's bug.)
    const wrapper = function (this: unknown) {
        // Copied out of `arguments` rather than declared as `...args` so that `wrapper.length` is
        // ours to choose rather than being forced to 0 by a rest parameter. Arity is still not
        // restored here — that is P1.6, deliberately left alone.
        const count = arguments.length;
        const args: any[] = new Array(count);
        for (let i = 0; i < count; i++) args[i] = arguments[i];

        const context: InvocationContext = {
            target,
            propertyKey,
            original,
            wrapper,
            thisArg: this,
            args,
        };

        return behavior(context, function () {
            return original.apply(context.thisArg, context.args);
        });
    };

    adoptIdentity(wrapper, original);
    return wrapper;
}

/**
 * Install a wrapper over `target[propertyKey]` by direct `Object.defineProperty`.
 *
 * **Only safe after member decoration has completed** — which is exactly when a class decorator
 * runs, and is why P1.3's installer is class-level (plan §8, DEC-003). Calling this *during* a
 * member `__decorate` would be clobbered by that call's trailing write, which is the failure the
 * monkey-patch used to mask.
 *
 * Looks the method up along the prototype chain but always installs an **own** property on
 * `target`, so a subclass installing over an inherited method shadows the parent rather than
 * mutating it.
 *
 * @returns the installed wrapper.
 */
export function installMethodWrapper(
    target: object,
    propertyKey: MethodKey,
    behavior: MethodBehavior,
): Function {
    const found = findMethodDescriptor(target, propertyKey);
    if (!found) {
        throw new TypeError(
            `adorn: cannot install a contract on ${describeMember(target, propertyKey)} — no such method ` +
                'was found on the prototype chain. If this is an arrow-function class property ' +
                '(`foo = (x) => ...`) it is an instance field, absent from the prototype when the class ' +
                'decorator runs, and is not supported as a decoration target (plan P1.6 / Tier 2).',
        );
    }

    const own = Object.getOwnPropertyDescriptor(target, propertyKey);
    if (own && own.configurable === false) {
        throw new TypeError(
            `adorn: cannot install a contract on ${describeMember(target, propertyKey)} — the property is ` +
                'non-configurable and cannot be replaced.',
        );
    }

    const wrapper = wrapMethod(found.value as Function, target, propertyKey, behavior);

    Object.defineProperty(target, propertyKey, {
        value: wrapper,
        // Mirror the descriptor being shadowed. Class methods are writable, non-enumerable and
        // configurable; reproducing that keeps `for...in` and `Object.keys` unchanged.
        writable: found.writable !== false,
        enumerable: found.enumerable === true,
        configurable: true,
    });

    return wrapper;
}

/**
 * The method descriptor for `propertyKey`, searched up the prototype chain.
 *
 * Own-property lookup would miss a subclass contracting an inherited method; plain `target[key]`
 * would find it but lose the descriptor attributes needed to reinstall faithfully.
 */
export function findMethodDescriptor(target: object, propertyKey: MethodKey): PropertyDescriptor | undefined {
    let cursor: object | null = target;
    while (cursor) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, propertyKey);
        if (descriptor) {
            return typeof descriptor.value === 'function' ? descriptor : undefined;
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    return undefined;
}

/** The underlying function for `propertyKey`, or `undefined` if there is not one. */
export function findMethod(target: object, propertyKey: MethodKey): Function | undefined {
    const descriptor = findMethodDescriptor(target, propertyKey);
    return descriptor ? (descriptor.value as Function) : undefined;
}

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

/** Never copied from the original onto the wrapper; each is handled explicitly or is meaningless. */
const RESERVED_FUNCTION_PROPERTIES = ['length', 'name', 'prototype', 'arguments', 'caller'];

/**
 * Make the wrapper look like the function it replaces.
 *
 * **BUG-7.** The previous implementation built the wrapper as
 * `obj[originalFunction.name] = function (...) {}` with the comment "Maintain the original function
 * name". It does not: JavaScript's named evaluation infers `.name` only for an anonymous function
 * assigned to a *binding* or to a key in an *object literal*, never for assignment to a member
 * expression on an existing object. The wrapper's `.name` was therefore `''`. Setting it explicitly
 * is the only thing that works.
 *
 * **`length` is deliberately not restored.** The wrapper reports arity `0`. That is a real defect,
 * it belongs to P1.6, and fixing it here would silently change behaviour that P1.6's
 * characterization tests still pin.
 *
 * SMELL-10: own properties are copied by descriptor rather than by `for...in` + assignment, so
 * non-enumerable and symbol-keyed properties survive instead of being quietly dropped.
 */
function adoptIdentity(wrapper: Function, original: Function): void {
    const keys: Array<string | symbol> = (
        Object.getOwnPropertyNames(original) as Array<string | symbol>
    ).concat(Object.getOwnPropertySymbols(original));

    for (const key of keys) {
        if (typeof key === 'string' && RESERVED_FUNCTION_PROPERTIES.indexOf(key) !== -1) continue;
        const descriptor = Object.getOwnPropertyDescriptor(original, key);
        if (descriptor) Object.defineProperty(wrapper, key, descriptor);
    }

    Object.defineProperty(wrapper, 'name', {
        value: original.name,
        writable: false,
        enumerable: false,
        configurable: true,
    });

    // Report the original source. Beyond transparency this is load-bearing: parameter *names* are
    // recovered by parsing `Function.prototype.toString` (SMELL-1), so a wrapper that reported its
    // own source would degrade every later message to the wrapper's signature.
    Object.defineProperty(wrapper, 'toString', {
        value: function () {
            return original.toString();
        },
        writable: true,
        enumerable: false,
        configurable: true,
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertBehavior(behavior: MethodBehavior, caller: string): void {
    if (typeof behavior !== 'function') {
        throw new TypeError(`${caller}: expected a behavior function (context, proceed) => result`);
    }
}

function describeMember(target: object, propertyKey: MethodKey): string {
    const owner = ownerName(target);
    const member = typeof propertyKey === 'symbol' ? propertyKey.toString() : String(propertyKey);
    return owner ? `${owner}.${member}` : member;
}

function ownerName(target: object): string {
    if (typeof target === 'function') return (target as Function).name;
    if (target && (target as any).constructor) return (target as any).constructor.name;
    return '';
}
