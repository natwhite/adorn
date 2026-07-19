/**
 * Numeric constraints, as descriptors (P1.0 / plan §2).
 *
 * These are **not** decorators and must never become decorators. This layer is decorator-agnostic
 * (DEC-012): the same descriptor is consumed by the legacy per-parameter adapter, by a
 * method-level `@Contract({...})`, and by every projection. Wiring these into the existing
 * decorators is P1.3 and is deliberately not done here.
 *
 * ## Semantics are ported verbatim
 *
 * Each predicate below reproduces the *exact* condition of the closure it replaces in
 * `src/ParameterDecorators/Constraints.ts`, including two behaviours that look like defects:
 *
 * 1. **`Positive` accepts `0`.** It rejects only `value < 0`, so `min` is inclusive at zero and
 *    the name disagrees with the semantics. This is deliberate and is tracked as ISSUES.md **Q-1**
 *    (see also DEC-001); it is not silently "corrected" here, because settling it is a behavioural
 *    break that must be applied across `Positive`, `Verify.positive`, and a future `Negative`
 *    together, with a release note.
 *
 * 2. **`NaN` satisfies every numeric constraint.** The originals test `value < min` / `value > max`,
 *    and every comparison with `NaN` is `false`, so `NaN` never triggers a violation. The
 *    derivations below are therefore written as `!(value < min)` rather than the more obvious
 *    `value >= min` — those two agree on every input except `NaN`. Writing `>=` here would have
 *    been a silent behavioural change smuggled in under a refactor. Flagged as a new open question;
 *    the type guards planned for P3.3 are the right place to settle it.
 */

import {defineConstraint, JsonObject, Predicate} from '../Core/Descriptor';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Inclusive lower bound. */
export interface MinParams extends JsonObject {
    min: number;
}

/** Inclusive upper bound. */
export interface MaxParams extends JsonObject {
    max: number;
}

// ---------------------------------------------------------------------------
// Derivations — the single source each predicate comes from (DEC-010)
// ---------------------------------------------------------------------------

/**
 * `min` is inclusive. Shared by `min` and `positive` so the two cannot diverge: `Positive()` is
 * literally an inclusive lower bound of zero, which is precisely what makes Q-1 visible in the
 * data rather than buried in a closure.
 */
const atLeast = (params: Readonly<MinParams>): Predicate =>
    (value: unknown) => !((value as number) < params.min);

/** `max` is inclusive. */
const atMost = (params: Readonly<MaxParams>): Predicate =>
    (value: unknown) => !((value as number) > params.max);

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const minConstraint = defineConstraint<MinParams>({
    kind: 'number',
    constraint: 'min',
    derive: atLeast,
    describe: params => `a number greater than or equal to ${params.min}`,
});

export const maxConstraint = defineConstraint<MaxParams>({
    kind: 'number',
    constraint: 'max',
    derive: atMost,
    describe: params => `a number less than or equal to ${params.max}`,
});

/**
 * A distinct identity from `min`, despite sharing its derivation and params.
 *
 * The identity is what a documentation projection *names* ("must be positive"), while `params.min`
 * is what a schema projection *reads* (`{"minimum": 0}`). Collapsing `Positive()` into
 * `min({min: 0})` would lose the former; giving it its own hand-written predicate would reopen the
 * drift risk. Sharing `atLeast` keeps one source for the check and preserves the original message.
 */
export const positiveConstraint = defineConstraint<MinParams>({
    kind: 'number',
    constraint: 'positive',
    derive: atLeast,
    describe: () => 'a positive number',
});

// ---------------------------------------------------------------------------
// Constraint factories — the authoring surface
// ---------------------------------------------------------------------------

/**
 * Rejects values below `min`; `min` itself passes.
 * Ports `GreaterThanEqual` from `src/ParameterDecorators/Constraints.ts`.
 */
export function GreaterThanEqual(min: number) {
    return minConstraint({min});
}

/**
 * Rejects values above `max`; `max` itself passes.
 * Ports `LessThanEqual` from `src/ParameterDecorators/Constraints.ts`.
 */
export function LessThanEqual(max: number) {
    return maxConstraint({max});
}

/**
 * Rejects values below zero. **Accepts `0`** — see the module note and ISSUES.md Q-1.
 * Ports `Positive` from `src/ParameterDecorators/Constraints.ts`.
 */
export function Positive() {
    return positiveConstraint({min: 0});
}
