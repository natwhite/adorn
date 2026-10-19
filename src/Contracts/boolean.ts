/**
 * The boolean primitive-type descriptor (axiform feedback 2026-10-18 §3).
 *
 * The third of the three bare type descriptors every consumer mapping a type system onto adorn ends up
 * writing. Before this, a boolean had to be expressed as `EnumContracts.OneOf([true, false])` — which works
 * and projects to `{enum: [true, false]}`, but says "a two-member enum" where the author means "a boolean".
 * `Bool()` states the type: `typeof value === 'boolean'`, projecting to the exact `{type: 'boolean'}` keyword.
 *
 * Its own tiny namespace — `BooleanContracts`, a sibling of `NumberContracts`/`StringContracts` — rather than
 * a member of `EnumContracts`, because a boolean is a primitive *type*, not a membership set. `kind` is
 * `'generic'` since `ConstraintKind` has no `'boolean'` domain (the tag drives message grouping, not the
 * schema, which is explicit here). Decorator-agnostic (DEC-012); the predicate is derived from the (empty)
 * params, never attached, so it round-trips through `toJSON()`/`constraintFromJSON` like every built-in.
 */

import {defineConstraint, JsonObject} from '../Core/Descriptor';

export const booleanConstraint = defineConstraint<JsonObject, boolean>({
    kind: 'generic',
    constraint: 'boolean',
    derive: () => (value: unknown) => typeof value === 'boolean',
    describe: () => 'a boolean',
    schema: () => ({type: 'boolean'}),
});

/** Accepts `true` or `false`, rejects every other value. The bare boolean type (axiform feedback §3). */
export function Bool() {
    return booleanConstraint({});
}
