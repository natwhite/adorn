/**
 * P2.2 — field contracts, rebuilt on {@link CreateFieldDecorator} (BUG-1).
 *
 * ## What this replaces
 *
 * ```ts
 * private static generator(func: (v, k?, t?) => void) {
 *     return (target, key) => {
 *         Object.defineProperty(target, key, {configurable: false, set: v => func(v, key, target)});
 *     };
 * }
 * static positive = () => Enforce.generator((v, k) => Verify.positive(k, v));
 * ```
 *
 * No getter, no storage, prototype-shared, and non-configurable — so `@Enforce.positive()` validated
 * an assignment and then read back `undefined` forever. `generator` is gone entirely. The accessor
 * design that replaces it, and why the value lives in a per-instance own accessor rather than a
 * `WeakMap` side table, is documented on `Core/FieldDecoratorFactory`.
 *
 * ## The field band exposes exactly what the parameter band does
 *
 * Every entry below is the *same* `ConstraintDescriptor` the matching parameter decorator uses,
 * taken from `src/Contracts/`. Nothing here restates a boundary, so `@Enforce.positive()` and
 * `@Positive()` cannot disagree — the drift Q-4 exists to guard against — and each field constraint
 * carries the identity and params a projection reads (DEC-006).
 *
 * The set mirrors `src/ParameterDecorators/Constraints.ts` rather than being curated, so there is no
 * arbitrary "this one is available on parameters but not on fields" gap to explain. Adding a
 * constraint to `src/Contracts/` is what makes it available; both bands are one line of wiring.
 * Anything not listed can still be applied directly with
 * `@CreateFieldDecorator(MultipleOf(5))`.
 *
 * ## Semantics come from the descriptors, including P3.3's breaks
 *
 * `positive()` is **strict** — `0` is rejected; use `nonNegative()` for the old behaviour (Q-1,
 * DEC-001). `NaN` violates every numeric constraint (Q-7), and every predicate is total, so a `null`
 * or wrong-typed assignment is a contract violation rather than a bare `TypeError` (BUG-4). None of
 * that is decided here; it is inherited, which is the point.
 *
 * ## No `@Contract()` needed
 *
 * Unlike parameter constraints, a field contract installs itself at decoration time — see the module
 * note on `Core/FieldDecoratorFactory` for why that is safe for a field and was not for a method.
 * There is consequently no silent-no-op failure mode here and nothing for the missing-`@Contract()`
 * diagnostic to warn about.
 */

import {CreateFieldDecorator} from '../Core/FieldDecoratorFactory';
import * as Numbers from '../Contracts/number';
import * as Strings from '../Contracts/string';

export class Enforce {
    // --- numbers ------------------------------------------------------------

    /**
     * Rejects values at or below zero.
     *
     * ```ts
     * class Basket {
     *     @Enforce.positive()
     *     itemCount: number = 1;
     * }
     * ```
     *
     * **`0` does not pass** since P3.3 — use {@link nonNegative}.
     */
    static positive = () => CreateFieldDecorator(Numbers.Positive());

    /** Rejects values at or above zero. `0` does not pass. */
    static negative = () => CreateFieldDecorator(Numbers.Negative());

    /** Rejects values below zero; `0` passes. What `positive()` meant before P3.3. */
    static nonNegative = () => CreateFieldDecorator(Numbers.NonNegative());

    /** Rejects values above zero; `0` passes. */
    static nonPositive = () => CreateFieldDecorator(Numbers.NonPositive());

    /** Rejects values below `min`; `min` itself passes. */
    static greaterThanEqual = (min: number) => CreateFieldDecorator(Numbers.GreaterThanEqual(min));

    /** Rejects values above `max`; `max` itself passes. */
    static lessThanEqual = (max: number) => CreateFieldDecorator(Numbers.LessThanEqual(max));

    /** Rejects values at or below `bound`. */
    static greaterThan = (bound: number) => CreateFieldDecorator(Numbers.GreaterThan(bound));

    /** Rejects values at or above `bound`. */
    static lessThan = (bound: number) => CreateFieldDecorator(Numbers.LessThan(bound));

    /** Rejects values outside `[min, max]`. **Both bounds inclusive.** */
    static between = (min: number, max: number) => CreateFieldDecorator(Numbers.Between(min, max));

    /** Rejects non-integers, and any non-number. */
    static integer = () => CreateFieldDecorator(Numbers.Integer());

    /** Rejects values that are not an exact multiple of `divisor`. */
    static multipleOf = (divisor: number) => CreateFieldDecorator(Numbers.MultipleOf(divisor));

    // --- strings ------------------------------------------------------------

    /** Rejects strings shorter than `minLength`; a string of exactly `minLength` passes. */
    static minLength = (minLength: number) => CreateFieldDecorator(Strings.MinLength(minLength));

    /** Rejects strings longer than `maxLength`; a string of exactly `maxLength` passes. */
    static maxLength = (maxLength: number) => CreateFieldDecorator(Strings.MaxLength(maxLength));

    /** Rejects the empty string, and any non-string. */
    static notEmpty = () => CreateFieldDecorator(Strings.NotEmpty());

    /** Rejects strings the pattern does not match end to end. */
    static matches = (pattern: RegExp | string, flags?: string) =>
        CreateFieldDecorator(Strings.Matches(pattern, flags));

    /** Rejects strings that do not look like an email address. Approximate by design. */
    static email = () => CreateFieldDecorator(Strings.Email());

    /** Rejects strings that do not parse as a URL with an allowed protocol. */
    static url = (protocols?: string[]) => CreateFieldDecorator(Strings.Url(protocols));
}
