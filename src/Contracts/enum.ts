/**
 * Membership constraints, as descriptors (IDEA-21 / GAP-14).
 *
 * `@OneOf([...])` is a reified **enum / membership** constraint: the value must equal one of a fixed
 * set of allowed members. It is the descriptor `ConstraintKind = 'number' | 'string' | 'generic'`
 * left room for and nothing filled — there was no membership constraint anywhere in `Contracts/`
 * (GAP-14), so an LLM tool schema simulating an enum had to reach for `@Matches(/^(a|b)$/)`, which
 * emits a `pattern` a model can at best treat as a hint. This descriptor emits `{enum: [...]}` — the
 * shape several tool-calling providers *constrain-decode* against (the model literally cannot emit a
 * non-member), and a genuinely better documentation line than "a string matching /…/".
 *
 * Decorator-agnostic (DEC-012) — see the note in `./number.ts`. The predicate is **derived from
 * params** (DEC-010); there is no `predicate` input in this file.
 *
 * ## Type-agnostic, on purpose
 *
 * Unlike the numeric and string constraints, `oneOf` has `kind: 'generic'`: an enum is a set of
 * literals of *whatever* type — `'celsius' | 'fahrenheit'`, `1 | 2 | 3`, `true | false` — and the
 * membership test is the same regardless. The emitted `{enum: [...]}` fragment is likewise
 * type-agnostic; it carries no `type` keyword, so when it merges with, say, a `{type: 'string'}` the
 * two coexist (disjoint keywords) exactly as `schema.ts`'s conjunction merge expects.
 *
 * ## The predicate is total, and strict equality is the right membership test (BUG-4)
 *
 * Members are validated at authoring time to be JSON **primitives** ({@link OneOf}). For primitives,
 * `===` *is* value equality: it never throws, it distinguishes `'2'` from `2` (so a wrong-typed value
 * is rejected, not coerced), and it rejects `undefined`/`null`/objects that are not members — which is
 * the totality every predicate owes a projection that evaluates it (a fuzzer feeds it `null` in the
 * first hundred cases). It is preferred over `Object.is` deliberately: `Object.is(0, -0)` is `false`
 * and `Object.is(NaN, NaN)` is `true`, but `-0`/`+0` are one JSON value and `NaN` is not a
 * serialisable member at all, so `Object.is`'s two divergences are both wrong for JSON membership.
 *
 * ## `schema()` is exact, not an under-claim
 *
 * `{enum: members}` accepts **exactly** the set the predicate accepts, so — unusually for this layer —
 * the fragment neither over- nor under-claims. That is why it is the constrained-decoding target tool
 * schemas want: the schema the model reads and the runtime check its arguments face are the same set,
 * derived from the same `params` (DEC-010), and cannot drift.
 *
 * ## `arbitrary` is still shape-only
 *
 * `fast-check` is not a dependency (IDEA-3), so no generator is supplied here. The add-on maps this
 * descriptor to `fc.constantFrom(...members)` — a *perfectly sound* generator with no filtering and no
 * starvation (DEC-031's ideal case), since it produces only members. That mapping lives in
 * `addons/test/arbitraries.ts`, never in core.
 */

import {defineConstraint, JsonObject, JsonValue, Predicate} from '../Core/Descriptor';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** The allowed members. Always a non-empty array of JSON primitives — see {@link OneOf}. */
export interface OneOfParams extends JsonObject {
    values: JsonValue[];
}

// ---------------------------------------------------------------------------
// Derivation — the single source the predicate comes from (DEC-010)
// ---------------------------------------------------------------------------

/**
 * Membership by strict equality. Total: `===` against a JSON primitive never throws and returns a
 * boolean for any input, so a wrong-typed value, `undefined`, `null`, or an object is simply not a
 * member rather than an error (BUG-4).
 */
const isOneOf =
    (params: Readonly<OneOfParams>): Predicate =>
    (value: unknown) =>
        params.values.some(member => member === value);

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const oneOfConstraint = defineConstraint<OneOfParams>({
    kind: 'generic',
    constraint: 'oneOf',
    derive: isOneOf,
    // JSON-rendered members so the prose is unambiguous about type: `one of "celsius", "fahrenheit"`
    // for strings, `one of 1, 2, 3` for numbers — a quoted string is never confused with a number.
    describe: params => `one of ${params.values.map(value => JSON.stringify(value)).join(', ')}`,
    // Exactly the members. A fresh array, so a consumer cannot reach the descriptor's frozen params
    // through the fragment. This is the constrained-decoding target LLM tool schemas want.
    schema: params => ({enum: params.values.slice()}),
});

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

/**
 * A member must be a JSON primitive so the constraint can be projected into a schema and round-trip
 * through JSON (DEC-010). Non-finite numbers are excluded here too — `NaN`/`Infinity` survive neither
 * `JSON.stringify` nor a JSON Schema `enum`, so they are not admissible members (the same reason
 * `Descriptor.normalizeParams` refuses them as params).
 */
function isJsonPrimitive(value: unknown): value is JsonValue {
    if (value === null) return true;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return true;
    return type === 'number' && isFinite(value as number);
}

function describeMember(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return String(value); // names NaN / Infinity plainly
    if (typeof value === 'function') return 'a function';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'bigint') return 'a bigint';
    if (value && typeof value === 'object') {
        const constructor = (value as object).constructor;
        return constructor && constructor.name ? `a ${constructor.name}` : 'an object';
    }
    return String(value);
}

// ---------------------------------------------------------------------------
// Constraint factory — the authoring surface
// ---------------------------------------------------------------------------

/**
 * Rejects any value not among `values`. Type-agnostic — the members may be strings, numbers,
 * booleans, or `null`, in any mix — and the emitted schema fragment is `{enum: values}`.
 *
 * `values` must be a **non-empty** array of JSON primitives: an empty enum is a constraint nothing
 * can satisfy (and reads as valid in a generated schema), and a non-primitive member could not be
 * projected. Both are author errors, so they throw at construction rather than at call time.
 */
export function OneOf(values: JsonValue[]) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError(
            'OneOf: `values` must be a non-empty array of JSON primitives (string, number, boolean, or null)',
        );
    }
    values.forEach((value, index) => {
        if (!isJsonPrimitive(value)) {
            throw new TypeError(
                `OneOf: values[${index}] must be a string, number, boolean, or null — received ` +
                    `${describeMember(value)}. Enum members must be JSON primitives so the constraint can ` +
                    'be projected into a schema and round-trip through JSON (DEC-010).',
            );
        }
    });
    return oneOfConstraint({values: values.slice()});
}
