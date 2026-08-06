/**
 * `toolSchemaFrom` — the descriptor-first tool schema (DEC-061 / IDEA-30 / round-3 §5).
 *
 * Builds the same prescriptive envelope as `toolSchemaForMethod` from named descriptors, no class required
 * — so a PER-SESSION enum projects at runtime. The headline test is byte-equality against the decorated
 * equivalent, which proves it REUSES `toolSchemaForMethod`'s internals rather than forking them.
 */

import {
    toolSchemaFrom,
    toolSchemaForMethod,
    Contract,
    Between,
    OneOf,
    NumberContracts,
    EnumContracts,
    ObjectContracts,
    ArrayContracts,
    StringContracts,
    Enforce,
} from '../index';

describe('toolSchemaFrom — descriptor-first tool schema (DEC-061)', () => {
    it('byte-equals toolSchemaForMethod for an equivalent decorated method (reuse, not fork)', () => {
        @Contract()
        class Weather {
            forecast(@Between(1, 7) days: number, @OneOf(['c', 'f']) unit: string) {
                return {days, unit};
            }
        }
        const fromMethod = toolSchemaForMethod(Weather, 'forecast');
        const fromDescriptors = toolSchemaFrom({
            name: 'Weather.forecast',
            params: {
                days: NumberContracts.Between(1, 7),
                unit: EnumContracts.OneOf(['c', 'f']),
            },
        });
        expect(fromDescriptors).toEqual(fromMethod);
    });

    it('projects a PER-SESSION enum with no class — the runtime-roster case', () => {
        const roster = ['p-dave', 'p-erin']; // known only at "session start"
        const schema = toolSchemaFrom({
            name: 'affirmFor',
            params: {subjects: ArrayContracts.ArrayOf(EnumContracts.OneOf(roster))},
        });
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.subjects.type).toBe('array');
        expect((props.subjects.items as Record<string, unknown>).enum).toEqual(roster);
        expect(schema.required).toEqual(['subjects']);
        expect(schema.additionalProperties).toBe(false);
    });

    it('honours optional / description / default in a ToolParamSpec', () => {
        const schema = toolSchemaFrom({
            params: {
                city: {descriptor: StringContracts.NotEmpty(), description: 'the city to look up'},
                days: {descriptor: NumberContracts.Between(1, 7), optional: true, default: 3},
            },
        });
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.city.description).toBe('the city to look up');
        expect(props.days.default).toBe(3);
        // `days` is optional → not required; `city` carries a constraint → required.
        expect(schema.required).toEqual(['city']);
    });

    it('recursively tightens a @Shape param via the SAME tightenObjects', () => {
        class Point {
            @Enforce.greaterThanEqual(0) x!: number;
            @Enforce.greaterThanEqual(0) y!: number;
        }
        const schema = toolSchemaFrom({params: {at: ObjectContracts.Shape(Point)}});
        const at = (schema.properties as Record<string, Record<string, unknown>>).at;
        expect(at.type).toBe('object');
        expect((at.required as string[]).slice().sort()).toEqual(['x', 'y']);
        expect(at.additionalProperties).toBe(false);
    });

    it('accepts a bare descriptor OR a spec, and a stacked-descriptor array (inside a spec)', () => {
        const schema = toolSchemaFrom({
            params: {n: {descriptor: [NumberContracts.GreaterThanEqual(1), NumberContracts.LessThanEqual(10)]}},
        });
        const n = (schema.properties as Record<string, Record<string, unknown>>).n;
        expect(n.minimum).toBe(1);
        expect(n.maximum).toBe(10);
    });

    it('throws on malformed input', () => {
        expect(() => toolSchemaFrom({} as never)).toThrow(/params/);
    });
});
