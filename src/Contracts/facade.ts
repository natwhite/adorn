/**
 * `Contracts` — the fluent facade over the descriptor namespaces (DEC-094).
 *
 * The seven `*Contracts` module namespaces (`NumberContracts.Between`, `NullableContracts.Nullable`, …) are the
 * canonical descriptor factories. This is a thin, **additive** re-grouping of exactly those functions under one
 * entry object with lowercase, type-grouped names. Nothing new is constructed here — every member is a direct
 * reference to an existing factory, so the facade cannot drift from the namespaces: there is no second
 * implementation, only a second spelling. The underlying namespaces stay exported and unchanged.
 *
 * It exists because, once the descriptor path is a first-class authoring surface rather than an escape hatch
 * (DEC-062/093), `Contracts.number.between(1, 10)` / `Contracts.nullable(item)` reads as one algebra, and it
 * removes the `NullableContracts.Nullable` / `ArrayContracts.ArrayOf` namespace stutter.
 */
import * as NumberContracts from './number';
import * as StringContracts from './string';
import * as BooleanContracts from './boolean';
import * as EnumContracts from './enum';
import * as ArrayContracts from './array';
import * as ObjectContracts from './object';
import * as NullableContracts from './nullable';

/**
 * One fluent entry point onto the descriptor factories — the same descriptors the `*Contracts` namespaces
 * expose, grouped by the type they constrain and named without the namespace stutter (DEC-094). A member is
 * usable anywhere a descriptor is: `Verify.check`, `contract()`, `toolSchemaFrom`, `CreateFieldDecorator`,
 * `@ArrayOf`, `@Nullable`, custom-constraint composition.
 *
 * ```ts
 * Contracts.number.between(1, 10)                 // NumberContracts.Between(1, 10)
 * Contracts.string.notEmpty()                     // StringContracts.NotEmpty()
 * Contracts.enum(['celsius', 'fahrenheit'])       // EnumContracts.OneOf([...])
 * Contracts.array(Contracts.string.uuid())        // ArrayContracts.ArrayOf(StringContracts.Uuid())
 * Contracts.nullable(Contracts.number.finite())   // NullableContracts.Nullable(...)
 * Contracts.object({ name: Contracts.string.notEmpty() })  // ObjectContracts.Fields({...})
 * ```
 */
export const Contracts = {
    /** Numeric descriptors — {@link NumberContracts}. */
    number: {
        greaterThan: NumberContracts.GreaterThan,
        greaterThanEqual: NumberContracts.GreaterThanEqual,
        lessThan: NumberContracts.LessThan,
        lessThanEqual: NumberContracts.LessThanEqual,
        between: NumberContracts.Between,
        integer: NumberContracts.Integer,
        finite: NumberContracts.Finite,
        multipleOf: NumberContracts.MultipleOf,
    },
    /** String descriptors — {@link StringContracts}. */
    string: {
        notEmpty: StringContracts.NotEmpty,
        str: StringContracts.Str,
        minLength: StringContracts.MinLength,
        maxLength: StringContracts.MaxLength,
        matches: StringContracts.Matches,
        email: StringContracts.Email,
        url: StringContracts.Url,
        uuid: StringContracts.Uuid,
        dateTime: StringContracts.DateTime,
        ipv4: StringContracts.Ipv4,
        format: StringContracts.Format,
    },
    /** The boolean primitive — {@link BooleanContracts.Bool}. */
    bool: BooleanContracts.Bool,
    /** Enum / membership over a fixed value set — {@link EnumContracts.OneOf}. */
    enum: EnumContracts.OneOf,
    /** Single-literal constant — {@link EnumContracts.Const}. */
    const: EnumContracts.Const,
    /** Array whose elements satisfy an inner descriptor — {@link ArrayContracts.ArrayOf}. */
    array: ArrayContracts.ArrayOf,
    /** Null-widening combinator over an inner descriptor — {@link NullableContracts.Nullable}. */
    nullable: NullableContracts.Nullable,
    /** Open string-keyed map of a value descriptor — {@link ObjectContracts.Dictionary}. */
    dictionary: ObjectContracts.Dictionary,
    /** Closed object from a field-spec literal (optional-aware) — {@link ObjectContracts.Fields}. */
    object: ObjectContracts.Fields,
    /** Closed object from a contracted field class — {@link ObjectContracts.Shape}. */
    shape: ObjectContracts.Shape,
};
