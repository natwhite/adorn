/**
 * `@Requires` — a cross-parameter precondition on a method (IDEA-26 / DEC-057).
 *
 * The input-side twin of `@Ensures`. It records a closure `(...args) => boolean` into
 * `ContractRegistry`'s precondition band and returns the method untouched; the class-level `@Contract()`
 * (or per-method `@Validate()`) installs enforcement, which runs the closure **before** the method,
 * under the method's `trust` and blaming the **caller** — exactly where a per-position parameter
 * constraint runs. Like `@Ensures`, it is a closure: enforceable and fuzzable but **not** projectable
 * (it relates several parameters and carries no identity/params), so a `@Requires`-only method emits
 * nothing into docs or schema — the accepted `@Ensures`/SMELL-14 trade, applied to the input side.
 *
 * ```ts
 * @Contract()
 * class Booking {
 *     @Requires((start, end) => start < end, 'start is before end')
 *     reserve(start: number, end: number) { ... }
 * }
 * ```
 *
 * The predicate receives the method's arguments in order. Same decorator-ordering caveat as `@Ensures`:
 * with the per-method `@Validate()`, `@Requires` must sit **below** it (applied first) to be seen; the
 * class-level `@Contract()` runs last and is order-safe. Forgetting `@Contract()`/`@Validate()` leaves
 * the precondition recorded-but-unenforced and fires the standard development-mode warning.
 */

import {MethodKey, PreconditionPredicate, recordPrecondition} from '../Core/ContractRegistry';
import {notePendingContract} from '../Adapters/legacy/ContractDiagnostics';

/**
 * Record a cross-parameter precondition on the decorated method.
 *
 * @param predicate   `(...args) => boolean` — returns `true` when the call's arguments are acceptable.
 * @param description optional human phrase used in the violation message, e.g. "start is before end".
 */
export function Requires(predicate: PreconditionPredicate, description?: string): MethodDecorator {
    if (typeof predicate !== 'function') {
        throw new TypeError('@Requires: expected a (...args) => boolean predicate');
    }

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(`@Requires must be applied to a method; ${String(propertyKey)} is not one.`);
        }

        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands multiple
        // @Requires on one method in declaration order (DEC-015/DEC-017), matching @Ensures.
        recordPrecondition(target, propertyKey, {predicate, description}, 'prepend');
        notePendingContract(target, propertyKey);

        return descriptor; // unchanged — recording only, no wrapper installed here
    } as MethodDecorator;
}
