/**
 * Numeric constraints, as descriptors (P1.0 / P3.3, plan §2).
 *
 * These are **not** decorators and must never become decorators. This layer is decorator-agnostic
 * (DEC-012): the same descriptor is consumed by the legacy per-parameter adapter, by a
 * method-level `@Contract({...})`, and by every projection.
 *
 * Every constraint here is a reified descriptor whose predicate is **derived from its params**
 * (DEC-010). There is no `predicate` input anywhere in this file, and adding one would reopen the
 * descriptor/enforcement drift Q-4 exists to prevent.
 *
 * ---
 *
 * ## P3.3 settled three things the P1.0 port deliberately left open
 *
 * ### 1. Predicates are now **total** (ISSUES.md BUG-4)
 *
 * Every derivation below opens with {@link isNumeric}. A predicate returns `false` for `null`,
 * `undefined`, strings, objects, symbols — anything that is not a number — rather than relying on
 * JavaScript's relational coercion. It never throws.
 *
 * This is not only about error-message quality. A non-total predicate is a hazard for *any*
 * projection that evaluates it, and a fuzzer feeds it `null` in the first hundred cases. It also
 * closes a real hole: `!(undefined < 5)` is `true`, so before this change **`undefined` satisfied
 * every numeric constraint**, exactly as `NaN` did.
 *
 * ### 2. `NaN` now **violates** every numeric constraint (ISSUES.md Q-7)
 *
 * The originals tested `value < min`, and every comparison with `NaN` is `false`, so `NaN` never
 * triggered a violation. P1.0 preserved that as `!(value < min)` rather than smuggle a behaviour
 * change into a refactor, and pinned it with a test. P3.3 settles it: **`NaN` is rejected.**
 *
 * Three reasons, in order of weight:
 *
 * - `NaN` is not a number that fails to satisfy a bound; it is the *absence* of a numeric result —
 *   the residue of `parseInt('abc')`, `0/0`, or arithmetic on `undefined`. It is the single most
 *   common numeric corruption in JavaScript, and a guard that lets it through has failed at
 *   precisely the job the guard exists for.
 * - Under DEC-006 a descriptor is projected into artifacts. `{min: 0}` emits JSON Schema
 *   `{"minimum": 0}`, which `NaN` cannot even be expressed in, and a generator built from that
 *   range would never produce `NaN`. So the old predicate disagreed with its own params on this one
 *   input — Q-4 drift, arrived at by preservation rather than by carelessness, but drift all the same.
 * - Every alternative is worse. Leaving `NaN` accepted keeps the vocabulary self-inconsistent: `NaN`
 *   would satisfy `GreaterThan(0)` **and** `LessThan(0)` simultaneously.
 *
 * `Infinity` is deliberately **not** rejected: `Infinity > 5` is genuinely true and the ordering is
 * coherent, so `GreaterThan(5)` accepting it is correct. (`Descriptor.normalizeParams` separately
 * refuses non-finite *params*, so no bound can be infinite.) `NaN` is excluded because it has no
 * ordering at all, not because it is exotic.
 *
 * ### 3. The named-boundary constraints are **gone** (ISSUES.md Q-1, DEC-020) — **breaking**
 *
 * `Positive`, `Negative`, `NonNegative` and `NonPositive` have been removed outright. Use
 * `GreaterThan(0)`, `LessThan(0)`, `GreaterThanEqual(0)` and `LessThanEqual(0)`.
 *
 * `Positive()` was ambiguous for the whole of this project's life: it originally admitted `0`
 * (DEC-001), P3.3 made it strict, and Q-1 tracked the disagreement between the *name* and the
 * *boundary* across every wave in between. Both readings were defensible, which is the tell — the
 * question was never answerable from the constraint's own definition, because the name does not
 * carry the boundary and the author is the only one who knows which they meant.
 *
 * So the fix is not to adjudicate it. It is to **stop encoding a boundary in a name**, and put the
 * nuance about `0` back where the intent is knowable: on the developer. `GreaterThan(0)` and
 * `GreaterThanEqual(0)` state exactly which boundary is meant and cannot surprise anyone. Q-1 is
 * resolved by making the ambiguity *unexpressible* rather than by picking a side that the next
 * reader would have to look up.
 *
 * The same reasoning generalises: a named constraint can only ever hard-code one arbitrary limit,
 * so `Positive` is the special case of `GreaterThan` that happens to have a word for it. There is
 * no word for `GreaterThan(18)`, and nobody wants one.
 *
 * ---
 *
 * ## Identity is distinct even where derivation is shared
 *
 * `between` is literally `atLeast ∧ atMost`, and `min`/`max` share their derivations with nothing
 * else now that the named-boundary constraints are gone. Sharing a derivation is what makes two
 * identities unable to disagree; keeping the identity separate is what lets a projection print
 * "a number between 1 and 10 (inclusive)" where a schema emits `{"minimum": 1, "maximum": 10}`.
 * The identity is what a projection prints, the params are what it reads.
 *
 * DEC-020 deliberately spends some of that: `positive` was a distinct identity whose whole value
 * was printing "a positive number" where `greaterThan` prints "a number greater than 0". The
 * second reads better — it states the boundary instead of implying it — so the identity was
 * carrying ambiguity, not information.
 *
 * ## `schema()` may under-claim, never over-claim
 *
 * A fragment is a **necessary** condition, not always a sufficient one: JSON Schema cannot express
 * everything a predicate can. The rule applied throughout `src/Contracts/` is that a fragment must
 * never reject a value the predicate accepts — a generated client refusing valid input is a silent
 * failure, while a generated client accepting input the runtime then rejects is a loud one.
 *
 * ## `arbitrary` is still shape-only
 *
 * `fast-check` is not a dependency (ISSUES.md IDEA-3), so no generator is supplied here. `schema`
 * is populated wherever it is cheap and exact.
 */

import {defineConstraint, JsonObject, Predicate} from '../Core/Descriptor';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Inclusive lower bound. */
export interface MinParams extends JsonObject {
    min: number;
}

/** Inclusive upper bound. */
export interface MaxParams extends JsonObject {
    max: number;
}

/** Exclusive lower bound. */
export interface ExclusiveMinParams extends JsonObject {
    exclusiveMin: number;
}

/** Exclusive upper bound. */
export interface ExclusiveMaxParams extends JsonObject {
    exclusiveMax: number;
}

/** Inclusive range. */
export interface RangeParams extends JsonObject {
    min: number;
    max: number;
}

/** Divisor. Always strictly positive — see {@link MultipleOf}. */
export interface MultipleOfParams extends JsonObject {
    multipleOf: number;
}

// ---------------------------------------------------------------------------
// Totality (BUG-4) and the NaN decision (Q-7)
// ---------------------------------------------------------------------------

/**
 * The single gate every numeric predicate passes through.
 *
 * Excluding `NaN` here rather than in each derivation is what makes the Q-7 decision *uniform* by
 * construction: a numeric constraint cannot accidentally admit `NaN`, because there is no route to
 * a comparison that does not cross this function.
 */
function isNumeric(value: unknown): value is number {
    return typeof value === 'number' && !Number.isNaN(value);
}

// ---------------------------------------------------------------------------
// Derivations — the single source each predicate comes from (DEC-010)
// ---------------------------------------------------------------------------

/** `min` is inclusive. Backs `min`, and `between` via {@link within}. */
const atLeast =
    (params: Readonly<MinParams>): Predicate =>
    (value: unknown) =>
        isNumeric(value) && value >= params.min;

/** `max` is inclusive. Backs `max`, and `between` via {@link within}. */
const atMost =
    (params: Readonly<MaxParams>): Predicate =>
    (value: unknown) =>
        isNumeric(value) && value <= params.max;

/** `exclusiveMin` is excluded. Backs `greaterThan`. */
const above =
    (params: Readonly<ExclusiveMinParams>): Predicate =>
    (value: unknown) =>
        isNumeric(value) && value > params.exclusiveMin;

/** `exclusiveMax` is excluded. Backs `lessThan`. */
const below =
    (params: Readonly<ExclusiveMaxParams>): Predicate =>
    (value: unknown) =>
        isNumeric(value) && value < params.exclusiveMax;

/**
 * Both bounds inclusive.
 *
 * Composed from {@link atLeast} and {@link atMost} rather than written out, so `Between(a, b)`
 * cannot disagree with `GreaterThanEqual(a)` ∧ `LessThanEqual(b)` — there is one implementation of
 * "inclusive lower bound" in this file, not two.
 */
const within = (params: Readonly<RangeParams>): Predicate => {
    const lower = atLeast(params);
    const upper = atMost(params);
    return (value: unknown) => lower(value) && upper(value);
};

/** No params: the rule is fully determined by its identity. */
const whole = (): Predicate => (value: unknown) => isNumeric(value) && Number.isInteger(value);

/**
 * The bare primitive-type rule: a finite number (axiform feedback 2026-10-18 §3). Every consumer mapping a
 * type system onto adorn needs "just a number" and had to write it with `defineConstraint`. STRICTER than
 * {@link isNumeric} — it excludes `Infinity`/`-Infinity` too, so the name is exact and the `{type:'number'}`
 * schema stays truthful (neither JSON nor the schema's `number` admits a non-finite value).
 */
const finite = (): Predicate => (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * Exact for integer operands; tolerant for fractional ones.
 *
 * `0.3 % 0.1` is `0.09999999999999998`, not `0`, so a naive `%` reports that `0.3` is not a
 * multiple of `0.1`. Binary floating point cannot represent either operand exactly and no
 * implementation escapes this — JSON Schema's own `multipleOf` has the same ambiguity and
 * validators disagree on it. The compromise here is stated rather than hidden: integers are exact,
 * fractional divisors compare the quotient against its nearest integer within a *relative*
 * tolerance, so the check degrades predictably with magnitude instead of failing outright.
 *
 * `Infinity` falls out as `false`: `Infinity / n` is `Infinity`, and `Infinity - Infinity` is `NaN`,
 * which fails the comparison. That is the right answer — infinity is not a multiple of anything.
 */
const multipleOf = (params: Readonly<MultipleOfParams>): Predicate => {
    const divisor = params.multipleOf;
    return (value: unknown) => {
        if (!isNumeric(value)) return false;
        if (Number.isInteger(value) && Number.isInteger(divisor)) return value % divisor === 0;

        const quotient = value / divisor;
        const nearest = Math.round(quotient);
        return Math.abs(quotient - nearest) <= Number.EPSILON * Math.abs(quotient) * 8;
    };
};

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------

/**
 * `type: 'number'` is only truthful because the predicates are type-guarded (BUG-4). Before P3.3 a
 * numeric constraint accepted `undefined` and `NaN`, so claiming a type in a generated schema would
 * have been a claim enforcement did not back.
 */
const numeric = (fragment: JsonObject): JsonObject => {
    const schema: JsonObject = {type: 'number'};
    Object.keys(fragment).forEach(key => {
        schema[key] = fragment[key];
    });
    return schema;
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const minConstraint = defineConstraint<MinParams, number>({
    kind: 'number',
    constraint: 'min',
    derive: atLeast,
    describe: params => `a number greater than or equal to ${params.min}`,
    schema: params => numeric({minimum: params.min}),
});

export const maxConstraint = defineConstraint<MaxParams, number>({
    kind: 'number',
    constraint: 'max',
    derive: atMost,
    describe: params => `a number less than or equal to ${params.max}`,
    schema: params => numeric({maximum: params.max}),
});

export const greaterThanConstraint = defineConstraint<ExclusiveMinParams, number>({
    kind: 'number',
    constraint: 'greaterThan',
    derive: above,
    describe: params => `a number greater than ${params.exclusiveMin}`,
    schema: params => numeric({exclusiveMinimum: params.exclusiveMin}),
});

export const lessThanConstraint = defineConstraint<ExclusiveMaxParams, number>({
    kind: 'number',
    constraint: 'lessThan',
    derive: below,
    describe: params => `a number less than ${params.exclusiveMax}`,
    schema: params => numeric({exclusiveMaximum: params.exclusiveMax}),
});

export const betweenConstraint = defineConstraint<RangeParams, number>({
    kind: 'number',
    constraint: 'between',
    derive: within,
    describe: params => `a number between ${params.min} and ${params.max} (inclusive)`,
    schema: params => numeric({minimum: params.min, maximum: params.max}),
});

/*
 * `positiveConstraint`, `negativeConstraint`, `nonNegativeConstraint` and `nonPositiveConstraint`
 * were removed by DEC-020. They were distinct identities over `above`/`below`/`atLeast`/`atMost`
 * with their bound hard-coded to zero, existing so a document could say "a positive number".
 *
 * Do not reintroduce them, under any name that implies a boundary rather than stating one. The
 * ambiguity Q-1 tracked for three waves was not a bug in the boundary; it was a bug in naming a
 * boundary at all.
 */

export const integerConstraint = defineConstraint<JsonObject, number>({
    kind: 'number',
    constraint: 'integer',
    derive: whole,
    describe: () => 'an integer',
    // The one fragment that narrows rather than annotates: `integer` *is* a JSON Schema type.
    schema: () => ({type: 'integer'}),
});

export const finiteConstraint = defineConstraint<JsonObject, number>({
    kind: 'number',
    constraint: 'finite',
    derive: finite,
    describe: () => 'a finite number',
    // A type fragment, truthful because `finite` type-guards (like `integer`): the schema's `number`
    // cannot represent `Infinity`/`NaN`, and neither does this predicate admit them.
    schema: () => numeric({}),
});

export const multipleOfConstraint = defineConstraint<MultipleOfParams, number>({
    kind: 'number',
    constraint: 'multipleOf',
    derive: multipleOf,
    describe: params => `a multiple of ${params.multipleOf}`,
    schema: params => numeric({multipleOf: params.multipleOf}),
});

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

/**
 * Guards the *authoring* side, which `Descriptor.normalizeParams` does not: it rejects a non-finite
 * bound, but `'5'` is valid JSON and would sail through, producing `value >= '5'` — a string
 * comparison silently masquerading as a numeric one.
 *
 * A bad bound is an author error, so it throws at construction rather than at call time.
 */
function requireFiniteNumber(constraint: string, name: string, value: number): number {
    if (typeof value !== 'number' || !isFinite(value)) {
        throw new TypeError(
            `${constraint}: \`${name}\` must be a finite number, received ${describeValue(value)}`,
        );
    }
    return value;
}

function describeValue(value: unknown): string {
    if (typeof value === 'string') return `the string '${value}'`;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    return String(value);
}

// ---------------------------------------------------------------------------
// Constraint factories — the authoring surface
// ---------------------------------------------------------------------------

/** Rejects values below `min`; `min` itself passes. */
export function GreaterThanEqual(min: number) {
    return minConstraint({min: requireFiniteNumber('GreaterThanEqual', 'min', min)});
}

/** Rejects values above `max`; `max` itself passes. */
export function LessThanEqual(max: number) {
    return maxConstraint({max: requireFiniteNumber('LessThanEqual', 'max', max)});
}

/** Rejects values at or below `bound`. */
export function GreaterThan(bound: number) {
    return greaterThanConstraint({exclusiveMin: requireFiniteNumber('GreaterThan', 'bound', bound)});
}

/** Rejects values at or above `bound`. */
export function LessThan(bound: number) {
    return lessThanConstraint({exclusiveMax: requireFiniteNumber('LessThan', 'bound', bound)});
}

/**
 * Rejects values outside `[min, max]`. **Both bounds are inclusive.**
 *
 * Inclusive because it composes the two existing inclusive bounds, so `Between` is exactly
 * `GreaterThanEqual ∧ LessThanEqual` with one identity instead of two — which is the whole reason
 * to have it. An exclusive variant would need its own derivation and is not built until something
 * asks for it (plan risk 10).
 *
 * `min === max` is allowed and pins the value; `min > max` is an author error and throws, because
 * the alternative is a constraint nothing can satisfy that reads as valid in generated docs.
 */
export function Between(min: number, max: number) {
    requireFiniteNumber('Between', 'min', min);
    requireFiniteNumber('Between', 'max', max);
    if (min > max) {
        throw new RangeError(
            `Between: \`min\` (${min}) must not exceed \`max\` (${max}) — no value could satisfy it`,
        );
    }
    return betweenConstraint({min, max});
}

/*
 * `Positive()`, `Negative()`, `NonNegative()` and `NonPositive()` were removed by DEC-020.
 *
 *     Positive()     ->  GreaterThan(0)
 *     Negative()     ->  LessThan(0)
 *     NonNegative()  ->  GreaterThanEqual(0)
 *     NonPositive()  ->  LessThanEqual(0)
 *
 * No deprecated aliases are shipped. An alias would have to pick a boundary to forward to, which
 * is the choice Q-1 could never settle, so it would preserve exactly the ambiguity the removal
 * exists to end — with the added cost that a caller reading `Positive()` in their own source still
 * cannot tell what it does.
 */

/** Rejects non-integers, and any non-number. `1.0` is an integer; `1.5`, `Infinity`, `NaN` are not. */
export function Integer() {
    return integerConstraint({});
}

/**
 * The bare numeric type: accepts any finite number, rejects non-numbers and `NaN`/`Infinity`. The
 * primitive every type-system mapping wants (axiform feedback 2026-10-18 §3) — `Finite()` rather than a
 * bound. It is NOT a boundary (DEC-020 forbids boundary-named constraints); it states a *type*, exactly as
 * `Integer()` does.
 */
export function Finite() {
    return finiteConstraint({});
}

/**
 * Rejects values that are not an exact multiple of `divisor`. `0` is a multiple of everything.
 *
 * `divisor` must be strictly positive: `0` admits nothing, and a negative divisor describes the
 * same set as its absolute value while producing a confusing `{"multipleOf": -2}` in a schema.
 */
export function MultipleOf(divisor: number) {
    requireFiniteNumber('MultipleOf', 'divisor', divisor);
    if (divisor <= 0) {
        throw new RangeError(`MultipleOf: \`divisor\` must be greater than zero, received ${divisor}`);
    }
    return multipleOfConstraint({multipleOf: divisor});
}
