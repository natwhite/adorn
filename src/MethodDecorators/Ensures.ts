/**
 * `@Ensures` — a postcondition on a method (Q-11, plan B §3).
 *
 * ## It records; it does not install
 *
 * Structurally the sibling of a parameter decorator (`CreateConstraintDecorator`), not of an
 * installing one like `@Time`. It writes the closure into `ContractRegistry`'s postcondition band and
 * returns the descriptor untouched. Enforcement is installed later by the class-level `@Contract()`
 * (or the per-method `@Validate()`), exactly as parameter constraints are — installation implies
 * enumeration is the installer's job (DEC-016), and installing a wrapper here would fight the trust
 * gate and reintroduce ordering hazards with parameter decorators.
 *
 * Forgetting `@Contract()`/`@Validate()` leaves the postcondition recorded-but-unenforced, and the
 * standard development-mode warning fires — this calls {@link notePendingContract}, the same hook the
 * parameter decorators use.
 *
 * ```ts
 * @Contract()
 * class Wallet {
 *     @Ensures((balance, amount) => balance >= amount, 'balance covers the withdrawal')
 *     withdraw(amount: number): number { ... }
 * }
 * ```
 *
 * The predicate receives the **return value first**, then the arguments the method was called with.
 * For an async method it is checked against the **resolved** value, not the Promise (plan B §5).
 *
 * ## Two documented hazards, both stated rather than engineered around in v1
 *
 * - **Decorator order with `@Validate()`.** Parameter decorators are `__param` entries placed last in
 *   the `__decorate` array (applied first), so they always record before `@Validate()` runs.
 *   `@Ensures` is an ordinary method decorator interleaved with `@Validate()` by *source order*, so
 *   `@Ensures` must sit **below** `@Validate()` (applied first) for `@Validate()` to see it. The
 *   class-level `@Contract()` runs last unconditionally and has no such caveat — it is the
 *   recommended, order-safe form for postconditions.
 * - **Observable results.** An Observable is a non-thenable object, so v1 hands the raw Observable to
 *   the predicate rather than settling it (rxjs is not a dependency — DEC-019). Postconditions over a
 *   stream are rarely what you want; real settling is deferred (plan B §5).
 */

import {MethodKey, recordPostcondition} from '../Core/ContractRegistry';
import {notePendingContract} from '../Adapters/legacy/ContractDiagnostics';

/**
 * The options form of {@link Ensures}, for a postcondition that needs more than a bare predicate:
 *
 * - `capture` (axiform feedback 2026-10-18 §9) — a function run against the arguments at call ENTRY whose
 *   deep-cloned, frozen result is handed to the predicate as a leading `old`, so the postcondition compares
 *   against pre-mutation state. With it, write the predicate as `(result, old, ...args) => boolean`. Without
 *   it, the predicate reads the POST-call argument state, where a body that mutates an argument can mask its
 *   own violation. See `Core/prestate` for the snapshot semantics (cloneable data only).
 * - `id` — a stable clause identity (§5), carried onto a `contract.checked` verdict (the decorator path does
 *   not surface it elsewhere).
 */
export interface EnsuresOptions {
    /**
     * `(result, ...args) => boolean`, or `(result, old, ...args) => boolean` when `capture` is set. Typed
     * with `result`/`old` as `any` (not the registry band's `unknown`, axiform §7) so the author may annotate
     * them — `(r: Foo, old: Bar) => …` — without a cast; the stored predicate is unchanged.
     */
    readonly predicate: (result: any, ...rest: any[]) => boolean;
    readonly description?: string;
    readonly id?: string;
    readonly capture?: (...args: any[]) => unknown;
}

/**
 * Record a postcondition on the decorated method. Two forms:
 *
 * - `@Ensures((result, ...args) => boolean, description?)` — the common closure form.
 * - `@Ensures({predicate, capture?, description?, id?})` — the options form, for a pre-state `capture` (§9)
 *   or a stable `id` (§5). With `capture`, the predicate reads `(result, old, ...args)`.
 */
export function Ensures(
    predicate: (result: any, ...args: any[]) => boolean,
    description?: string,
): MethodDecorator;
export function Ensures(options: EnsuresOptions): MethodDecorator;
export function Ensures(
    predicateOrOptions: ((result: any, ...args: any[]) => boolean) | EnsuresOptions,
    description?: string,
): MethodDecorator {
    const options: EnsuresOptions =
        typeof predicateOrOptions === 'function'
            ? {predicate: predicateOrOptions, description}
            : predicateOrOptions;

    if (typeof options.predicate !== 'function') {
        throw new TypeError('@Ensures: expected a (result, ...args) => boolean predicate');
    }
    if (options.capture !== undefined && typeof options.capture !== 'function') {
        throw new TypeError('@Ensures: `capture` must be a (...args) => value function when provided');
    }

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(`@Ensures must be applied to a method; ${String(propertyKey)} is not one.`);
        }

        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands multiple
        // @Ensures on one method in declaration order (DEC-015/DEC-017), matching stageCheck's unshift.
        recordPostcondition(
            target,
            propertyKey,
            {
                predicate: options.predicate,
                description: options.description,
                id: options.id,
                ...(options.capture ? {capture: options.capture} : {}),
            },
            'prepend',
        );
        notePendingContract(target, propertyKey);

        return descriptor; // unchanged — recording only, no wrapper installed here
    } as MethodDecorator;
}
