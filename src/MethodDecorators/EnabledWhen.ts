/**
 * `@EnabledWhen` — a state-reading enabledness precondition (a "guard"), DEC-089.
 *
 * The receiver-aware sibling of `@Requires`. Where `@Requires((...args) => boolean)` relates only the
 * call's arguments, `@EnabledWhen((self, ...args) => boolean)` receives the **receiver first**, so it can
 * read object state — the thing a `@Requires` precondition structurally cannot. It records a closure into
 * `ContractRegistry`'s enabledness band and returns the method untouched; the class-level `@Contract()`
 * (or per-method `@Validate()`) installs enforcement, which runs the guard **before** the method, under
 * the method's `trust` and blaming the **caller** (the call was not enabled in this state).
 *
 * It is deliberately a band **separate** from `@Requires`, not a stylistic split, because the two carry
 * opposite operational meaning downstream: a failed `@Requires` is a generation/starvation signal that
 * constrains an input schema; a failed `@EnabledWhen` is an expected "not enabled here" skip that is never
 * projected into a schema (no argument choice satisfies it). Like `@Requires`/`@Ensures` it is a closure —
 * enforceable and fuzzable but **not** projectable — so an `@EnabledWhen`-only method emits nothing to
 * docs or schema. The name avoids `@Guard`, which collides with adorn's `ContractTrust='guard'` term.
 *
 * ```ts
 * @Contract()
 * class Wallet {
 *     constructor(private balance: number) {}
 *
 *     @EnabledWhen((self: Wallet, amount: number) => amount <= self.balance, 'balance covers the amount')
 *     withdraw(amount: number) { this.balance -= amount; return this.balance; }
 * }
 * ```
 *
 * The predicate receives `(self, ...args)` in order. Same decorator-ordering caveat as `@Requires`: with
 * the per-method `@Validate()`, `@EnabledWhen` must sit **below** it (applied first) to be seen; the
 * class-level `@Contract()` runs last and is order-safe. A guard that *returns false* is a caller-blamed
 * "not enabled"; a guard that *throws* surfaces as an author defect (guards must be total over reachable
 * state) — it propagates unchanged rather than being rewritten to caller-blame.
 */

import {MethodKey, EnablednessPredicate, recordEnablednessGuard} from '../Core/ContractRegistry';
import {notePendingContract} from '../Adapters/legacy/ContractDiagnostics';

/**
 * Record a state-reading enabledness guard on the decorated method.
 *
 * @param predicate   `(self, ...args) => boolean` — returns `true` when the call is enabled in the
 *                    current state. `self` is the receiver; the remaining parameters are the call's args.
 * @param description optional human phrase used in the "not enabled" message, e.g. "balance covers the amount".
 */
export function EnabledWhen(predicate: EnablednessPredicate, description?: string): MethodDecorator {
    if (typeof predicate !== 'function') {
        throw new TypeError('@EnabledWhen: expected a (self, ...args) => boolean predicate');
    }

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(
                `@EnabledWhen must be applied to a method; ${String(propertyKey)} is not one.`,
            );
        }

        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands multiple
        // @EnabledWhen on one method in declaration order (DEC-015/DEC-017), matching @Requires/@Ensures.
        recordEnablednessGuard(target, propertyKey, {predicate, description, band: 'enabledness'}, 'prepend');
        notePendingContract(target, propertyKey);

        return descriptor; // unchanged — recording only, no wrapper installed here
    } as MethodDecorator;
}
