/**
 * `@Shape` — the closed-DTO compositional descriptor (DEC-055), and the recursive prescriptive
 * tightening in `toolSchemaForMethod`.
 *
 * `@Shape(FieldClass)` validates an object against `FieldClass`'s `@Contract`ed instance fields. The
 * risk surface is the tool-schema tightening: the descriptive `schema()` hook emits an OPEN object
 * (`{type:'object', properties}`), and `toolSchemaForMethod` closes it recursively (`required` +
 * `additionalProperties:false`). These tests pin the total predicate, the descriptive-vs-prescriptive
 * posture split, the empty-shape throw (MAJOR-3), and — the load-bearing one — that the tool schema's
 * `required` matches exactly what enforcement requires (no drift, DEC-006).
 */

import {Shape, ArrayOf, Dictionary, Enforce, ObjectContracts, Contract, Verify} from '../index';
import {toolSchemaForMethod, schemaForClass} from '../schema';

// A contracted field class, decorated BEFORE anything that `@Shape`s it (DEC-007 ordering).
class Point {
    @Enforce.greaterThanEqual(0) x!: number;
    @Enforce.greaterThanEqual(0) y!: number;
}

// A class with no contracted instance fields — the MAJOR-3 empty-shape case.
class Bare {}

describe('ObjectContracts.Shape — the descriptor (DEC-055)', () => {
    const shape = ObjectContracts.Shape(Point);

    it('accepts an object whose every field satisfies its constraints', () => {
        expect(shape.predicate({x: 1, y: 2})).toBe(true);
        expect(shape.predicate({x: 0, y: 0})).toBe(true);
    });

    it('requires every contracted field — a missing field is rejected (DEC-055/MAJOR-2)', () => {
        expect(shape.predicate({x: 1})).toBe(false); // y missing → total field predicate rejects undefined
        expect(shape.predicate({})).toBe(false);
    });

    it('rejects an invalid field value', () => {
        expect(shape.predicate({x: -1, y: 2})).toBe(false);
    });

    it('is total (BUG-4): rejects null, arrays, and non-objects', () => {
        expect(shape.predicate(null)).toBe(false);
        expect(shape.predicate(undefined)).toBe(false);
        expect(shape.predicate([1, 2])).toBe(false);
        expect(shape.predicate('x')).toBe(false);
    });

    it('projects DESCRIPTIVELY — properties only, NO required/additionalProperties (DEC-029)', () => {
        const s = shape.schema!();
        expect(s.type).toBe('object');
        expect(Object.keys(s.properties as object).sort()).toEqual(['x', 'y']);
        expect('required' in s).toBe(false);
        expect('additionalProperties' in s).toBe(false);
    });

    it('throws on a class with no contracted instance fields — no silent accept-any (MAJOR-3)', () => {
        expect(() => ObjectContracts.Shape(Bare)).toThrow(/no contracted instance fields/);
    });

    it('throws on a non-class', () => {
        expect(() => ObjectContracts.Shape(123 as never)).toThrow();
    });

    it('composes with Verify.check at an I/O boundary (DEC-053)', () => {
        expect(Verify.check(shape, 'point', {x: 1, y: 2}).ok).toBe(true);
        expect(Verify.check(shape, 'point', {x: 1}).ok).toBe(false);
    });
});

describe('@Shape — tool-schema tightening and schema/enforcement parity (DEC-055)', () => {
    @Contract()
    class Geo {
        move(@Shape(Point) to: {x: number; y: number}) {
            return to;
        }
    }

    it('tightens the nested object: required = every field, additionalProperties:false', () => {
        const schema = toolSchemaForMethod(Geo, 'move');
        const to = (schema.properties as Record<string, Record<string, unknown>>).to;
        expect(to.type).toBe('object');
        expect((to.required as string[]).slice().sort()).toEqual(['x', 'y']);
        expect(to.additionalProperties).toBe(false);
    });

    it('the tool schema `required` matches what enforcement requires (no drift, DEC-006)', () => {
        // Runtime rejects a missing field...
        expect(() => new Geo().move({x: 1} as never)).toThrow();
        // ...and the tool schema lists exactly that field as required.
        const schema = toolSchemaForMethod(Geo, 'move');
        const to = (schema.properties as Record<string, Record<string, unknown>>).to;
        expect(to.required).toContain('y');
    });

    it('schemaForClass stays DESCRIPTIVE — the same @Shape is NOT tightened there (DEC-029)', () => {
        const classSchema = schemaForClass(Geo);
        const methods = classSchema.methods as Record<string, Record<string, unknown>>;
        const prefixItems = methods.move.prefixItems as Array<Record<string, unknown>>;
        const to = prefixItems[0];
        expect(to.type).toBe('object');
        expect('required' in to).toBe(false);
        expect('additionalProperties' in to).toBe(false);
    });
});

describe('@Shape nests: the tightener descends arrays and dictionaries (DEC-055)', () => {
    @Contract()
    class Batch {
        points(@ArrayOf(ObjectContracts.Shape(Point)) list: Array<{x: number; y: number}>) {
            return list;
        }
        named(@Dictionary(ObjectContracts.Shape(Point)) map: Record<string, {x: number; y: number}>) {
            return map;
        }
    }

    it('tightens a @Shape inside an @ArrayOf (items closed)', () => {
        const schema = toolSchemaForMethod(Batch, 'points');
        const list = (schema.properties as Record<string, Record<string, unknown>>).list;
        expect(list.type).toBe('array');
        const items = list.items as Record<string, unknown>;
        expect(items.type).toBe('object');
        expect(items.additionalProperties).toBe(false);
        expect((items.required as string[]).slice().sort()).toEqual(['x', 'y']);
    });

    it('tightens a @Shape inside a @Dictionary value, while the dictionary stays OPEN', () => {
        const schema = toolSchemaForMethod(Batch, 'named');
        const map = (schema.properties as Record<string, Record<string, unknown>>).map;
        expect(map.type).toBe('object');
        // The dictionary itself stays open (additionalProperties is a schema, not false)...
        expect(map.additionalProperties).not.toBe(false);
        const valueSchema = map.additionalProperties as Record<string, unknown>;
        // ...but its VALUE @Shape is tightened.
        expect(valueSchema.type).toBe('object');
        expect(valueSchema.additionalProperties).toBe(false);
        expect((valueSchema.required as string[]).slice().sort()).toEqual(['x', 'y']);
    });
});
