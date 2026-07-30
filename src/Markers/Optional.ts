/**
 * `@Optional` — an enforcement-aware, record-only marker on a parameter (DEC-051).
 *
 * ## What it does
 *
 * `@Optional()` records into {@link ContractRegistry}'s optional band that an **absent** argument
 * satisfies that position. It has two synchronised effects, both derived from the *one* declaration:
 *
 *   - **Enforcement** (`ParameterDecoratorFactory.planChecks`): the position's checks are skipped
 *     **iff the argument is `undefined`**. A present value — including `null` — runs every check as
 *     usual, so an optional-but-constrained parameter is either wholly skipped (absent) or wholly
 *     checked (present). `null` is **not** absent (that is a `@Nullable` concern, Wave 2).
 *   - **Tool schema** (`toolSchemaForMethod`): an effective-optional parameter is dropped from
 *     `required` while staying in `properties`.
 *
 * Both read the **same** effective resolution ({@link getEffectiveParameterOptional}), so the schema
 * can never say "omittable" while enforcement still throws on a missing argument — the drift DEC-051
 * exists to prevent (DEC-006).
 *
 * ## Inheritance is required-wins, NOT over-marking (DEC-016/DEC-022)
 *
 * `@Optional` is a precondition *weakening*, so — unlike `@Sensitive`, where over-marking is the safe
 * direction — it must never let a subclass silently weaken a value its base genuinely constrains. The
 * effective read is therefore "optional iff marked on ≥1 declaration AND no declaration on the chain
 * requires it"; see {@link getEffectiveParameterOptional} for the full rule and the invariants it pins.
 *
 * ## Record-only
 *
 * Like `@Sensitive`, this installs nothing and never enters an enforcement band directly; it is plain
 * registry data the installer and the projection read. Decorator-agnostic (DEC-012): the registry
 * learns the position *is optional*, never that a decorator named `@Optional` produced the marking.
 */

import {MethodKey, recordParameterOptional} from '../Core/ContractRegistry';

/**
 * The method key a constructor parameter's marking is recorded under. Constructor-parameter decorators
 * receive `propertyKey === undefined`; a dedicated symbol keeps such markings from colliding with a
 * real method literally named `'constructor'` — the same trick `@Sensitive` uses.
 */
const CONSTRUCTOR_PARAMETERS: unique symbol = Symbol('adorn.optional.constructor');

/**
 * Mark a parameter as optional (record-only). An absent (`undefined`) argument then satisfies the
 * position, and the tool schema drops it from `required`.
 *
 * Must be applied to a parameter — it throws if used anywhere else.
 */
export function Optional(): (target: object, propertyKey?: MethodKey, parameterIndex?: number) => void {
    return function (target: object, propertyKey?: MethodKey, parameterIndex?: number): void {
        if (typeof parameterIndex !== 'number') {
            throw new TypeError('@Optional() must be applied to a parameter.');
        }
        const key: MethodKey = propertyKey ?? CONSTRUCTOR_PARAMETERS;
        recordParameterOptional(target, key, parameterIndex);
    };
}
