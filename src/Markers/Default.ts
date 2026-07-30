/**
 * `@Default(value)` — a record-only parameter marker that annotates a default and implies `@Optional`
 * (DEC-051).
 *
 * ## What it does
 *
 *   - **Records a default** (`recordParameterDefault`) so `toolSchemaForMethod` emits `{default: value}`
 *     into the parameter's schema fragment.
 *   - **Implies optionality** (`recordParameterOptional`): a defaulted parameter may be absent, so
 *     `@Default` also marks the position `@Optional` from the one declaration — the installer skips it
 *     when the argument is `undefined`, and the tool schema drops it from `required`. This synergy is
 *     the whole point of pairing them.
 *
 * ## adorn does NOT inject the default at runtime — decided, and stated (M1)
 *
 * `@Default` **annotates**; it does not apply. adorn is a contract/validation library, not an
 * argument-injection framework: injecting the value would rewrite the `args` tuple that enforcement,
 * `@Observe`, and postconditions all see, turning a record-only marker into a hidden behaviour change —
 * exactly what the marker bands forbid. So at runtime an absent defaulted parameter is simply *skipped*
 * by the `@Optional` mechanism, and the method body sees whatever JS (or the host framework) supplies —
 * `undefined` unless the method declares its own JS default. The default reaches a consumer only through
 * the emitted schema; the host applies it.
 *
 * This is safe to emit even into a **prescriptive** tool schema because JSON Schema's `default` is a
 * **non-asserting annotation** (a validator ignores it), so — unlike an unbacked `format` — it can never
 * cause a false rejection in either schema posture (M1).
 *
 * ## Authoring validation
 *
 * `value` must be JSON-serialisable, checked here at decoration time so the emitted `{default}` is always
 * valid JSON — a non-serialisable value (a function, a class instance, `undefined`, `NaN`/`Infinity`, a
 * symbol) throws with an author-facing origin rather than producing a lossy or invalid fragment later.
 */

import {JsonValue} from '../Core/Descriptor';
import {MethodKey, recordParameterDefault, recordParameterOptional} from '../Core/ContractRegistry';

/**
 * The method key a constructor parameter's marking is recorded under — see the note on the same symbol
 * in `Markers/Optional.ts`. `@Default` uses one key for both of its recordings (default + optional) so
 * they always land on the same `(key, index)`.
 */
const CONSTRUCTOR_PARAMETERS: unique symbol = Symbol('adorn.default.constructor');

/**
 * Whether `value` is a plain JSON value — a string, a finite number, a boolean, `null`, an array of
 * such, or a plain object whose every property is such. `undefined`, functions, symbols, `bigint`,
 * `NaN`/`Infinity`, and non-plain objects (class instances, `Date`, `Map`, `RegExp`) are rejected: each
 * either drops out of `JSON.stringify` or serialises lossily, so none can be an honest `{default}`.
 */
function isJsonSerializable(value: unknown): value is JsonValue {
    if (value === null) return true;
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return true;
        case 'number':
            return Number.isFinite(value);
        case 'object': {
            if (Array.isArray(value)) return value.every(isJsonSerializable);
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) return false;
            return Object.values(value as Record<string, unknown>).every(isJsonSerializable);
        }
        default:
            return false; // undefined, function, symbol, bigint
    }
}

/**
 * Annotate a parameter with a default value and mark it `@Optional` (record-only). Emits
 * `{default: value}` into the tool schema; does **not** inject the value at runtime (see the module
 * note). `value` must be JSON-serialisable.
 *
 * Must be applied to a parameter — it throws if used anywhere else.
 */
export function Default(
    value: JsonValue,
): (target: object, propertyKey?: MethodKey, parameterIndex?: number) => void {
    if (!isJsonSerializable(value)) {
        throw new TypeError(
            '@Default(value): value must be JSON-serialisable (a string, finite number, boolean, null, ' +
                'or a plain array/object of those). A function, class instance, symbol, undefined, or ' +
                'NaN/Infinity cannot be emitted as a JSON Schema default.',
        );
    }

    return function (target: object, propertyKey?: MethodKey, parameterIndex?: number): void {
        if (typeof parameterIndex !== 'number') {
            throw new TypeError('@Default() must be applied to a parameter.');
        }
        const key: MethodKey = propertyKey ?? CONSTRUCTOR_PARAMETERS;
        recordParameterDefault(target, key, parameterIndex, value);
        // A default implies the parameter may be absent — mark it optional from the one declaration, so
        // both the installer (skip-when-absent) and the tool schema (drop from `required`) agree.
        recordParameterOptional(target, key, parameterIndex);
    };
}
