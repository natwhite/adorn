/**
 * `@Returns` — a reified, projectable postcondition on a method's return value (DEC-033, plan Item 2).
 *
 * ## The projectable twin of `@Ensures`
 *
 * `@Ensures((result, ...args) => boolean, phrase)` records a *closure* into the postcondition band:
 * enforceable and fuzzable, but opaque — it carries no identity or params, so nothing can be projected
 * from it (SMELL-14). `@Returns(descriptor)` records an existing {@link ConstraintDescriptor} — e.g.
 * `@Returns(NumberContracts.GreaterThanEqual(0))` — into the reserved `MethodContract.post` band that
 * Q-11 kept reserved for exactly this (DEC-032). Because a descriptor is *data*, the return value is
 * (a) checked by the same `descriptor.predicate` machinery preconditions use (DEC-010 — the predicate
 * is derived from params, never re-implemented here) and (b) emitted into the docs "Returns" section
 * and the JSON-Schema `returns` fragment.
 *
 * The split is deliberate and is the projectable/opaque line: `@Returns` is the *single-value,
 * projectable* subset (the return in isolation); `@Ensures` remains the *n-ary, opaque* superset (the
 * return related to the inputs). A guarantee relating the return to an argument — "result exceeds
 * `amount`" — stays `@Ensures`, because a `ConstraintDescriptor` tests one value. Both may sit on one
 * method and both are checked; the reified band is checked first (DEC-033).
 *
 * ## It records; it does not install
 *
 * Structurally the sibling of `@Ensures`: it writes to `ContractRegistry`'s reserved return band and
 * returns the property descriptor untouched. Enforcement is installed later by the class-level
 * `@Contract()` (or the per-method `@Validate()`), exactly as parameter constraints and `@Ensures`
 * are — installation implies enumeration is the installer's job (DEC-016). Forgetting
 * `@Contract()`/`@Validate()` leaves the contract recorded-but-unenforced, and the standard
 * development-mode warning fires via {@link notePendingContract}, the same hook the other decorators use.
 *
 * ```ts
 * @Contract()
 * class Ledger {
 *     @Returns(NumberContracts.GreaterThanEqual(0))
 *     balance(): number { ... }
 * }
 * ```
 *
 * For an async method the descriptor is checked against the **resolved** value, not the Promise; a
 * throw or rejection skips it; an Observable is handed the raw stream (rxjs is not a dependency —
 * DEC-019). Identical settling to `@Ensures`.
 *
 * ## The `@Validate()` ordering caveat (identical to `@Ensures`)
 *
 * `@Returns` is an ordinary method decorator interleaved with `@Validate()` by *source order*, so it
 * must sit **below** `@Validate()` (applied first) for `@Validate()` to see it. The class-level
 * `@Contract()` runs last unconditionally and has no such caveat — it is the recommended, order-safe
 * form.
 *
 * ## The `description` argument (v1)
 *
 * Accepted for signature parity with `@Ensures` and forward-compatibility, and validated when supplied.
 * It is deliberately **not stored**: the reserved `post` band holds descriptors only, and a descriptor
 * already carries its own `describe()`, which is the single source for both the violation message and
 * the projections (DEC-010 — derived, never attached, so a description cannot drift from the predicate).
 * A later tier may thread it as an override phrase; v1 does not, rather than ship a stored-but-ignored
 * field.
 */

import {ConstraintDescriptor} from '../Core/Descriptor';
import {MethodKey, recordReturnConstraint} from '../Core/ContractRegistry';
import {notePendingContract} from '../Core/ContractDiagnostics';

/**
 * Record a reified return-value postcondition on the decorated method.
 *
 * @param descriptor  an existing {@link ConstraintDescriptor} (e.g. `NumberContracts.GreaterThanEqual(0)`).
 *                    A bare predicate is rejected — it cannot be projected (use `@Ensures` for that).
 * @param description reserved; see the module note. Validated when supplied, not stored in v1.
 */
export function Returns(descriptor: ConstraintDescriptor, description?: string): MethodDecorator {
    if (!descriptor || typeof descriptor.predicate !== 'function') {
        throw new TypeError(
            '@Returns: expected a ConstraintDescriptor (e.g. NumberContracts.GreaterThanEqual(0)). A ' +
                'bare predicate carries no identity or params and cannot be projected — use @Ensures for ' +
                'a closure postcondition.',
        );
    }
    if (description !== undefined && typeof description !== 'string') {
        throw new TypeError('@Returns: description, when supplied, must be a string');
    }

    return function (target: object, propertyKey: MethodKey, propertyDescriptor: PropertyDescriptor) {
        if (!propertyDescriptor || typeof propertyDescriptor.value !== 'function') {
            throw new TypeError(`@Returns must be applied to a method; ${String(propertyKey)} is not one.`);
        }

        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands multiple
        // @Returns on one method in declaration order (DEC-015/DEC-017), matching @Ensures.
        recordReturnConstraint(target, propertyKey, descriptor, 'prepend');
        notePendingContract(target, propertyKey);

        return propertyDescriptor; // unchanged — recording only, no wrapper installed here
    } as MethodDecorator;
}
