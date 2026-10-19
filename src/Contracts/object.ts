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
    ConstraintParams,
    constraintFromJSON,
    defineConstraint,
    JsonObject,
    JsonValue,
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
    // First failing KEY (DEC-060): re-walks in the same order as `isDictionary`'s `every`, delegating into
    // the value descriptor so a dict of shapes yields a deep path (`["slotInput", "when"]`).
    locate: params => {
        const inner = constraintFromJSON(params.value);
        const pred = inner.predicate;
        const deeper = inner.locate;
        return (value: unknown) => {
            if (!isPlainObjectValue(value)) return undefined; // container gate → root, no sub-path
            for (const key of Object.keys(value)) {
                if (!pred(value[key])) {
                    const sub = deeper ? deeper(value[key]) : undefined;
                    return sub
                        ? {path: [key, ...(sub.path ?? [])], expected: sub.expected ?? inner.describe()}
                        : {path: [key], expected: inner.describe()};
                }
            }
            return undefined;
        };
    },
    describe: params => `an object mapping string keys to ${constraintFromJSON(params.value).describe()}`,
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
export function Dictionary<V>(
    value: ConstraintDescriptor<ConstraintParams, V>,
): ConstraintDescriptor<DictionaryParams, Record<string, V>> {
    if (!value || typeof value.toJSON !== 'function' || typeof value.predicate !== 'function') {
        throw new TypeError(
            'Dictionary: `value` must be a ConstraintDescriptor (e.g. StringContracts.NotEmpty()). A ' +
                'hand-written closure carries no identity or params and cannot be composed (DEC-050).',
        );
    }
    return dictionaryConstraint({value: value.toJSON()}) as ConstraintDescriptor<
        DictionaryParams,
        Record<string, V>
    >;
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
    // First failing FIELD (DEC-060): same field-then-stack order as `isShape`'s nested `every`. The stack
    // index is NOT a path segment (it is the same field); a nested compositional field deepens the path.
    locate: params => {
        const fields = Object.keys(params.fields).map(
            name => [name, params.fields[name].map(serialized => constraintFromJSON(serialized))] as const,
        );
        return (value: unknown) => {
            if (!isPlainObjectValue(value)) return undefined;
            for (const [name, descriptors] of fields) {
                for (const descriptor of descriptors) {
                    if (!descriptor.predicate(value[name])) {
                        const sub = descriptor.locate ? descriptor.locate(value[name]) : undefined;
                        return sub
                            ? {
                                  path: [name, ...(sub.path ?? [])],
                                  expected: sub.expected ?? descriptor.describe(),
                              }
                            : {path: [name], expected: descriptor.describe()};
                    }
                }
            }
            return undefined;
        };
    },
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
export function Shape<T = unknown>(
    fieldClass: (abstract new (...args: any[]) => T) | Function,
): ConstraintDescriptor<ShapeParams, T> {
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
    return shapeConstraint({fields}) as ConstraintDescriptor<ShapeParams, T>;
}

// ---------------------------------------------------------------------------
// @Fields — a fixed-key object LITERAL with optional-aware fields (round-4 §2.1, DEC-065)
// ---------------------------------------------------------------------------

/** One field's serialised form: its constraint stack plus the inline-marker data a `ToolParamSpec` carries. */
type SerializedField = {
    readonly stack: SerializedConstraint[];
    readonly optional?: boolean;
    readonly description?: string;
    readonly default?: JsonValue;
};

/**
 * The modelled fields, flattened to data. Unlike {@link ShapeParams} (all-required, class-sourced), a
 * `Fields` carries per-field `optional`/`description`/`default`, so an object LITERAL — the commonest shape,
 * including every HTTP body and every optional-arg tool call — is ONE declaration for both the validator and
 * the tool schema (round-4 §2.1).
 */
export interface FieldsParams extends JsonObject {
    fields: {[name: string]: SerializedField};
}

/** A field spec — a descriptor, a stack of them (conjunction), or the {@link ToolParamSpec}-shaped inline form. */
export type FieldSpec =
    | ConstraintDescriptor
    | ReadonlyArray<ConstraintDescriptor>
    | {
          readonly descriptor: ConstraintDescriptor | ReadonlyArray<ConstraintDescriptor>;
          readonly optional?: boolean;
          readonly description?: string;
          readonly default?: JsonValue;
      };

// Type-level output derivation (DEC-059 phantom `__out`): one `Fields({...})` literal narrows to the exact
// object type, optional keys included. A multi-descriptor stack's output is the UNION of the members' outputs
// (not their intersection) — an accepted type-level imprecision; runtime validation is exact.
type OutOf<D> = D extends ConstraintDescriptor<ConstraintParams, infer O> ? O : unknown;
type SpecOut<S> =
    S extends ConstraintDescriptor<ConstraintParams, infer O>
        ? O
        : S extends ReadonlyArray<ConstraintDescriptor>
          ? OutOf<S[number]>
          : S extends {descriptor: infer D}
            ? D extends ConstraintDescriptor<ConstraintParams, infer O>
                ? O
                : D extends ReadonlyArray<ConstraintDescriptor>
                  ? OutOf<D[number]>
                  : unknown
            : unknown;
type IsOptionalSpec<S> = S extends {optional: true} ? true : false;
type RequiredFieldKeys<T> = {[K in keyof T]-?: IsOptionalSpec<T[K]> extends true ? never : K}[keyof T];
type OptionalFieldKeys<T> = {[K in keyof T]-?: IsOptionalSpec<T[K]> extends true ? K : never}[keyof T];
type FieldsOut<T> = {[K in RequiredFieldKeys<T>]: SpecOut<T[K]>} & {
    [K in OptionalFieldKeys<T>]?: SpecOut<T[K]>;
};

const isFields = (params: Readonly<FieldsParams>): Predicate => {
    // Rebuild each field's predicate stack ONCE (DEC-050), not per call.
    const compiled = Object.keys(params.fields).map(name => {
        const field = params.fields[name];
        return {
            name,
            optional: field.optional === true,
            predicates: field.stack.map(serialized => constraintFromJSON(serialized).predicate),
        };
    });
    return (value: unknown) => {
        if (!isPlainObjectValue(value)) return false;
        for (const {name, optional, predicates} of compiled) {
            const present = Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined;
            if (!present) {
                if (optional) continue; // a missing OPTIONAL field is fine
                return false; // a missing REQUIRED field is a violation — unlike a bare field constraint (BUG-4)
            }
            if (!predicates.every(predicate => predicate(value[name]))) return false;
        }
        return true; // extra keys pass — no enumeration, the same under-claim posture as `isShape`
    };
};

export const fieldsConstraint = defineConstraint<FieldsParams>({
    kind: 'generic',
    constraint: 'fields',
    derive: isFields,
    // First failing FIELD (DEC-060), optional-aware, carrying the innermost `expected` (round-4 §2.2).
    locate: params => {
        const compiled = Object.keys(params.fields).map(name => {
            const field = params.fields[name];
            const descriptors = field.stack.map(serialized => constraintFromJSON(serialized));
            return {
                name,
                optional: field.optional === true,
                descriptors,
                fieldExpected: descriptors.map(descriptor => descriptor.describe()).join(' and '),
            };
        });
        return (value: unknown) => {
            if (!isPlainObjectValue(value)) return undefined;
            for (const {name, optional, descriptors, fieldExpected} of compiled) {
                const present =
                    Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined;
                if (!present) {
                    if (optional) continue;
                    return {path: [name], expected: fieldExpected};
                }
                for (const descriptor of descriptors) {
                    if (!descriptor.predicate(value[name])) {
                        const sub = descriptor.locate ? descriptor.locate(value[name]) : undefined;
                        return sub
                            ? {
                                  path: [name, ...(sub.path ?? [])],
                                  expected: sub.expected ?? descriptor.describe(),
                              }
                            : {path: [name], expected: descriptor.describe()};
                    }
                }
            }
            return undefined;
        };
    },
    describe: params =>
        `an object with fields ${Object.keys(params.fields)
            .map(name => (params.fields[name].optional ? `${name}?` : name))
            .join(', ')}`,
    schema: params => {
        // Emits its OWN `required` = the non-optional subset. The tool projection's `tightenObjects` respects
        // it (adds `additionalProperties:false`, closes recursively); descriptively it is an HONEST necessary
        // condition — `isFields` rejects a value missing a required field, so nested `required` never rejects a
        // value enforcement accepts (the narrow DEC-029 refinement, DEC-067). `@Shape` differs — see Q-33.
        const properties: JsonObject = {};
        const required: string[] = [];
        Object.keys(params.fields).forEach(name => {
            const field = params.fields[name];
            const fragment = fieldFragment(field.stack);
            if (typeof field.description === 'string') fragment.description = field.description;
            if (field.default !== undefined) fragment.default = field.default;
            properties[name] = fragment;
            if (!field.optional) required.push(name);
        });
        return {type: 'object', properties, required};
    },
});

/**
 * A fixed-key object with OPTIONAL-aware fields — the descriptor-first sibling of {@link Shape} for an
 * object LITERAL rather than a class (round-4 §2.1). The SAME literal drives both the validator
 * (`Verify.check(Fields({...}), …)`, narrowing `unknown` to the exact object type, optional keys included)
 * AND the tool schema (`toolSchemaFrom({params:{…}})`), so the two cannot drift.
 *
 * Each field is a {@link ConstraintDescriptor}, a stack of them (conjunction), or a `{descriptor, optional?,
 * description?, default?}` spec — the same inline shape `toolSchemaFrom`'s `ToolParamSpec` takes. A missing
 * REQUIRED field is a violation (unlike a bare field constraint, silent when absent); a missing `optional`
 * field passes. Extra keys pass at runtime (the tool schema's `additionalProperties:false` is
 * prescriptive-only, DEC-055). A hand-written closure (no `toJSON`) is rejected loudly (DEC-050).
 */
export function Fields<const T extends Record<string, FieldSpec>>(
    fields: T,
): ConstraintDescriptor<FieldsParams, FieldsOut<T>> {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new TypeError(
            'Fields: expected an object mapping field names to a descriptor, a stack, or a spec',
        );
    }
    const serialized: {[name: string]: SerializedField} = {};
    Object.keys(fields).forEach(name => {
        serialized[name] = normalizeFieldSpec(name, fields[name]);
    });
    if (Object.keys(serialized).length === 0) {
        throw new TypeError(
            'Fields: at least one field is required — an empty object contracts nothing and would project to ' +
                'an accept-anything schema (DEC-006/DEC-016).',
        );
    }
    return fieldsConstraint({fields: serialized}) as ConstraintDescriptor<FieldsParams, FieldsOut<T>>;
}

/** Normalise one field spec to its serialised form, validating every descriptor (DEC-050). */
function normalizeFieldSpec(name: string, spec: FieldSpec): SerializedField {
    let descriptors: ReadonlyArray<ConstraintDescriptor>;
    let optional = false;
    let description: string | undefined;
    let defaultValue: JsonValue | undefined;

    if (Array.isArray(spec)) {
        descriptors = spec;
    } else if (spec && typeof spec === 'object' && 'descriptor' in spec) {
        const inner = spec.descriptor;
        descriptors = Array.isArray(inner) ? inner : [inner];
        optional = spec.optional === true;
        description = typeof spec.description === 'string' ? spec.description : undefined;
        defaultValue = spec.default;
    } else {
        descriptors = [spec as ConstraintDescriptor];
    }

    if (descriptors.length === 0) {
        throw new TypeError(`Fields: field '${name}' has an empty descriptor stack`);
    }
    for (const descriptor of descriptors) {
        if (
            !descriptor ||
            typeof descriptor.toJSON !== 'function' ||
            typeof descriptor.predicate !== 'function'
        ) {
            throw new TypeError(
                `Fields: field '${name}' must be a ConstraintDescriptor (e.g. StringContracts.NotEmpty()). A ` +
                    'hand-written closure carries no identity or params and cannot be composed (DEC-050).',
            );
        }
    }

    return {
        stack: descriptors.map(descriptor => descriptor.toJSON()),
        ...(optional ? {optional: true} : {}),
        ...(description !== undefined ? {description} : {}),
        ...(defaultValue !== undefined ? {default: defaultValue} : {}),
    };
}
