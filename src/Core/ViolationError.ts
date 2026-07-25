/**
 * O1b — the structured error a reified precondition throws (DEC-035, plan §6).
 *
 * ## Carry the facts, not the string
 *
 * The one choke point where a contract violation is caught at the method boundary is
 * `enforcementBehavior`'s `catch` in `ContractInstaller.ts`. By the time a plain `Error` reaches there,
 * the constraint identity, params, kind, and parameter index — all in scope back in `descriptorCheck`
 * — have been dissolved into a rendered message string. Emitting structured telemetry from the catch
 * would mean *re-parsing that string*, the exact anti-pattern this project rejects.
 *
 * So `descriptorCheck` throws a `ViolationError` that keeps its message **byte-for-byte unchanged**
 * (every existing violation-message test and the DEC-030 redaction behaviour are untouched) but
 * additionally carries frozen {@link ViolationFactsSource} — assembled from data already in scope, with
 * **no value and no rendered string** in the facts, so deny-by-default holds at the source. The
 * enforcement site adds `trust`/`blame` (which live there, not at the check) when it emits.
 *
 * ## Internal
 *
 * This class is **not** exported from the package. Consumers receive facts through the observation sink,
 * not by catching a typed error; exporting it would widen the semver surface with no consumer (Q-6).
 * It is a plain `Error` subclass, so it satisfies `instanceof Error`, `applyViolationPolicy`'s
 * `Error`-shaped handling, and `DecoratorFactory.attributeToCaller`'s stack re-pointing unchanged.
 */

import type {ViolationFacts} from './Observation';

/**
 * The facts known at the *source* of a precondition violation. `trust` and `blame` are properties of
 * the enforcement site, not of the check, so they are absent here and completed at emit time in
 * `enforcementBehavior` (`{...error.facts, trust, blame: 'caller'}`).
 */
export type ViolationFactsSource = Omit<ViolationFacts, 'trust' | 'blame'>;

/**
 * A contract-precondition violation carrying its reified {@link ViolationFactsSource}. The `message` is
 * identical to the pre-O1b `new Error(message)` a `descriptorCheck` threw.
 */
export class ViolationError extends Error {
    readonly facts: ViolationFactsSource;

    constructor(message: string, facts: ViolationFactsSource) {
        super(message);
        this.name = 'ViolationError';
        // Frozen so a downstream handler cannot mutate the facts out from under a later sink.
        this.facts = Object.freeze({...facts});
    }
}
