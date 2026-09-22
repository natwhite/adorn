/**
 * The enabledness evaluator (`@EnabledWhen`, DEC-089) — the state-reading, receiver-aware twin of
 * `./Preconditions.ts`.
 *
 * {@link evaluateEnabledness} is the ONE oracle both the runtime wrapper (`ContractInstaller`) and the
 * future stateful-sequence driver call, against a LIVE receiver — so "is this operation enabled in this
 * state?" means byte-for-byte the same thing in enforcement and in testing (DEC-006, no drift). Logic,
 * not storage: the {@link EnablednessGuard} data lives in `ContractRegistry`; this module imports only
 * the stored shape.
 */

import {EnablednessGuard} from './ContractRegistry';

/**
 * The verdict {@link evaluateEnabledness} returns. A discriminated union on `ok`, the twin of
 * {@link import('./Preconditions').PreconditionResult}: the failure arm carries the first guard that did
 * not hold, plus — crucially — the value it threw **if it threw rather than cleanly returning false**.
 * That `error` field is what lets a consumer distinguish the two failure modes (see below): a clean
 * `false` is an expected not-enabled skip; a throw is a guard defect (a finding).
 */
export type EnablednessResult =
    | {readonly ok: true}
    | {
          readonly ok: false;
          /** The first enabledness guard that did not hold. */
          readonly failed: EnablednessGuard;
          /** The value the failing guard threw, if it threw rather than returning false. */
          readonly error?: unknown;
      };

/**
 * Evaluate every enabledness guard against the live receiver and the call's arguments. First failure
 * wins, and because {@link getEffectiveEnablednessGuards} orders them base-most first, the reported
 * failure is the most general broken guard (matching DEC-022 ordering).
 *
 * A guard that **throws** is caught here (so this shared oracle is total and never surprises the driver),
 * but the thrown value is preserved on `error` so the caller can tell a throw from a clean `false`. The
 * *policy* for what a throw means — an expected skip vs. a guard-defect finding at runtime — is the
 * caller's (enforcement rethrows it as an author fault; the future driver raises a finding); this
 * function only reports the verdict. `self` is the receiver (`this`), `args` the method's arguments.
 */
export function evaluateEnabledness(
    guards: ReadonlyArray<EnablednessGuard>,
    self: unknown,
    args: ReadonlyArray<unknown>,
): EnablednessResult {
    for (const guard of guards) {
        let satisfied = false;
        let error: unknown;
        try {
            satisfied = guard.predicate(self, ...(args as unknown[]));
        } catch (thrown) {
            satisfied = false;
            error = thrown;
        }
        if (!satisfied) return {ok: false, failed: guard, error};
    }
    return {ok: true};
}

/**
 * Build the message for a call that is not enabled in the current state. The phrasing frames **caller**
 * fault — the caller invoked an operation the object's state does not currently permit — and the distinct
 * `"Not enabled:"` prefix (vs `"Precondition failed:"` / `"Value Error:"`) keeps the bands tellable-apart
 * in logs. Values are deliberately **not** rendered (redaction, DEC-030); the author's `description` is
 * the legible signal, so an `@EnabledWhen` that carries one reads far better than one that does not.
 */
export function enablednessMessage(owner: string, member: string, failed: EnablednessGuard): string {
    const clause = failed.description ? `the guard "${failed.description}"` : 'its enabledness guard';
    return `Not enabled: ${owner}.${member} is not enabled in the current state (${clause} is not satisfied)`;
}
