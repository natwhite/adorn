/**
 * The built-in parameter constraints — thin adapters over reified descriptors (P1.3, expanded in
 * P3.3).
 *
 * Previously each of these was a closure that threw:
 *
 * ```ts
 * const Positive = () => simpleDecor((params: ParamObject<number>) => {
 *     if (params.value < 0) throw new Error(`...`);
 * });
 * ```
 *
 * You could run that; you could not ask it anything. Its identity (`min`) and its parameter (`0`)
 * existed only as instructions inside a function body, so no documentation line, JSON Schema
 * fragment, or value generator could ever be derived from it (DEC-006, plan §1.5).
 *
 * Each constraint delegates to a `ConstraintDescriptor` from `src/Contracts/`, where the predicate
 * is *derived* from the params rather than written alongside them (DEC-010). This file is a mapping
 * from decorator syntax onto the decorator-agnostic constraint model and nothing else: the
 * descriptors carry every semantic, this layer carries only the `@`-syntax. Adding a constraint here
 * that is not backed by a descriptor would make it invisible to all four projections (SMELL-14).
 *
 * ## What changed behaviourally
 *
 * Three deliberate breaks, all argued in `src/Contracts/number.ts` and `src/Contracts/string.ts`:
 *
 * 1. **`@Positive()`, `@Negative()`, `@NonNegative()` and `@NonPositive()` are removed**
 *    (ISSUES.md Q-1, DEC-020). Write the boundary you mean: `@GreaterThan(0)`, `@LessThan(0)`,
 *    `@GreaterThanEqual(0)`, `@LessThanEqual(0)`.
 * 2. **`NaN` now violates every numeric constraint** (Q-7). It previously satisfied all of them,
 *    because every comparison with `NaN` is `false`. So did `undefined`.
 * 3. **`null`/`undefined` on a string constraint now report a contract violation** naming the
 *    parameter, instead of raising a bare `TypeError` from inside adorn (BUG-4).
 *
 * ## These require `@Contract()` on the class
 *
 * ```ts
 * @Contract()
 * class Task {
 *     test(@StringMinLength(10) message: string) { ... }
 * }
 * ```
 *
 * Without it the constraints are recorded but never installed, and a development-mode warning names
 * the class (see `Adapters/legacy/ContractDiagnostics`).
 */

import {ParameterDecoratorFactory} from '../Adapters/legacy/ParameterDecoratorFactory';
import type {ConstraintDescriptor, JsonValue} from '../Core/Descriptor';
import * as Numbers from '../Contracts/number';
import * as Strings from '../Contracts/string';
import * as Enums from '../Contracts/enum';
import * as Arrays from '../Contracts/array';
import * as Objects from '../Contracts/object';
import * as Nullables from '../Contracts/nullable';

const constraintDecorator = ParameterDecoratorFactory.CreateConstraintDecorator;

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

/*
 * `@Positive()`, `@Negative()`, `@NonNegative()` and `@NonPositive()` were removed by DEC-020 —
 * see `src/Contracts/number.ts`. Use `@GreaterThan(0)`, `@LessThan(0)`, `@GreaterThanEqual(0)`
 * and `@LessThanEqual(0)`, which say which boundary they mean.
 */

/** Rejects values above `constraint`; `constraint` itself passes. */
const LessThanEqual = (constraint: number) => constraintDecorator(Numbers.LessThanEqual(constraint));

/** Rejects values below `constraint`; `constraint` itself passes. */
const GreaterThanEqual = (constraint: number) => constraintDecorator(Numbers.GreaterThanEqual(constraint));

/** Rejects values at or above `constraint` — the exclusive form of {@link LessThanEqual}. */
const LessThan = (constraint: number) => constraintDecorator(Numbers.LessThan(constraint));

/** Rejects values at or below `constraint` — the exclusive form of {@link GreaterThanEqual}. */
const GreaterThan = (constraint: number) => constraintDecorator(Numbers.GreaterThan(constraint));

/** Rejects values outside `[min, max]`. **Both bounds inclusive.** Throws at decoration if `min > max`. */
const Between = (min: number, max: number) => constraintDecorator(Numbers.Between(min, max));

/** Rejects non-integers. `1.5`, `Infinity`, and `NaN` all fail; `1.0` passes. */
const Integer = () => constraintDecorator(Numbers.Integer());

/** Rejects values that are not an exact multiple of `divisor`. `divisor` must be greater than zero. */
const MultipleOf = (divisor: number) => constraintDecorator(Numbers.MultipleOf(divisor));

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

/**
 * Rejects strings shorter than `constraint`; a string of exactly `constraint` passes.
 *
 * **BREAKING (P3.3):** a `null`, `undefined`, or non-string argument now produces a contract
 * violation naming the parameter, where it previously raised a bare `TypeError` (BUG-4).
 */
const StringMinLength = (constraint: number) => constraintDecorator(Strings.MinLength(constraint));

/** Canonical alias for {@link StringMinLength}, symmetrical with {@link MaxLength}. */
const MinLength = StringMinLength;

/** Rejects strings longer than `constraint`; a string of exactly `constraint` passes. */
const MaxLength = (constraint: number) => constraintDecorator(Strings.MaxLength(constraint));

/** Rejects the empty string. Length-based, so `'   '` passes — see `Contracts/string.ts`. */
const NotEmpty = () => constraintDecorator(Strings.NotEmpty());

/**
 * Rejects strings the pattern does not match. Anchoring is the author's business.
 *
 * The `g` and `y` flags are rejected at decoration time: `RegExp.test` advances `lastIndex` under
 * them, so the same value would validate differently on successive calls.
 */
const Matches = (pattern: RegExp | string, flags?: string) =>
    constraintDecorator(Strings.Matches(pattern, flags));

/** Rejects strings that do not look like an email address. Approximate by design — see P3.3. */
const Email = () => constraintDecorator(Strings.Email());

/**
 * Rejects strings that do not parse as an absolute URL with an accepted protocol.
 * Defaults to `http`/`https`; pass `protocols` to widen.
 */
const Url = (protocols?: string[]) => constraintDecorator(Strings.Url(protocols));

// ---------------------------------------------------------------------------
// String formats (IDEA-23) — VALIDATING; each emits {type:'string', format:'…'}
// ---------------------------------------------------------------------------

/** Rejects any string that is not a canonical UUID. Projects to `{type:'string', format:'uuid'}`. */
const Uuid = () => constraintDecorator(Strings.Uuid());

/**
 * Rejects any string that is not a strict RFC 3339 `date-time`. Projects to `{type:'string',
 * format:'date-time'}`. Named `@DateTime` (not `@Date`) to avoid shadowing the global `Date`.
 */
const DateTime = () => constraintDecorator(Strings.DateTime());

/** Rejects any string that is not a dotted-quad IPv4 address. Projects to `{type:'string', format:'ipv4'}`. */
const Ipv4 = () => constraintDecorator(Strings.Ipv4());

/**
 * A keyed alias over the validating format descriptors — `@Format('uuid') ≡ @Uuid()`. An unknown name
 * throws a `TypeError` at decoration time (an unbacked `format` would be an over-claim; see
 * `src/Contracts/string.ts`). Supported names: `uuid`, `date-time`, `ipv4`.
 */
const Format = (name: string) => constraintDecorator(Strings.Format(name));

// ---------------------------------------------------------------------------
// Membership (IDEA-21 / GAP-14)
// ---------------------------------------------------------------------------

/**
 * Rejects any value not among `values`. Type-agnostic — the members may be strings, numbers,
 * booleans, or `null` — and it projects to a JSON Schema `{enum: values}`, the shape LLM tool-calling
 * wants most. `values` must be a non-empty array of JSON primitives; see `src/Contracts/enum.ts`.
 */
const OneOf = (values: JsonValue[]) => constraintDecorator(Enums.OneOf(values));

/**
 * Rejects any value that is not exactly `value` (strict equality). The single-literal sibling of
 * `@OneOf`; projects to `{const: value}`. `value` must be a JSON primitive — see `src/Contracts/enum.ts`.
 */
const Const = (value: JsonValue) => constraintDecorator(Enums.Const(value));

// ---------------------------------------------------------------------------
// Composition — @ArrayOf (DEC-050 / IDEA-22 / GAP-15)
// ---------------------------------------------------------------------------

/**
 * A list whose every element satisfies `item`. Type-agnostic in the container; projects to a JSON
 * Schema `{type:'array', items:<item schema>, minItems?, maxItems?}`, inheriting the item descriptor's
 * own fragment. `item` is a `ConstraintDescriptor` (e.g. `StringContracts.NotEmpty()`), serialised
 * into the descriptor as data — the DEC-050 compositional mechanism; see `src/Contracts/array.ts`.
 */
const ArrayOf = (item: ConstraintDescriptor, options?: {minItems?: number; maxItems?: number}) =>
    constraintDecorator(Arrays.ArrayOf(item, options));

// ---------------------------------------------------------------------------
// Object composition (DEC-050 / DEC-054) — @Dictionary
// ---------------------------------------------------------------------------

/**
 * An open map whose every value satisfies `value` — a validated `Record<string, V>`. Projects to a JSON
 * Schema `{type:'object', additionalProperties:<value schema>}` (open by construction), inheriting the
 * value descriptor's own fragment. `value` is a `ConstraintDescriptor` (e.g. `StringContracts.NotEmpty()`),
 * serialised into the descriptor as data — the DEC-050 mechanism; see `src/Contracts/object.ts`.
 */
const Dictionary = (value: ConstraintDescriptor) => constraintDecorator(Objects.Dictionary(value));

/**
 * A closed DTO: an object validated against the `@Contract`ed instance fields of `fieldClass`. Projects
 * (descriptively) to `{type:'object', properties}`; a tool schema tightens it to `required` +
 * `additionalProperties:false` (DEC-055). `fieldClass` must be decorated *before* `@Shape` reads it
 * (DEC-007); a class with no contracted instance field throws. See `src/Contracts/object.ts`.
 */
const Shape = (fieldClass: Function) => constraintDecorator(Objects.Shape(fieldClass));

// ---------------------------------------------------------------------------
// Nullable combinator (DEC-056) — @Nullable
// ---------------------------------------------------------------------------

/**
 * Widens `item` to also accept `null`. Compositional (DEC-050): projects to the item's fragment with
 * `null` added to its `type` (or an `anyOf` union). This is "may be null", distinct from `@Optional`'s
 * "may be absent". `item` is a `ConstraintDescriptor`; see `src/Contracts/nullable.ts`.
 */
const Nullable = (item: ConstraintDescriptor) => constraintDecorator(Nullables.Nullable(item));

export {
    // number
    LessThanEqual,
    GreaterThanEqual,
    LessThan,
    GreaterThan,
    Between,
    Integer,
    MultipleOf,

    // string
    StringMinLength,
    MinLength,
    MaxLength,
    NotEmpty,
    Matches,
    Email,
    Url,

    // string formats (IDEA-23)
    Uuid,
    DateTime,
    Ipv4,
    Format,

    // membership
    OneOf,
    Const,

    // composition (DEC-050)
    ArrayOf,

    // object composition (DEC-054 / DEC-055)
    Dictionary,
    Shape,

    // nullable combinator (DEC-056)
    Nullable,
};
