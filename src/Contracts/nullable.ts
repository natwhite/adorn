/**
 * The nullable combinator, as a descriptor (IDEA-24 / DEC-056) — a compositional constraint (DEC-050).
 *
 * `@Nullable(item)` widens any constraint to also accept `null`. It is the principled home for "may be
 * null", deliberately distinct from `@Optional`'s "may be **absent** (`undefined`)": a nullable field is
 * present and either a valid value or an explicit `null`, whereas an optional one may be omitted entirely.
 *
 * Compositional exactly as `@ArrayOf` is (`./array.ts`): the inner constraint rides as its serialised
 * form (`item: SerializedConstraint`), the item predicate is rebuilt **once** in `derive` via
 * `constraintFromJSON`, and the whole thing JSON-round-trips. Decorator-agnostic (DEC-012); the predicate
 * is derived from params (DEC-010).
 */

import {
    ConstraintDescriptor,
    ConstraintParams,
    constraintFromJSON,
    defineConstraint,
    JsonObject,
    Predicate,
    SerializedConstraint,
} from '../Core/Descriptor';

/** The wrapped constraint, carried as serialised data (DEC-050). */
export interface NullableParams extends JsonObject {
    item: SerializedConstraint;
}

const isNullable = (params: Readonly<NullableParams>): Predicate => {
    const itemPredicate = constraintFromJSON(params.item).predicate;
    // `null` short-circuits BEFORE the item predicate — so a total item predicate that would reject
    // `null` (BUG-4) does not veto the explicit allow. Everything else defers to the item.
    return (value: unknown) => value === null || itemPredicate(value);
};

export const nullableConstraint = defineConstraint<NullableParams>({
    kind: 'generic',
    constraint: 'nullable',
    derive: isNullable,
    // Transparent (DEC-060): adds NO segment of its own — `Nullable(Dictionary(...))` points straight inside.
    locate: params => {
        const inner = constraintFromJSON(params.item);
        const pred = inner.predicate;
        const deeper = inner.locate;
        return (value: unknown) => {
            if (value === null || pred(value)) return undefined; // passes → nothing to locate
            return deeper ? deeper(value) : undefined;
        };
    },
    describe: params => `${constraintFromJSON(params.item).describe()} or null`,
    schema: params => {
        const inner = constraintFromJSON(params.item);
        const innerSchema = inner.schema ? inner.schema() : {};
        // A single string `type` widens to include `'null'` — but ONLY when no keyword constrains the value
        // set ACROSS type branches. `minLength`/`minimum`/`items`/`properties` bite the non-null branch alone
        // (a `null` instance ignores them), so `{type:['string','null'], minLength:5}` is exactly "(a string
        // of length ≥ 5) OR null". `enum`/`const` are different: they restrict the value regardless of type,
        // so widening `{type:'string', enum:['a','b']}` to `type:['string','null']` would still demand the
        // value be in `['a','b']` — REJECTING null (voice-agent L2 fallout: a homogeneous `OneOf` now carries
        // `type`). Those go to the exact `anyOf` branch below instead.
        if (typeof innerSchema.type === 'string' && !('enum' in innerSchema) && !('const' in innerSchema)) {
            return {...innerSchema, type: [innerSchema.type, 'null']};
        }
        // A hookless item (`{}`) already accepts anything, `null` included — nullable is still `{}`.
        if (Object.keys(innerSchema).length === 0) return {};
        // No safe single `type` to widen (`enum`/`const` value sets, `allOf`, a `type` already an array):
        // express the union with `anyOf`, which is exact.
        return {anyOf: [innerSchema, {type: 'null'}]};
    },
});

/**
 * Widens `item` to also accept `null`. `item` must be a {@link ConstraintDescriptor} (e.g.
 * `StringContracts.Email()`), serialised into the descriptor as data (DEC-050); a hand-written closure
 * (no `toJSON`) is rejected loudly here rather than admitted silently.
 *
 * This is "may be `null`", NOT "may be absent" — for an omittable parameter use `@Optional`, and combine
 * them (`@Optional @Nullable(...)`) for a parameter that may be omitted OR explicitly null.
 */
export function Nullable<V>(
    item: ConstraintDescriptor<ConstraintParams, V>,
): ConstraintDescriptor<NullableParams, V | null> {
    if (!item || typeof item.toJSON !== 'function' || typeof item.predicate !== 'function') {
        throw new TypeError(
            'Nullable: `item` must be a ConstraintDescriptor (e.g. StringContracts.Email()). A ' +
                'hand-written closure carries no identity or params and cannot be composed (DEC-050).',
        );
    }
    return nullableConstraint({item: item.toJSON()}) as ConstraintDescriptor<NullableParams, V | null>;
}
