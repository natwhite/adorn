/**
 * `ObjectContracts.Fields` — a fixed-key object LITERAL with optional-aware fields (round-4 §2.1, DEC-065).
 *
 * The descriptor-first sibling of `@Shape`: one literal drives BOTH the validator (`Verify.check`, narrowing)
 * AND the tool schema (`toolSchemaFrom`), so schema and validator cannot drift — the property adorn exists
 * to guarantee, at the commonest shape (an object with an optional field). The narrowing is proven in
 * `typed-descriptors.test.ts`; this file covers runtime behaviour and the no-drift round-trip.
 */

import {
    Verify,
    ObjectContracts,
    NumberContracts,
    StringContracts,
    EnumContracts,
    toolSchemaFrom,
} from '../index';

const {Fields} = ObjectContracts;

// The discriminated `CheckResult` doesn't narrow cleanly under the repo's `strict:false` (same quirk the
// Verify/locate tests handle), so read a failure through this cast rather than `if (!r.ok)` narrowing.
type Fail = {
    ok: false;
    message: string;
    constraint: string;
    kind: string;
    path?: ReadonlyArray<string | number>;
    expected?: string;
};
function asFail<T>(r: {ok: true; value: T} | Fail): Fail {
    if (r.ok) throw new Error('expected a violation');
    return r as Fail;
}

describe('Fields — predicate (optional-aware)', () => {
    const body = Fields({
        seq: NumberContracts.Integer(),
        note: {descriptor: StringContracts.NotEmpty(), optional: true},
    });

    it('accepts required-present with the optional absent', () => {
        expect(Verify.check(body, 'b', {seq: 3}).ok).toBe(true);
    });

    it('accepts required-present with the optional present-and-valid', () => {
        expect(Verify.check(body, 'b', {seq: 3, note: 'hi'}).ok).toBe(true);
    });

    it('rejects a missing REQUIRED field (unlike a bare field constraint)', () => {
        expect(Verify.check(body, 'b', {note: 'hi'}).ok).toBe(false);
    });

    it('rejects an INVALID optional field when it IS present', () => {
        expect(Verify.check(body, 'b', {seq: 3, note: ''}).ok).toBe(false);
    });

    it('rejects an invalid required field', () => {
        expect(Verify.check(body, 'b', {seq: 1.5}).ok).toBe(false);
    });

    it('treats an explicit `undefined` optional as absent', () => {
        expect(Verify.check(body, 'b', {seq: 3, note: undefined}).ok).toBe(true);
    });

    it('accepts EXTRA keys — under-claim, like isShape (additionalProperties:false is prescriptive-only)', () => {
        expect(Verify.check(body, 'b', {seq: 3, extra: 'x'}).ok).toBe(true);
    });

    it('rejects a non-plain-object', () => {
        expect(Verify.check(body, 'b', 'nope').ok).toBe(false);
        expect(Verify.check(body, 'b', null).ok).toBe(false);
        expect(Verify.check(body, 'b', [1, 2]).ok).toBe(false);
    });
});

describe('Fields — locate / expected (DEC-060, round-4 §2.2)', () => {
    it('points at the failing field with the innermost `expected`', () => {
        const body = Fields({seq: NumberContracts.Integer(), tag: EnumContracts.OneOf(['a', 'b'])});
        const fail = asFail(Verify.check(body, 'b', {seq: 1, tag: 'z'}));
        expect(fail.path).toEqual(['tag']);
        expect(fail.expected).toBe(EnumContracts.OneOf(['a', 'b']).describe());
    });

    it('gives a DEEP path for a nested Fields', () => {
        const body = Fields({slot: Fields({when: StringContracts.NotEmpty()})});
        const fail = asFail(Verify.check(body, 'b', {slot: {when: ''}}));
        expect(fail.path).toEqual(['slot', 'when']);
        expect(fail.expected).toBe(StringContracts.NotEmpty().describe());
    });

    it('reports a missing REQUIRED field at its path', () => {
        expect(asFail(Verify.check(Fields({seq: NumberContracts.Integer()}), 'b', {})).path).toEqual(['seq']);
    });
});

describe('Fields — schema + the no-drift round-trip (round-4 §2.1)', () => {
    it('emits required = the NON-optional subset', () => {
        const body = Fields({
            seq: NumberContracts.Integer(),
            note: {descriptor: StringContracts.NotEmpty(), optional: true},
        });
        const schema = body.schema!();
        expect(schema.type).toBe('object');
        expect(schema.required).toEqual(['seq']); // `note` is optional → NOT required
        expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(['note', 'seq']);
    });

    it('ONE literal drives Verify.check AND toolSchemaFrom, and they AGREE on required', () => {
        const spec = {
            seq: NumberContracts.Integer(),
            note: {descriptor: StringContracts.NotEmpty(), optional: true},
        };
        // the validator, over the spec
        const validator = Fields(spec);
        expect(Verify.check(validator, 'b', {seq: 1}).ok).toBe(true); // optional omitted → ok
        expect(Verify.check(validator, 'b', {note: 'x'}).ok).toBe(false); // required missing → not ok

        // the tool schema, over the SAME spec — required must match the validator's required-set
        expect(toolSchemaFrom({params: spec}).required).toEqual(['seq']);

        // and the Fields DESCRIPTOR passed straight to toolSchemaFrom tightens identically
        const nested = toolSchemaFrom({params: {body: validator}});
        const bodyProp = (nested.properties as Record<string, Record<string, unknown>>).body;
        expect(bodyProp.type).toBe('object');
        expect(bodyProp.required).toEqual(['seq']);
        expect(bodyProp.additionalProperties).toBe(false);
    });

    it('a nested Fields keeps the optional field OUT of required (tightenObjects respects it)', () => {
        const schema = toolSchemaFrom({
            params: {
                at: Fields({
                    when: StringContracts.NotEmpty(),
                    label: {descriptor: StringContracts.NotEmpty(), optional: true},
                }),
            },
        });
        const at = (schema.properties as Record<string, Record<string, unknown>>).at;
        expect(at.required).toEqual(['when']); // `label` optional → not required
        expect(at.additionalProperties).toBe(false);
    });

    it('throws on an empty Fields and on a non-descriptor field', () => {
        expect(() => Fields({})).toThrow(/at least one field/);
        expect(() => Fields({x: (() => true) as never})).toThrow(/ConstraintDescriptor/);
    });
});
