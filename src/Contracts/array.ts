/**
 * Array constraints, as descriptors — the DEC-050 compositional mechanism made concrete (IDEA-22 /
 * GAP-15).
 *
 * `@ArrayOf(item, {minItems?, maxItems?})` is the first *compositional* descriptor: its params carry
 * another constraint in **serialised** form (`item: SerializedConstraint`), and its predicate, prose,
 * and schema are all built by rebuilding that inner descriptor with `constraintFromJSON`. It is the
 * proof that a descriptor's `params` can hold a whole other descriptor — which is only type-safe
 * because `SerializedConstraint` is a `type` alias assignable to `JsonObject` (see `Core/Descriptor.ts`
 * and the `PatternSpec` precedent in `./string.ts`).
 *
 * Decorator-agnostic (DEC-012) — see the note in `./number.ts`. The predicate is **derived from
 * params** (DEC-010); there is no `predicate` input in this file.
 *
 * ## The item rides as data, never as a live closure (DEC-050)
 *
 * `ArrayOf(StringContracts.NotEmpty())` stores `item = descriptor.toJSON()` — `{kind, constraint,
 * params}`, plain JSON. It is deep-cloned and re-frozen by `normalizeParams` exactly as any other
 * params object is, so no live function or class reference crosses the boundary and the plain-JSON
 * gate accepts it. A hand-written closure has no `toJSON`, so the {@link ArrayOf} factory rejects it
 * loudly at authoring (SMELL-14 does not leak in silently). The whole thing therefore round-trips
 * through `toJSON()`→`constraintFromJSON` and rehydrates to an identically-enforcing descriptor —
 * including a `matches`/`oneOf` item or a nested `arrayOf(arrayOf(...))`.
 *
 * ## The predicate is total (BUG-4) and rebuilds the item predicate ONCE
 *
 * `derive` rebuilds the item predicate a single time (the same discipline `matches` compiles its
 * RegExp once), then returns a closure that gates the container first — `Array.isArray` before any
 * length or element check — so `null`, `undefined`, a string, or a plain object are simply rejected,
 * never a thrown `TypeError`. Length is checked against `[minItems, maxItems]` (each optional), then
 * **every** element must satisfy the item predicate. An empty array passes with no `minItems`, and
 * fails `minItems: 1`.
 *
 * ## `schema()` inherits the item's own fragment, and may under-claim (never over-claim)
 *
 * The array fragment is `{type: 'array', items: <item's schema()>, minItems?, maxItems?}`. The `items`
 * sub-schema is the item descriptor's own `schema()` output, so every under-claim the item makes
 * (`matches` with flags degrading to `{type:'string'}`, a hookless item degrading to `{}`) is
 * inherited unchanged — this module never re-tightens what an item deliberately loosened. An item with
 * no `schema()` hook contributes `items: {}` (accept-anything), the honest floor.
 *
 * ## `arbitrary` is still shape-only
 *
 * `fast-check` is not a dependency (IDEA-3). The add-on maps `arrayOf` to `fc.array` over the item's
 * own arbitrary, **recursing** through the same bridge, so an array of a generatable kind is sound and
 * an array of a declining kind declines. That mapping lives in `addons/test/arbitraries.ts`, never in
 * core.
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

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * v1: a single item descriptor, carried as its serialised form, with optional length bounds.
 *
 * `item` is a {@link SerializedConstraint}, which is assignable to `JsonObject` only because it is a
 * `type` alias (DEC-050) — the load-bearing typing that makes a compositional descriptor possible.
 * Stacked item constraints (`item: SerializedConstraint[]`) are a deliberate v1.1 extension.
 */
export interface ArrayOfParams extends JsonObject {
    item: SerializedConstraint;
    minItems?: number;
    maxItems?: number;
}

// ---------------------------------------------------------------------------
// Derivation — the single source the predicate comes from (DEC-010)
// ---------------------------------------------------------------------------

/**
 * `Array.isArray` first (totality, BUG-4), then length within the optional bounds, then every element
 * against the item predicate. The item predicate is rebuilt **once**, when this derivation runs, not
 * per call — the same discipline `matches` applies to its RegExp.
 */
const isArrayOf = (params: Readonly<ArrayOfParams>): Predicate => {
    const itemPredicate = constraintFromJSON(params.item).predicate;
    const {minItems, maxItems} = params;
    return (value: unknown) => {
        if (!Array.isArray(value)) return false;
        if (minItems !== undefined && value.length < minItems) return false;
        if (maxItems !== undefined && value.length > maxItems) return false;
        return value.every(itemPredicate);
    };
};

/** `""`, ` (at least 1 item)`, ` (at most 5 items)`, or ` (1..5 items)`. */
function boundsPhrase(minItems?: number, maxItems?: number): string {
    if (minItems !== undefined && maxItems !== undefined) return ` (${minItems}..${maxItems} items)`;
    if (minItems !== undefined) return ` (at least ${minItems} ${pluralItems(minItems)})`;
    if (maxItems !== undefined) return ` (at most ${maxItems} ${pluralItems(maxItems)})`;
    return '';
}

function pluralItems(count: number): string {
    return count === 1 ? 'item' : 'items';
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const arrayOfConstraint = defineConstraint<ArrayOfParams>({
    // Arrays ride `'generic'`, as `oneOf` does — the container is type-agnostic, and the emitted
    // `{type: 'array'}` keyword carries the type the descriptor kind does not.
    kind: 'generic',
    constraint: 'arrayOf',
    derive: isArrayOf,
    // First failing INDEX (DEC-060): container/length failures return `undefined` (→ root) BEFORE the
    // element loop, matching `isArrayOf`'s short-circuit; then the same left-to-right element order.
    locate: params => {
        const inner = constraintFromJSON(params.item);
        const pred = inner.predicate;
        const deeper = inner.locate;
        const {minItems, maxItems} = params;
        return (value: unknown) => {
            if (!Array.isArray(value)) return undefined;
            if (minItems !== undefined && value.length < minItems) return undefined;
            if (maxItems !== undefined && value.length > maxItems) return undefined;
            for (let index = 0; index < value.length; index++) {
                if (!pred(value[index])) {
                    const sub = deeper ? deeper(value[index]) : undefined;
                    return sub
                        ? {path: [index, ...(sub.path ?? [])], expected: sub.expected ?? inner.describe()}
                        : {path: [index], expected: inner.describe()};
                }
            }
            return undefined;
        };
    },
    describe: params =>
        `an array of ${constraintFromJSON(params.item).describe()}` +
        boundsPhrase(params.minItems, params.maxItems),
    schema: params => {
        const inner = constraintFromJSON(params.item);
        // The item's own under-claim is inherited; `{}` is the floor when it supplies no `schema()`.
        const items = inner.schema ? inner.schema() : {};
        const out: JsonObject = {type: 'array', items};
        if (params.minItems !== undefined) out.minItems = params.minItems;
        if (params.maxItems !== undefined) out.maxItems = params.maxItems;
        return out;
    },
});

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

/**
 * A length bound must be a non-negative integer, or absent. Guards the authoring side (mirrors
 * `requireLength` in `./string.ts`): `Descriptor.normalizeParams` refuses a non-finite *number*, but
 * `1.5` or `-1` are valid JSON and would sail through into a nonsensical `{minItems: 1.5}` schema.
 * A bad bound is an author error, so it throws at construction rather than at call time.
 */
function requireCount(constraint: string, name: string, value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new TypeError(
            `${constraint}: \`${name}\` must be a non-negative integer, received ${String(value)}`,
        );
    }
    return value;
}

// ---------------------------------------------------------------------------
// Constraint factory — the authoring surface
// ---------------------------------------------------------------------------

/**
 * A list whose every element satisfies `item`, optionally length-bounded.
 *
 * `item` must be a {@link ConstraintDescriptor} — e.g. `StringContracts.NotEmpty()`,
 * `NumberContracts.GreaterThanEqual(0)`, `EnumContracts.OneOf([...])`, or another `ArrayContracts.
 * ArrayOf(...)` for nesting. It is serialised via its own `toJSON()` and stored as data (DEC-050); a
 * hand-written closure (which has no `toJSON`) is rejected loudly here rather than admitted silently.
 *
 * `minItems`/`maxItems` are each optional non-negative integers; `minItems > maxItems` is an author
 * error and throws (the `Between` precedent — a constraint nothing can satisfy that reads as valid in
 * a generated schema). With no `minItems`, `[]` passes; `minItems: 1` rejects it; `minItems: 0` is
 * allowed and equivalent to omitting it.
 */
export function ArrayOf<V>(
    item: ConstraintDescriptor<ConstraintParams, V>,
    options?: {minItems?: number; maxItems?: number},
): ConstraintDescriptor<ArrayOfParams, V[]> {
    if (!item || typeof item.toJSON !== 'function' || typeof item.predicate !== 'function') {
        throw new TypeError(
            'ArrayOf: `item` must be a ConstraintDescriptor (e.g. StringContracts.NotEmpty()). A ' +
                'hand-written closure carries no identity or params and cannot be composed (DEC-050).',
        );
    }
    const min = requireCount('ArrayOf', 'minItems', options && options.minItems);
    const max = requireCount('ArrayOf', 'maxItems', options && options.maxItems);
    if (min !== undefined && max !== undefined && min > max) {
        throw new RangeError(
            `ArrayOf: \`minItems\` (${min}) must not exceed \`maxItems\` (${max}) — no array could satisfy it`,
        );
    }
    const params: ArrayOfParams = {item: item.toJSON()};
    if (min !== undefined) params.minItems = min;
    if (max !== undefined) params.maxItems = max;
    return arrayOfConstraint(params) as ConstraintDescriptor<ArrayOfParams, V[]>;
}
