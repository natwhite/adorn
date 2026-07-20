/**
 * The built-in parameter constraints — now **thin adapters over reified descriptors** (P1.3).
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
 * Each constraint now delegates to a `ConstraintDescriptor` from `src/Contracts/`, where the
 * predicate is *derived* from the params rather than written alongside them (DEC-010). This file
 * shrinks to what it should always have been: a mapping from decorator syntax onto the
 * decorator-agnostic constraint model. The descriptors carry the semantics; this layer carries only
 * the `@`-syntax.
 *
 * **Messages are unchanged.** `Contracts/number.ts` and `Contracts/string.ts` port the original
 * wording verbatim, including the two known warts they inherit — `Positive()` accepting `0`
 * (ISSUES.md Q-1) and `StringMinLength` throwing a bare `TypeError` on `null` (BUG-4). Neither is
 * silently corrected here; both are behavioural breaks that belong to their own scheduled work.
 *
 * ## These now require `@Contract()` on the class
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
import {
    GreaterThanEqual as greaterThanEqualConstraint,
    LessThanEqual as lessThanEqualConstraint,
    Positive as positiveConstraint,
} from '../Contracts/number';
import {StringMinLength as minLengthConstraint} from '../Contracts/string';

const constraintDecorator = ParameterDecoratorFactory.CreateConstraintDecorator;

/** Rejects values below zero. **Accepts `0`** — see ISSUES.md Q-1 / DEC-001. */
const Positive = () => constraintDecorator(positiveConstraint());

/** Rejects values above `constraint`; `constraint` itself passes. */
const LessThanEqual = (constraint: number) => constraintDecorator(lessThanEqualConstraint(constraint));

/** Rejects values below `constraint`; `constraint` itself passes. */
const GreaterThanEqual = (constraint: number) => constraintDecorator(greaterThanEqualConstraint(constraint));

/**
 * Rejects strings shorter than `constraint`; a string of exactly `constraint` passes.
 *
 * No null guard, preserved from the original (BUG-4): a `null` argument raises a bare `TypeError`
 * rather than a contract violation. P3.3 adds type guards uniformly across the whole set.
 */
const StringMinLength = (constraint: number) => constraintDecorator(minLengthConstraint(constraint));

export {
    Positive,
    LessThanEqual,
    GreaterThanEqual,
    StringMinLength,
};
