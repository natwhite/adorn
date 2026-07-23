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

import {MethodKey, PostconditionPredicate, recordPostcondition} from '../Core/ContractRegistry';
import {notePendingContract} from '../Core/ContractDiagnostics';

/**
 * Record a postcondition on the decorated method.
 *
 * @param predicate   `(result, ...args) => boolean` — returns `true` when the method kept its promise.
 * @param description optional human phrase used in the violation message, e.g. "the id is positive".
 */
export function Ensures(predicate: PostconditionPredicate, description?: string): MethodDecorator {
    if (typeof predicate !== 'function') {
        throw new TypeError('@Ensures: expected a (result, ...args) => boolean predicate');
    }

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(`@Ensures must be applied to a method; ${String(propertyKey)} is not one.`);
        }

        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands multiple
        // @Ensures on one method in declaration order (DEC-015/DEC-017), matching stageCheck's unshift.
        recordPostcondition(target, propertyKey, {predicate, description}, 'prepend');
        notePendingContract(target, propertyKey);

        return descriptor; // unchanged — recording only, no wrapper installed here
    } as MethodDecorator;
}
