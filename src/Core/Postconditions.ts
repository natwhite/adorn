/**
 * The postcondition evaluator (Q-11, plan B §2.5).
 *
 * ## One evaluator, two consumers — this is the whole point
 *
 * {@link evaluatePostconditions} is called by BOTH the runtime wrapper (`ContractInstaller`'s
 * enforcement seam) and — in a later phase — the fuzz driver. That single shared call is what
 * guarantees the oracle the fuzzer *checks* is byte-for-byte the oracle the wrapper *enforces*: the
 * two can never disagree about what "the postcondition held" means, because there is exactly one
 * implementation of "held" (DEC-006, "one declaration, two consumers, no drift"). Phase B (the
 * fuzzer) imports this function directly rather than re-deriving the check.
 *
 * ## Layering (DEC-012)
 *
 * Logic, not storage. The {@link Postcondition} *data* lives in `ContractRegistry`; evaluation and
 * message-building live here, so the registry stays storage-only and decorator-agnostic. This module
 * imports only the stored shape and the redaction constants — never a decorator, never the config.
 */

import {Postcondition} from './ContractRegistry';
import {REDACTED, shouldDiscloseValue} from './redaction';

/**
 * The verdict {@link evaluatePostconditions} returns. A discriminated union on `ok`: the success arm
 * carries nothing (the caller still holds the result and the args), the failure arm carries the first
 * postcondition that did not hold plus the value it threw if it threw rather than returning falsy — both
 * for the violation message and the fuzzer's counterexample report.
 *
 * A proper `{ok:true} | {ok:false, failed}` union rather than the former flat `{ok:boolean, failed?}`
 * shape: since DEC-079 this project compiles under `strict`, so a boolean-discriminant union narrows
 * (`if (!v.ok) { v.failed }` type-checks) and the union states precisely that `failed` is present exactly
 * when `ok` is `false` — no optional field that a consumer could read on the success path.
 */
export type PostconditionResult =
    | {readonly ok: true}
    | {
          readonly ok: false;
          /** The first postcondition that did not hold. */
          readonly failed: Postcondition;
          /** The value the failing predicate threw, if it threw rather than returning falsy. */
          readonly error?: unknown;
      };

/**
 * Evaluate every postcondition against one outcome. First failure wins, and because
 * {@link getEffectivePostconditions} orders them base-most first, the reported failure is the most
 * general broken guarantee (matching DEC-021/DEC-022 ordering).
 *
 * A predicate that **throws** counts as a failure, not as a method error: the guarantee could not be
 * established, so the outcome is `{ok: false}` with the thrown value on `error`. This keeps a bug in
 * a postcondition predicate from masquerading as the method throwing.
 *
 * `args` are the arguments the method actually received (`context.args`), spread after the result so a
 * predicate reads `(result, ...args)`.
 */
export function evaluatePostconditions(
    posts: ReadonlyArray<Postcondition>,
    result: unknown,
    args: ReadonlyArray<unknown>,
): PostconditionResult {
    for (const post of posts) {
        let satisfied = false;
        let error: unknown;
        try {
            satisfied = post.predicate(result, ...(args as unknown[]));
        } catch (thrown) {
            satisfied = false;
            error = thrown;
        }
        if (!satisfied) return {ok: false, failed: post, error};
    }
    return {ok: true};
}

/**
 * Build the violation message for a failed postcondition.
 *
 * Redacts the returned value by default (DEC-030). A method return carries no `@Sensitive` marking
 * (Q-23), so disclosure follows the global switch alone — exactly what `Verify.that` passes for an
 * imperative check (`shouldDiscloseValue(false)`). Absent/off ⇒ `[REDACTED]`;
 * `setValueDisclosure('all')` ⇒ the raw value. Zero new redaction surface.
 *
 * The phrasing frames **callee** fault: a postcondition failure is a bug in the method, not in the
 * call (the blame is also carried structurally on the `ViolationSite`, plan A §5.1).
 */
export function postconditionMessage(
    owner: string,
    member: string,
    failed: Postcondition,
    result: unknown,
): string {
    const clause = failed.description ? `the postcondition "${failed.description}"` : 'its postcondition';
    const shown = shouldDiscloseValue(false) ? String(result) : REDACTED;
    return `Postcondition failed: ${owner}.${member} did not satisfy ${clause}; returned ${shown}`;
}
