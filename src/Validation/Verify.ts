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

import {ConstraintDescriptor, ConstraintKind, ConstraintParams} from '../Core/Descriptor';
import {GreaterThanEqual, LessThanEqual} from '../Contracts/number';
import {shouldDiscloseValue} from '../Core/redaction';
import type {ViolationFacts} from '../Core/Observation';

/**
 * The result of {@link Verify.check} — a discriminated union so a caller can branch on a violation
 * *without* a try/catch. `ok: true` carries the validated value; `ok: false` carries the same redacted
 * message {@link Verify.that} would have thrown, plus the descriptor's `constraint` identity and `kind`
 * so an I/O boundary can map a violation to a status/code programmatically. The received value is
 * deliberately absent — the message is already redacted by default (DEC-030) and the caller still holds
 * the value it passed in. See DEC-053.
 */
export type CheckResult<T> =
    | {readonly ok: true; readonly value: T}
    | {
          readonly ok: false;
          readonly message: string;
          readonly constraint: string;
          readonly kind: ConstraintKind;
          /**
           * The path to the first failing sub-location for a COMPOSITIONAL descriptor (DEC-060) —
           * `['slotInput', 'when']` for a bad nested field, `['tags', 2]` for a bad array element. Present
           * only when the descriptor can localize the failure (it supplies a `locate` hook) AND the failure
           * is below the value's own level; absent for a primitive constraint or a container-gate/length
           * failure, where `message` already names everything. Lets a handler build a per-field 400.
           */
          readonly path?: ReadonlyArray<string | number>;
          /**
           * The `describe()` of the INNERMOST descriptor that actually rejected at `path` (DEC-060, round-4
           * §2.2) — e.g. `one of "alice", "bob"` for a bad `ArrayOf(OneOf([...]))` element, so a caller composes
           * `subjects[1]: expected one of "alice", "bob"` rather than the container-level `message` (which would
           * wrongly say "expected an array"). Present iff `path` is. A pure function of the constraint's params,
           * so it never leaks the received value (DEC-030).
           */
          readonly expected?: string;
      };

/**
 * Imperative validation for call sites with no decoration point — a function body, a factory, a parsing
 * loop, an untrusted I/O boundary. {@link Verify.that} throws on a violation; {@link Verify.check} returns
 * a discriminated {@link CheckResult} instead — the non-throwing path for a boundary that needs the failure
 * as a *value*, with the failing key on `path` for a compositional constraint (DEC-060). Both take a
 * `ConstraintDescriptor` from the `*Contracts` namespaces (e.g. `NumberContracts.Between(1, 10)`) and
 * narrow `unknown` to the constraint's output type (DEC-059).
 */
export class Verify {
    /**
     * Check `value` against any constraint descriptor. Returns `value` on success, throws otherwise.
     *
     * @param constraint - a descriptor from `src/Contracts/`, e.g. `Between(1, 10)`
     * @param keyName    - name of the thing being checked, used in the message
     * @param value      - the value to check
     */
    static that<T>(
        constraint: ConstraintDescriptor<ConstraintParams, T>,
        keyName: string | symbol,
        value: unknown,
    ): T {
        // `T` binds to the constraint's OUTPUT type (DEC-059), so a caller narrows `unknown` to what the
        // constraint proves. The cast is sound: it runs only after `predicate(value)` returned true.
        if (constraint.predicate(value)) return value as T;

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

    /**
     * Non-throwing sibling of {@link Verify.that}: returns a {@link CheckResult} instead of throwing.
     *
     * The boundary answer to Q-6 (DEC-053). An I/O handler turning an untrusted body into a `400` needs
     * the violation as a **value, in this call** — not as an exception to catch, and not out-of-band
     * through the observation sink (an async stream of facts, the wrong shape for choosing *this*
     * response's status synchronously). Same predicate, same redacted message as {@link Verify.that};
     * the only difference is that a failure comes back rather than being thrown. Because it reuses the
     * exact predicate and message call `that` uses, the two cannot drift (DEC-010).
     *
     * ```ts
     * const r = Verify.check(NumberContracts.Between(1, 7), 'days', body.days);
     * if (!r.ok) return badRequest(r.message);
     * // r.value is the validated value here
     * ```
     */
    static check<T>(
        constraint: ConstraintDescriptor<ConstraintParams, T>,
        keyName: string | symbol,
        value: unknown,
    ): CheckResult<T> {
        // `T` binds to the constraint's OUTPUT type (DEC-059) — `Verify.check(Dictionary(NotEmpty()), …)`
        // returns `CheckResult<Record<string, string>>`. The cast runs only after `predicate` returned true.
        if (constraint.predicate(value)) return {ok: true, value: value as T};

        // Localize the failure for a compositional descriptor (DEC-060) — the first failing key/index chain
        // AND the innermost failing `expected` phrase (round-4 §2.2). Runs once, only on the failure path;
        // `undefined` for a primitive or a container-gate failure, where `message` stands alone.
        const loc = constraint.locate ? constraint.locate(value) : undefined;

        // The same redacted rendering Verify.that throws — an imperative call has no `@Sensitive` site,
        // so disclosure follows the global switch alone (BUG-19/DEC-030). The value is never in the result.
        return {
            ok: false,
            message: constraint.message({
                value,
                signature: String(keyName),
                disclose: shouldDiscloseValue(false),
            }),
            constraint: constraint.constraint,
            kind: constraint.kind,
            ...(loc && loc.path && loc.path.length > 0 ? {path: loc.path} : {}),
            ...(loc && loc.expected ? {expected: loc.expected} : {}),
        };
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
    static lessThanEqual(keyName: string | symbol, value: unknown, max: number): number {
        return Verify.that(LessThanEqual(max), keyName, value);
    }

    /**
     * Returns `value` if it is not below `min`, otherwise throws. `min` itself passes.
     *
     * **Argument order changed** from `(key, target, constraint)` — see the module note.
     */
    static greaterThanEqual(keyName: string | symbol, value: unknown, min: number): number {
        return Verify.that(GreaterThanEqual(min), keyName, value);
    }
}

/** A failed {@link CheckResult} — the `ok: false` arm, the only input {@link violationFromCheck} accepts. */
export type CheckFailure = Extract<CheckResult<unknown>, {ok: false}>;

/**
 * Translate a failed {@link Verify.check} into {@link ViolationFacts} (voice-agent L11, DEC-074), so a
 * FUNCTIONAL validation failure can be emitted as a `violation` observation event — the same stream the
 * decorator enforcement weave feeds. Without it, a zero-class consumer's refusals are invisible as
 * violations (they surface only as ordinary returned values), so in a trace a slow call and a *refused*
 * call look identical.
 *
 * A pure mapping: the `CheckResult` already carries `constraint`, `kind`, the localized `expected`, and
 * `path`; the caller supplies the `trust`/`blame`/parameter identity the enforcement SITE would have added
 * (defaults `guard`/`caller` — the posture of validating untrusted input at a boundary). `params` is empty:
 * a `CheckResult` does not carry the descriptor's params, exactly as an `@Ensures` closure violation
 * degrades — the value-free facts stay honest rather than invented. Feeds `adorn/otel`'s `violationAttributes`.
 */
export function violationFromCheck(
    result: CheckFailure,
    options?: {
        readonly parameter?: string;
        readonly index?: number;
        readonly trust?: 'guard' | 'assert';
        readonly blame?: 'caller' | 'callee';
    },
): ViolationFacts {
    return {
        constraint: result.constraint,
        kind: result.kind,
        params: {},
        expectation: result.expected || result.message,
        ...(options && typeof options.parameter === 'string' ? {parameterName: options.parameter} : {}),
        parameterIndex: options && typeof options.index === 'number' ? options.index : 0,
        trust: (options && options.trust) || 'guard',
        blame: (options && options.blame) || 'caller',
    };
}
