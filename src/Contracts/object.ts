/**
 * Object constraints, as descriptors — further consumers of the DEC-050 compositional mechanism.
 *
 * Two object kinds live here, deliberately distinct because their JSON Schema closure is *opposite*:
 *
 * - **`Dictionary(value)`** — an OPEN map (`Record<string, V>`): arbitrary string keys, every value
 *   satisfying `value`. Projects to `{type:'object', additionalProperties:<value schema>}` — open by
 *   construction. This is the shape a `Record<string,string>` tool argument needs (round-2 §2).
 * - **`Shape(FieldClass)`** — a CLOSED DTO: the fixed set of `@Contract`ed fields on `FieldClass`, each
 *   validated by its own field constraints. Projects (descriptively) to `{type:'object', properties}`;
 *   the prescriptive tool schema tightens it to `required` + `additionalProperties:false` (DEC-055).
 *   It reads `FieldClass`'s field contracts at authoring time (DEC-007 ordering) via a `Core` registry
 *   read that takes a constructor — no decorator types, so DEC-012-clean (the layering guard forbids only
 *   `Adapters/` imports).
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
import {getFieldContractsForClass} from '../Core/ContractRegistry';

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

// ---------------------------------------------------------------------------
// @Shape — a closed DTO over another class's field contracts (DEC-055)
// ---------------------------------------------------------------------------

/**
 * The modelled class's field contracts, flattened to data: each instance field name mapped to its
 * serialised constraint stack. Read once at authoring time by {@link Shape}.
 */
export interface ShapeParams extends JsonObject {
    fields: {[name: string]: SerializedConstraint[]};
}

const isShape = (params: Readonly<ShapeParams>): Predicate => {
    // Rebuild each field's predicate stack ONCE (DEC-050), not per call.
    const fieldPredicates: Array<[string, Predicate[]]> = Object.keys(params.fields).map(name => [
        name,
        params.fields[name].map(serialized => constraintFromJSON(serialized).predicate),
    ]);
    return (value: unknown) => {
        if (!isPlainObjectValue(value)) return false;
        // Every field's stack must hold on value[name]. A MISSING field is `undefined`, which the total
        // field predicates (BUG-4) reject — so every contracted field is required (present AND valid),
        // matching the tool schema's `required: <all fields>` exactly (DEC-055, no drift).
        return fieldPredicates.every(([name, predicates]) =>
            predicates.every(predicate => predicate(value[name])),
        );
    };
};

/**
 * A field's schema fragment, self-contained (DEC-012): rebuild each of the field's constraints' own
 * `schema()` and conjoin with `allOf` — never the projection's `mergeFragments`. A single constraint
 * contributes its fragment directly (so a nested `@Shape`/`@Dictionary` field stays a recursible
 * `{type:'object',…}` the tool tightener can descend); `{}` is the hookless floor.
 */
function fieldFragment(serialized: SerializedConstraint[]): JsonObject {
    const fragments = serialized.map(entry => {
        const descriptor = constraintFromJSON(entry);
        return descriptor.schema ? descriptor.schema() : {};
    });
    if (fragments.length === 1) return fragments[0];
    return {allOf: fragments};
}

export const shapeConstraint = defineConstraint<ShapeParams>({
    kind: 'generic',
    constraint: 'shape',
    derive: isShape,
    describe: params => `an object with fields ${Object.keys(params.fields).join(', ')}`,
    schema: params => {
        // DESCRIPTIVE, under-claim (DEC-029): `properties` only, NO `required`/`additionalProperties`.
        // The prescriptive tool projection tightens recursively (DEC-055); `schemaForClass` leaves it open.
        const properties: JsonObject = {};
        Object.keys(params.fields).forEach(name => {
            properties[name] = fieldFragment(params.fields[name]);
        });
        return {type: 'object', properties};
    },
});

/**
 * A descriptor validating an object against the `@Contract`ed **instance** fields of `FieldClass`.
 *
 * Reads `FieldClass`'s field contracts NOW (DEC-007 ordering — decorate `FieldClass` first, earlier in
 * module order). Statics are excluded (a DTO's shape is its instance fields); inheritance is honoured
 * (`getFieldContractsForClass` resolves the DEC-021 union). A class with no contracted instance field is
 * an authoring error and **throws** — an empty shape would project to an object schema that accepts
 * anything, the "looks complete, isn't" failure DEC-006/DEC-016 reject (the review's MAJOR-3).
 */
export function Shape(fieldClass: Function): ConstraintDescriptor<ShapeParams> {
    if (typeof fieldClass !== 'function') {
        throw new TypeError('Shape: expected a class (constructor function) whose fields carry contracts');
    }
    const fields: {[name: string]: SerializedConstraint[]} = {};
    getFieldContractsForClass(fieldClass)
        .filter(entry => !entry.isStatic)
        .forEach(entry => {
            const serialized = entry.contract.constraints.map(constraint => constraint.toJSON());
            if (serialized.length > 0) fields[String(entry.key)] = serialized;
        });
    if (Object.keys(fields).length === 0) {
        throw new TypeError(
            `Shape: ${fieldClass.name || '(anonymous class)'} has no contracted instance fields to ` +
                'model. Decorate its fields (e.g. @Enforce / CreateFieldDecorator) and make sure the ' +
                'class is defined before @Shape reads it (DEC-007).',
        );
    }
    return shapeConstraint({fields});
}
