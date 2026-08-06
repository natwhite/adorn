/**
 * The precondition evaluator (IDEA-26 / DEC-057) — the input-side twin of `./Postconditions.ts`.
 *
 * {@link evaluatePreconditions} is the ONE oracle both the runtime wrapper (`ContractInstaller`) and a
 * fuzz driver call, so the check the fuzzer uses to FILTER generated arguments is byte-for-byte the one
 * enforcement runs — no drift (DEC-006). Logic, not storage: the {@link Precondition} data lives in
 * `ContractRegistry`; this module imports only the stored shape.
 */

import {Precondition} from './ContractRegistry';

/**
 * The verdict {@link evaluatePreconditions} returns. Flat rather than a `{ok:true} | {ok:false}`
 * discriminated union for the same reason {@link import('./Postconditions').PostconditionResult} is:
 * this project compiles with `strict: false`, under which TypeScript does not narrow a boolean
 * discriminant. `v.failed`/`v.error` are populated only when `ok` is `false`.
 */
export interface PreconditionResult {
    readonly ok: boolean;
    /** The first precondition that did not hold. Present iff `ok` is `false`. */
    readonly failed?: Precondition;
    /** The value the failing predicate threw, if it threw rather than returning falsy. */
    readonly error?: unknown;
}

/**
 * Evaluate every precondition against the call's arguments. First failure wins, and because
 * {@link getEffectivePreconditions} orders them base-most first, the reported failure is the most
 * general broken requirement (matching DEC-021/DEC-022 ordering).
 *
 * A predicate that **throws** counts as a failure, not as a method error: the requirement could not be
 * established, so the outcome is `{ok: false}` with the thrown value on `error`. `args` are the arguments
 * the method actually received, spread so a predicate reads `(...args)`.
 */
export function evaluatePreconditions(
    pres: ReadonlyArray<Precondition>,
    args: ReadonlyArray<unknown>,
): PreconditionResult {
    for (const pre of pres) {
        let satisfied = false;
        let error: unknown;
        try {
            satisfied = pre.predicate(...(args as unknown[]));
        } catch (thrown) {
            satisfied = false;
            error = thrown;
        }
        if (!satisfied) return {ok: false, failed: pre, error};
    }
    return {ok: true};
}

/**
 * Build the violation message for a failed precondition. The phrasing frames **caller** fault — a
 * precondition guards untrusted input, so the blame is the call's, not the method's.
 *
 * The arguments are deliberately **not** rendered: a cross-parameter precondition relates several, and
 * they are untrusted input that redacts by default (DEC-030). The author's `description` is the legible
 * signal instead — so a `@Requires` that carries one reads far better than one that does not.
 */
export function preconditionMessage(owner: string, member: string, failed: Precondition): string {
    const clause = failed.description ? `the precondition "${failed.description}"` : 'its precondition';
    return `Precondition failed: ${owner}.${member} did not satisfy ${clause}`;
}
