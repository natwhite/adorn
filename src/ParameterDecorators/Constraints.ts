/**
 * The built-in parameter constraints — thin adapters over reified descriptors (P1.3, expanded in
 * P3.3).
 *
 * Previously each of these was a closure that threw:
 *
 * ```ts
 * const Positive = () => simpleDecor((params: ParamObject<number>) => {
 *     if (params.value < 0) throw new Error(`...`);
 * });
 * ```
 *
 * You could run that; you could not ask it anything. Its identity (`min`) and its parameter (`0`)
 * existed only as instructions inside a function body, so no documentation line, JSON Schema
 * fragment, or value generator could ever be derived from it (DEC-006, plan §1.5).
 *
 * Each constraint delegates to a `ConstraintDescriptor` from `src/Contracts/`, where the predicate
 * is *derived* from the params rather than written alongside them (DEC-010). This file is a mapping
 * from decorator syntax onto the decorator-agnostic constraint model and nothing else: the
 * descriptors carry every semantic, this layer carries only the `@`-syntax. Adding a constraint here
 * that is not backed by a descriptor would make it invisible to all four projections (SMELL-14).
 *
 * ## P3.3 — what changed behaviourally
 *
 * Three deliberate breaks, all argued in `src/Contracts/number.ts` and `src/Contracts/string.ts`:
 *
 * 1. **`@Positive()` now rejects `0`** (ISSUES.md Q-1). Use `@NonNegative()` for the old behaviour.
 * 2. **`NaN` now violates every numeric constraint** (Q-7). It previously satisfied all of them,
 *    because every comparison with `NaN` is `false`. So did `undefined`.
 * 3. **`null`/`undefined` on a string constraint now report a contract violation** naming the
 *    parameter, instead of raising a bare `TypeError` from inside adorn (BUG-4).
 *
 * ## These require `@Contract()` on the class
 *
 * ```ts
 * @Contract()
 * class Task {
 *     test(@StringMinLength(10) message: string) { ... }
 * }
 * ```
 *
 * Without it the constraints are recorded but never installed, and a development-mode warning names
 * the class (see `Core/ContractDiagnostics`).
 */

import {ParameterDecoratorFactory} from '../Core/ParameterDecoratorFactory';
import * as Numbers from '../Contracts/number';
import * as Strings from '../Contracts/string';

const constraintDecorator = ParameterDecoratorFactory.CreateConstraintDecorator;

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

/**
 * Rejects values at or below zero.
 *
 * **BREAKING (P3.3):** `0` no longer passes — `@Positive()` previously rejected only `value < 0`.
 * Use {@link NonNegative} to keep the old behaviour.
 */
const Positive = () => constraintDecorator(Numbers.Positive());

/** Rejects values at or above zero. The mirror of {@link Positive}; `0` does not pass. */
const Negative = () => constraintDecorator(Numbers.Negative());

/** Rejects values below zero; `0` passes. This is what `@Positive()` meant before P3.3. */
const NonNegative = () => constraintDecorator(Numbers.NonNegative());

/** Rejects values above zero; `0` passes. The mirror of {@link NonNegative}. */
const NonPositive = () => constraintDecorator(Numbers.NonPositive());

/** Rejects values above `constraint`; `constraint` itself passes. */
const LessThanEqual = (constraint: number) => constraintDecorator(Numbers.LessThanEqual(constraint));

/** Rejects values below `constraint`; `constraint` itself passes. */
const GreaterThanEqual = (constraint: number) => constraintDecorator(Numbers.GreaterThanEqual(constraint));

/** Rejects values at or above `constraint` — the exclusive form of {@link LessThanEqual}. */
const LessThan = (constraint: number) => constraintDecorator(Numbers.LessThan(constraint));

/** Rejects values at or below `constraint` — the exclusive form of {@link GreaterThanEqual}. */
const GreaterThan = (constraint: number) => constraintDecorator(Numbers.GreaterThan(constraint));

/** Rejects values outside `[min, max]`. **Both bounds inclusive.** Throws at decoration if `min > max`. */
const Between = (min: number, max: number) => constraintDecorator(Numbers.Between(min, max));

/** Rejects non-integers. `1.5`, `Infinity`, and `NaN` all fail; `1.0` passes. */
const Integer = () => constraintDecorator(Numbers.Integer());

/** Rejects values that are not an exact multiple of `divisor`. `divisor` must be greater than zero. */
const MultipleOf = (divisor: number) => constraintDecorator(Numbers.MultipleOf(divisor));

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

/**
 * Rejects strings shorter than `constraint`; a string of exactly `constraint` passes.
 *
 * **BREAKING (P3.3):** a `null`, `undefined`, or non-string argument now produces a contract
 * violation naming the parameter, where it previously raised a bare `TypeError` (BUG-4).
 */
const StringMinLength = (constraint: number) => constraintDecorator(Strings.MinLength(constraint));

/** Canonical alias for {@link StringMinLength}, symmetrical with {@link MaxLength}. */
const MinLength = StringMinLength;

/** Rejects strings longer than `constraint`; a string of exactly `constraint` passes. */
const MaxLength = (constraint: number) => constraintDecorator(Strings.MaxLength(constraint));

/** Rejects the empty string. Length-based, so `'   '` passes — see `Contracts/string.ts`. */
const NotEmpty = () => constraintDecorator(Strings.NotEmpty());

/**
 * Rejects strings the pattern does not match. Anchoring is the author's business.
 *
 * The `g` and `y` flags are rejected at decoration time: `RegExp.test` advances `lastIndex` under
 * them, so the same value would validate differently on successive calls.
 */
const Matches = (pattern: RegExp | string, flags?: string) =>
    constraintDecorator(Strings.Matches(pattern, flags));

/** Rejects strings that do not look like an email address. Approximate by design — see P3.3. */
const Email = () => constraintDecorator(Strings.Email());

/**
 * Rejects strings that do not parse as an absolute URL with an accepted protocol.
 * Defaults to `http`/`https`; pass `protocols` to widen.
 */
const Url = (protocols?: string[]) => constraintDecorator(Strings.Url(protocols));

export {
    // number
    Positive,
    Negative,
    NonNegative,
    NonPositive,
    LessThanEqual,
    GreaterThanEqual,
    LessThan,
    GreaterThan,
    Between,
    Integer,
    MultipleOf,

    // string
    StringMinLength,
    MinLength,
    MaxLength,
    NotEmpty,
    Matches,
    Email,
    Url,
};
