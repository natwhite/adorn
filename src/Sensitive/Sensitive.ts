/**
 * `@Sensitive` — a record-only marker for sensitive data (DEC-PII-1, DEC-PII-2).
 *
 * ## What this is, and — just as important — what it is not
 *
 * `@Sensitive` *marks*. It records into {@link ContractRegistry}'s sensitivity band that a field,
 * a parameter, or a whole class holds sensitive data. It does **not** redact. Nothing about a
 * value's runtime behaviour changes: a `@Sensitive` field is still an ordinary readable property,
 * a `@Sensitive` parameter is still an ordinary parameter. Redaction — safe-by-default emission
 * from `@Log` and violation messages (BUG-18/BUG-19) — is a **separate, later** piece that reads
 * these markings; it is deliberately not built here.
 *
 * Two things consume the marking today:
 *   - the build-time detector (`tools/sensitive-flow/`), which reports where a `@Sensitive` value
 *     reaches one of adorn's own emitters, and
 *   - a future exposure report (a pure registry read).
 *
 * ## The honest boundary (DEC-025)
 *
 * adorn secures **its own** emissions. Marking `User.ssn` lets adorn's `@Log` and violation
 * messages redact it once the redaction runtime lands — it does **not** make a raw
 * ``console.log(`${user.ssn}`)`` safe. That call is the developer's, adorn was never in its path,
 * and no library can intercept it. See `docs/sensitive.md`.
 *
 * ## Placement — one decorator, three targets
 *
 * A single legacy decorator that resolves its target from its argument shape, which is how TypeScript
 * distinguishes a class / field / parameter decorator at the call site:
 *
 *   - `@Sensitive() class PaymentInstrument {}`   → marks the whole class (every field).
 *   - `@Sensitive() ssn: string`                  → marks the field.
 *   - `method(@Sensitive() ssn: string) {}`       → marks the parameter (the only answer for a
 *                                                    primitive parameter — DEC-PII-5).
 *
 * ## Inheritance-safety, for free (DEC-021)
 *
 * A `@Sensitive` field marking is stored own-scoped and resolved by a prototype-chain union, the same
 * mechanism DEC-021 gave field constraints. So a subclass **cannot un-mark** an inherited sensitive
 * field — weakening is unexpressible, not merely rejected. This is not a parallel mechanism; it is the
 * field band's own inheritance shape reused for a new datum. See {@link getEffectiveFieldSensitivity}.
 *
 * ## Forward-compatible shape (DEC-PII-2)
 *
 * The marking is a small object with a `level`, not a bare boolean. The pii-redaction plan proposes a
 * three-valued lattice (`Safe`/`Unsafe`/`DoNotLog`, after Palantir `safe-logging`). That behaviour is
 * not built here, but the stored shape has room for it: {@link SensitiveOptions} carries an optional
 * `level`, defaulting to `'sensitive'`, so the later runtime widens the level set with no migration.
 */

import {
    recordClassSensitivity,
    recordFieldSensitivity,
    recordParameterSensitivity,
    SensitivityLevel,
    SensitivityMarking,
} from '../Core/ContractRegistry';

/**
 * Options for {@link Sensitive}.
 *
 * `level` exists so the three-valued design can land without changing this signature. Today the only
 * admissible value is `'sensitive'` (the default), so the option is effectively inert — it is present
 * for forward compatibility, not to expose an unfinished feature.
 */
export interface SensitiveOptions {
    readonly level?: SensitivityLevel;
}

/**
 * The method key a constructor parameter's marking is recorded under. Constructor-parameter decorators
 * receive `propertyKey === undefined`; a dedicated symbol keeps such markings from colliding with a
 * real method literally named `'constructor'`.
 */
const CONSTRUCTOR_PARAMETERS: unique symbol = Symbol('adorn.sensitive.constructor');

/**
 * Mark a field, parameter, or class as holding sensitive data (record-only).
 *
 * @param options forward-compatible marking options; today only the default `level: 'sensitive'`
 *                is meaningful.
 */
export function Sensitive(
    options?: SensitiveOptions,
): (target: object, propertyKey?: string | symbol, parameterIndex?: number) => void {
    const marking: SensitivityMarking = {level: options?.level ?? 'sensitive'};

    return function (target: object, propertyKey?: string | symbol, parameterIndex?: number): void {
        // Parameter decorator: (target, propertyKey, index). A constructor parameter arrives with
        // propertyKey === undefined, so key off the numeric index rather than the presence of a key.
        if (typeof parameterIndex === 'number') {
            const key: string | symbol = propertyKey ?? CONSTRUCTOR_PARAMETERS;
            recordParameterSensitivity(target, key, parameterIndex, marking);
            return;
        }

        // Field / property decorator: (target, propertyKey).
        if (propertyKey !== undefined) {
            recordFieldSensitivity(target, propertyKey, marking);
            return;
        }

        // Class decorator: (target) — the sole argument is the constructor.
        if (typeof target === 'function') {
            recordClassSensitivity(target, marking);
        }
    };
}
