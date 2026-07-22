/**
 * Imperative assertions — the non-decorator way to enforce a contract.
 *
 * ## Does `Verify` still have a job now that descriptors exist? (SMELL-8)
 *
 * Yes, but a much narrower one, and it is no longer allowed to have opinions.
 *
 * A `ConstraintDescriptor` is *data plus a boolean predicate*. It never throws — deciding what a
 * failure means belongs to an enforcement layer, and there are now three: `ParameterDecoratorFactory`
 * for arguments, `FieldDecoratorFactory` for fields, and this one, for the places neither can reach —
 * inside a function body, a factory, a parsing loop, a hand-rolled constructor, a plain object that
 * is not a class at all. Those call sites have no decoration point. Deleting `Verify` would leave
 * adorn with no imperative entry point, so it stays.
 *
 * ## What changed: it no longer implements anything
 *
 * Previously every method here was a hand-written comparison:
 *
 * ```ts
 * static positive(keyName, value) {
 *     if (value < 0) throw new Error(`ValueError: ${keyName} is expected to be a positive number...`);
 * }
 * ```
 *
 * That is a **second implementation** of boundaries `src/Contracts/` also defines — precisely the
 * descriptor/predicate drift Q-4 names as the worst failure mode the "contracts as the single source
 * of truth" goal introduces (DEC-006, DEC-010). `Verify.positive` and `@Positive()` could silently
 * disagree, and generated documentation would describe one while the other ran. It was not
 * hypothetical: P3.3 made `positive` strict, and a hand-written `Verify.positive` would still have
 * been accepting `0` afterwards.
 *
 * **There is not one comparison operator left in this file.** Every check comes from the descriptor
 * its decorator counterpart uses, so drift is structurally impossible rather than merely unlikely,
 * and `Verify` becomes what it should always have been: a throw site, not a rule.
 *
 * ## `that()` is the real API; the rest are conveniences
 *
 * {@link Verify.that} takes any descriptor, so `Verify` never needs a method per constraint and
 * cannot fall behind `src/Contracts/` as that set grows:
 *
 * ```ts
 * Verify.that(Between(1, 10), 'retries', retries);
 * Verify.that(Email(), 'contact', input.contact);
 * ```
 *
 * The two named helpers below are kept because they are the pre-existing public surface (SMELL-8
 * found them unused, but `Verify` is exported from `index.ts`, so they are removable API rather
 * than dead internals).
 *
 * ## Three behavioural changes, all deliberate
 *
 * 1. **`lessThanEqual` / `greaterThanEqual` took `(key, target, constraint)`** while `positive` took
 *    `(keyName, value)` — value and bound sat in different positions in sibling methods. Normalised
 *    to `(keyName, value, bound)`. Neither had a caller anywhere (SMELL-8), so the cost is nil, and
 *    the implementation plan's compatibility table calls for exactly this: "normalize now while
 *    surface area is tiny".
 * 2. **Messages now come from the descriptor**, matching what the decorators produce and what
 *    documentation renders. `ValueError: count is expected to be a positive number, got '-1'`
 *    becomes `Value Error: count expected a number greater than 0 but received -1 instead`. Nothing
 *    pinned the old strings.
 * 3. **`Verify.positive` is removed** (Q-1, DEC-020), along with the `Positive` descriptor it
 *    delegated to. It is the one helper here that was *named* for a boundary rather than given one,
 *    and it inherited the ambiguity wholesale — its own doc comment had to explain which side of
 *    zero it fell on. Write `Verify.that(GreaterThan(0), key, value)`, or
 *    `Verify.greaterThanEqual(key, value, 0)` if `0` should pass. This is a removal from the
 *    pre-existing public surface and is deliberate: keeping it would have kept exactly one place
 *    where the vocabulary still encoded a boundary in a name.
 */

import {ConstraintDescriptor} from '../Core/Descriptor';
import {GreaterThanEqual, LessThanEqual} from '../Contracts/number';
import {shouldDiscloseValue} from '../Core/redaction';

export class Verify {
    /**
     * Check `value` against any constraint descriptor. Returns `value` on success, throws otherwise.
     *
     * @param constraint - a descriptor from `src/Contracts/`, e.g. `Between(1, 10)`
     * @param keyName    - name of the thing being checked, used in the message
     * @param value      - the value to check
     */
    static that<T>(constraint: ConstraintDescriptor, keyName: string | symbol, value: T): T {
        if (constraint.predicate(value)) return value;

        // Redacted by default (BUG-19), like every violation message. An imperative call has no
        // `@Sensitive` site to consult, so disclosure follows the global switch alone.
        const error = new Error(
            constraint.message({value, signature: String(keyName), disclose: shouldDiscloseValue(false)}),
        );
        // Cut the stack at this frame so the trace points at the caller's line rather than at
        // adorn's internals — the same boundary technique as `DecoratorFactory.attributeToCaller`,
        // applied at construction because the Error originates here. V8-only; a no-op elsewhere.
        const capture = (
            Error as unknown as {
                captureStackTrace?: (target: object, constructorOpt?: Function) => void;
            }
        ).captureStackTrace;
        if (typeof capture === 'function') capture(error, Verify.that);

        throw error;
    }

    /*
     * `Verify.positive` was removed by DEC-020. Use `Verify.that(GreaterThan(0), key, value)` for
     * the strict boundary, or `Verify.greaterThanEqual(key, value, 0)` if `0` should pass.
     */

    /**
     * Returns `value` if it is not above `max`, otherwise throws. `max` itself passes.
     *
     * **Argument order changed** from `(key, target, constraint)` — see the module note.
     */
    static lessThanEqual<T>(keyName: string | symbol, value: T, max: number): T {
        return Verify.that(LessThanEqual(max), keyName, value);
    }

    /**
     * Returns `value` if it is not below `min`, otherwise throws. `min` itself passes.
     *
     * **Argument order changed** from `(key, target, constraint)` — see the module note.
     */
    static greaterThanEqual<T>(keyName: string | symbol, value: T, min: number): T {
        return Verify.that(GreaterThanEqual(min), keyName, value);
    }
}
