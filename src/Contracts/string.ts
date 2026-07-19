/**
 * String constraints, as descriptors (P1.0 / plan §2).
 *
 * Decorator-agnostic (DEC-012) — see the note in `./number.ts`. Wiring these into the existing
 * decorators is P1.3 and is deliberately not done here.
 *
 * ## Semantics are ported verbatim, including a known defect
 *
 * The predicate reproduces the exact condition of the closure it replaces in
 * `src/ParameterDecorators/Constraints.ts`, which means it **dereferences `.length` with no
 * guard**. A `null` or `undefined` value therefore raises a bare `TypeError` rather than a
 * contract violation — ISSUES.md **BUG-4**.
 *
 * That is preserved rather than fixed here on purpose. Adding a guard changes what happens on
 * `null` from "TypeError" to "contract violation", which is a behavioural change, and P3.3 owns
 * adding null/type guards *uniformly across the whole constraint set* rather than one-off in the
 * one constraint that happened to be ported first. A test below pins the current behaviour so the
 * fix is a visible, deliberate flip.
 *
 * Consequence worth knowing before then: a predicate that can *throw* rather than return `false`
 * is a hazard for any projection that evaluates it (a fuzzer especially). The guards in P3.3 are
 * what make predicates total.
 */

import {defineConstraint, JsonObject, Predicate} from '../Core/Descriptor';

/** Inclusive minimum length. */
export interface MinLengthParams extends JsonObject {
    minLength: number;
}

/**
 * `minLength` is inclusive: a string of exactly `minLength` passes.
 *
 * No null guard — see the module note (BUG-4).
 */
const atLeastLength = (params: Readonly<MinLengthParams>): Predicate =>
    (value: unknown) => !((value as string).length < params.minLength);

export const minLengthConstraint = defineConstraint<MinLengthParams>({
    kind: 'string',
    constraint: 'minLength',
    derive: atLeastLength,
    // Wording preserved verbatim from the original closure. It says "greater than" while the check
    // is inclusive — inaccurate, but changing every error string is P3.1's job, not a side effect
    // of this port.
    describe: params => `a string of length greater than ${params.minLength}`,
});

/**
 * Rejects strings shorter than `minLength`; a string of exactly `minLength` passes.
 * Ports `StringMinLength` from `src/ParameterDecorators/Constraints.ts`.
 */
export function MinLength(minLength: number) {
    return minLengthConstraint({minLength});
}

/**
 * Alias under the name the existing decorator uses, so P1.3 has an unambiguous mapping.
 * `MinLength` is the canonical name in this layer — the module is already `string`.
 */
export const StringMinLength = MinLength;
