/**
 * `defineConstraint` — the custom-constraint authoring surface (round-4 §2.3 / Slice C).
 *
 * GAP-22 exported the `ConstraintDescriptor` TYPE but not the factory that builds one, so a consumer could
 * name a custom constraint but not make it. This proves a consumer can now define a constraint from data
 * (DEC-050) and use it in `Verify.check` (with narrowing) and `toolSchemaFrom` exactly like a built-in.
 */

import {defineConstraint, Verify, toolSchemaFrom} from '../index';
import type {ConstraintDescriptor, JsonObject} from '../index';

// A consumer-authored constraint. `Out = number` so `Verify.check` narrows `unknown` to `number`.
const evenConstraint = defineConstraint<JsonObject, number>({
    kind: 'number',
    constraint: 'custom.even.v1',
    derive: () => (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v % 2 === 0,
    describe: () => 'an even integer',
    schema: () => ({type: 'integer', multipleOf: 2}),
});
const Even = (): ConstraintDescriptor<JsonObject, number> => evenConstraint({});

describe('defineConstraint — a custom constraint behaves like a built-in', () => {
    it('validates through Verify.check (accept + reject)', () => {
        expect(Verify.check(Even(), 'n', 4).ok).toBe(true);
        expect(Verify.check(Even(), 'n', 3).ok).toBe(false);
        expect(Verify.check(Even(), 'n', 'four').ok).toBe(false);
    });

    it('narrows the output type', () => {
        const r = Verify.check(Even(), 'n', 8);
        if (r.ok) {
            // A compile-time check: `r.value` is `number`, usable arithmetically without a cast.
            const doubled: number = r.value * 2;
            expect(doubled).toBe(16);
        } else {
            throw new Error('expected ok');
        }
    });

    it('projects into a descriptor-first tool schema', () => {
        const schema = toolSchemaFrom({params: {n: Even()}});
        const n = (schema.properties as Record<string, Record<string, unknown>>).n;
        expect(n.type).toBe('integer');
        expect(n.multipleOf).toBe(2);
        expect(schema.required).toEqual(['n']);
    });

    it('rejects a hand-written definition with no derive (predicates come from params, DEC-010)', () => {
        expect(() =>
            defineConstraint({constraint: 'custom.broken', kind: 'generic'} as never),
        ).toThrow(/derive/);
    });
});
