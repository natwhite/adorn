/**
 * Object constraints, as descriptors — further consumers of the DEC-050 compositional mechanism.
 *
 * Two object kinds live here, deliberately distinct because their JSON Schema closure is *opposite*:
 *
 * - **`Dictionary(value)`** — an OPEN map (`Record<string, V>`): arbitrary string keys, every value
 *   satisfying `value`. Projects to `{type:'object', additionalProperties:<value schema>}` — open by
 *   construction. This is the shape a `Record<string,string>` tool argument needs (round-2 §2).
 * - **`Shape(FieldClass)`** — a CLOSED DTO: the fixed set of `@Contract`ed fields on `FieldClass`, each
 *   validated by its own field constraints (added in a later slice — DEC-055).
 *
 * Both ride `kind:'generic'` (as `arrayOf`/`oneOf` do) and both are TOTAL (BUG-4): the predicate gates
 * `value` to a plain object — rejecting `null`, an array, or a non-object — before touching any entry.
 *
 * ## The inner constraint rides as data (DEC-050)
 *
 * `Dictionary` stores its value constraint as a single {@link SerializedConstraint} — exactly as
 * `arrayOf` stores its item (`./array.ts`) — rebuilds the value predicate ONCE in `derive` via
 * `constraintFromJSON`, and JSON-round-trips. Decorator-agnostic (DEC-012); the predicate is derived
 * from params (DEC-010), never attached.
 */

import {
    ConstraintDescriptor,
    constraintFromJSON,
    defineConstraint,
    JsonObject,
    Predicate,
    SerializedConstraint,
} from '../Core/Descriptor';

/** A plain (non-null, non-array) object — the container gate both object kinds apply first (BUG-4). */
const isPlainObjectValue = (value: unknown): value is {[key: string]: unknown} =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// @Dictionary — an open map, Record<string, value>
// ---------------------------------------------------------------------------

/**
 * v1: the value constraint, carried as its serialised form. No `minProperties`/`maxProperties` bound —
 * an empty map is a valid `Record<string, V>` and passes. Bounds are a clean v1.1 increment.
 */
export interface DictionaryParams extends JsonObject {
    value: SerializedConstraint;
}

const isDictionary = (params: Readonly<DictionaryParams>): Predicate => {
    const valuePredicate = constraintFromJSON(params.value).predicate;
    return (value: unknown) => {
        if (!isPlainObjectValue(value)) return false;
        // Every own enumerable value must satisfy the value constraint; keys are strings by construction.
        // An empty map passes (no value violates it) — the honest v1 (no minProperties bound).
        return Object.keys(value).every(key => valuePredicate(value[key]));
    };
};

export const dictionaryConstraint = defineConstraint<DictionaryParams>({
    kind: 'generic',
    constraint: 'dictionary',
    derive: isDictionary,
    describe: params =>
        `an object mapping string keys to ${constraintFromJSON(params.value).describe()}`,
    schema: params => {
        const inner = constraintFromJSON(params.value);
        // The value's own under-claim is inherited; `{}` (accept-any value) is the floor when it has no
        // `schema()` hook. `additionalProperties:<schema>` is the constraint's honest meaning — every
        // value matches — so it is under-claim-safe even though a class-instance ROOT never emits it
        // (DEC-029's `additionalProperties` ban is about the instance root, not a dictionary fragment).
        const additionalProperties = inner.schema ? inner.schema() : {};
        return {type: 'object', additionalProperties};
    },
});

/**
 * An open object whose every value satisfies `value` — a validated `Record<string, V>`.
 *
 * `value` must be a {@link ConstraintDescriptor} (e.g. `StringContracts.NotEmpty()`), serialised into
 * the descriptor as data (DEC-050); a hand-written closure (no `toJSON`) is rejected loudly here rather
 * than admitted silently.
 */
export function Dictionary(value: ConstraintDescriptor): ConstraintDescriptor<DictionaryParams> {
    if (!value || typeof value.toJSON !== 'function' || typeof value.predicate !== 'function') {
        throw new TypeError(
            'Dictionary: `value` must be a ConstraintDescriptor (e.g. StringContracts.NotEmpty()). A ' +
                'hand-written closure carries no identity or params and cannot be composed (DEC-050).',
        );
    }
    return dictionaryConstraint({value: value.toJSON()});
}
