/**
 * O1c — the disclosure resolver (DEC-036, plan §7 / Q-24).
 *
 * ## One resolver, so the emitter and the projection can never disagree (DEC-006)
 *
 * A value's telemetry disclosure is resolved by composing **three** inputs — the `@Sensitive` veto, the
 * `@Telemetry` opt-in, and the global `setValueDisclosure` switch — into one {@link ParameterDisclosure}
 * decision. That decision is read by TWO consumers: `ObservationBehavior` renders per-call `EmittedValue`s
 * from it, and `Projections/telemetry` renders the "what leaves the process" table from it. If each
 * re-implemented the composition they would drift — a projection could report `[REDACTED]` for a position
 * the emitter discloses, the exact "documented one thing, did another" failure the project rejects. So the
 * composition lives here once, and both consumers call it.
 *
 * ## Layering (DEC-012) — decorator-agnostic Core
 *
 * This reads the registry's sensitivity and telemetry bands and the global disclosure switch. It imports
 * **no decorator type** and touches no `target`/`propertyKey`-as-a-decorator-would; a `target` here is a
 * plain prototype/constructor, exactly as everywhere else in the registry. That is what lets the privacy
 * projection depend on it while staying Core-only. The actual redaction *rendering* is `ObservationBehavior`'s
 * job (adapter-side); this module only decides.
 *
 * ## Safe-by-default, and the veto surfaced not silenced (DEC-025 / Q-24 R8)
 *
 * The default is `'deny'` — nothing said, nothing leaves (the DEC-016 inversion: silent *exclusion*, never
 * silent inclusion). `@Sensitive` can only ever *remove* disclosure, and when it vetoes an **explicit**
 * `@Telemetry` opt-in the result carries `vetoed: true` so a caller can announce the collision rather than
 * present an indistinguishable placeholder. There is deliberately no force-override — a per-parameter switch
 * defeating `@Sensitive` is the silent-inclusion foot-gun DEC-025 forbids.
 */

import {ContractTarget, MethodKey} from './ContractRegistry';
import {
    getEffectiveClassSensitivity,
    getEffectiveFieldSensitivity,
    getEffectiveParameterTelemetry,
    getEffectiveReturnTelemetry,
    getParameterSensitivity,
    TelemetryMarking,
} from './ContractRegistry';
import {getValueDisclosure} from './redaction';
import {ParameterDisclosure} from './Observation';

/**
 * The resolved disclosure for one position, plus the provenance a caller needs to surface the veto and
 * render the projection's row states. `disclosure` is what the per-call renderer applies; the other flags
 * describe *why*, and never re-derive policy on the hot path — this is computed once.
 */
export interface ResolvedDisclosure {
    /** `'deny'` | `'value'` | `{redact}` — the decision the per-call renderer applies. */
    readonly disclosure: ParameterDisclosure;
    /** `@Sensitive` is in force on this position (via the parameter/return/class band). */
    readonly sensitive: boolean;
    /** An explicit `@Telemetry` opt-in existed (whether or not it survived the veto). */
    readonly declared: boolean;
    /** An explicit opt-in was overridden by `@Sensitive` — surface, do not silence (Q-24 R8). */
    readonly vetoed: boolean;
    /** The explicit-name hatch from the marking (DEC-OBS-4), when supplied. */
    readonly name?: string;
}

/** Compose the three inputs into a decision. The one place the resolver's precedence lives. */
function resolve(sensitive: boolean, declared: TelemetryMarking | undefined): ResolvedDisclosure {
    // The veto wins first, always (DEC-025). Distinguish a veto-of-an-explicit-opt-in (surfaced) from a
    // plain sensitive position with no opt-in (nothing to surface).
    if (sensitive) {
        return {disclosure: 'deny', sensitive: true, declared: !!declared, vetoed: !!declared, name: declared?.name};
    }
    if (declared) {
        // The per-parameter production opt-in: 'value' emits the value, {redact} emits a surrogate.
        return {disclosure: declared.disclose, sensitive: false, declared: true, vetoed: false, name: declared.name};
    }
    // Nothing declared: the global local-debug switch is the only remaining way a value discloses, and it
    // never reaches a `@Sensitive` position (handled above). Otherwise deny — THE default.
    if (getValueDisclosure() === 'all') {
        return {disclosure: 'value', sensitive: false, declared: false, vetoed: false};
    }
    return {disclosure: 'deny', sensitive: false, declared: false, vetoed: false};
}

/** Whether parameter `index` of `target[key]` is `@Sensitive`, honouring class-level and inherited marks. */
function parameterSensitive(target: ContractTarget, key: MethodKey, index: number): boolean {
    const owner =
        typeof target === 'function' ? target : (target as {constructor?: Function}).constructor;
    if (typeof owner === 'function' && getEffectiveClassSensitivity(owner)) return true;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        if (getParameterSensitivity(cursor, key, index)) return true;
    }
    return false;
}

/** Whether the return of `target[key]` is `@Sensitive`, honouring class-level and inherited marks. */
function returnSensitive(target: ContractTarget, key: MethodKey): boolean {
    const owner =
        typeof target === 'function' ? target : (target as {constructor?: Function}).constructor;
    if (typeof owner === 'function' && getEffectiveClassSensitivity(owner)) return true;
    return !!getEffectiveFieldSensitivity(target, key);
}

/** Resolve the telemetry disclosure in force on parameter `index` of `target[key]`. */
export function resolveParameterDisclosure(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): ResolvedDisclosure {
    return resolve(parameterSensitive(target, key, index), getEffectiveParameterTelemetry(target, key, index));
}

/** Resolve the telemetry disclosure in force on the return of `target[key]`. */
export function resolveReturnDisclosure(target: ContractTarget, key: MethodKey): ResolvedDisclosure {
    return resolve(returnSensitive(target, key), getEffectiveReturnTelemetry(target, key));
}
