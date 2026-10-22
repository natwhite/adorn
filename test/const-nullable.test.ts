/**
 * `@Const` and `@Nullable` — the Wave-2 polish tier (DEC-056).
 *
 * `@Const(v)` is the single-literal sibling of `@OneOf` (`{const:v}`); `@Nullable(item)` is the
 * compositional combinator that widens any constraint to also accept `null` (distinct from `@Optional`'s
 * "may be absent"). Both project exactly and both compose end-to-end with enforcement.
 */

import {
    Const,
    Nullable,
    EnumContracts,
    NullableContracts,
    NumberContracts,
    StringContracts,
    Contract,
    Verify,
} from '../index';
import {toolSchemaForMethod} from '../schema';

describe('@Const — a single allowed literal (DEC-056)', () => {
    const descriptor = EnumContracts.Const('celsius');

    it('accepts exactly the value and rejects everything else (strict equality, total)', () => {
        expect(descriptor.predicate('celsius')).toBe(true);
        expect(descriptor.predicate('fahrenheit')).toBe(false);
        expect(descriptor.predicate(null)).toBe(false);
        expect(descriptor.predicate(undefined)).toBe(false);
        // No coercion: a same-looking wrong type is rejected.
        expect(EnumContracts.Const(2).predicate('2')).toBe(false);
    });

    it('projects to the exact {const} keyword', () => {
        expect(descriptor.schema!()).toEqual({const: 'celsius'});
    });

    it('describes itself as the literal', () => {
        expect(descriptor.describe()).toBe('exactly "celsius"');
    });

    it('rejects a non-primitive literal at authoring', () => {
        expect(() => EnumContracts.Const({} as never)).toThrow(/string, number, boolean, or null/);
    });

    it('enforces and projects through the @Const decorator (schema ⇔ enforcement, DEC-006)', () => {
        @Contract()
        class Reading {
            record(@Const('celsius') unit: string) {
                return unit;
            }
        }
        expect(new Reading().record('celsius')).toBe('celsius');
        expect(() => new Reading().record('kelvin')).toThrow();

        const schema = toolSchemaForMethod(Reading, 'record');
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.unit).toEqual({const: 'celsius'});
        expect(schema.required).toEqual(['unit']);
    });
});

describe('@Nullable — the null-widening combinator (DEC-056)', () => {
    const descriptor = NullableContracts.Nullable(NumberContracts.GreaterThanEqual(0));

    it('accepts null OR a valid item, and rejects an invalid item (or undefined)', () => {
        expect(descriptor.predicate(null)).toBe(true);
        expect(descriptor.predicate(5)).toBe(true);
        expect(descriptor.predicate(-1)).toBe(false);
        // Nullable is "may be null", NOT "may be absent" — undefined is still rejected.
        expect(descriptor.predicate(undefined)).toBe(false);
    });

    it('widens a single-typed fragment by adding "null" to its type', () => {
        expect(descriptor.schema!()).toEqual({type: ['number', 'null'], minimum: 0});
    });

    it('expresses an enum inner as an anyOf union that still admits null (voice-agent L2 / DEC-072)', () => {
        const nullableEnum = NullableContracts.Nullable(EnumContracts.OneOf(['a', 'b']));
        // The enum now carries `type` (DEC-072). Nullable must NOT widen to `type:['string','null']` here —
        // `enum` bites both branches, so that would reject null. The anyOf branch keeps it exact.
        expect(nullableEnum.schema!()).toEqual({
            anyOf: [{type: 'string', enum: ['a', 'b']}, {type: 'null'}],
        });
        // Schema and predicate agree: null is accepted, a non-member is not.
        expect(nullableEnum.predicate(null)).toBe(true);
        expect(nullableEnum.predicate('a')).toBe(true);
        expect(nullableEnum.predicate('z')).toBe(false);
    });

    it('describes itself as "<item> or null"', () => {
        expect(descriptor.describe()).toContain('or null');
    });

    it('rejects a non-descriptor item at authoring', () => {
        expect(() => NullableContracts.Nullable((() => true) as never)).toThrow(/ConstraintDescriptor/);
    });

    it('enforces, and stays REQUIRED in the tool schema (nullable ≠ optional, DEC-006)', () => {
        @Contract()
        class Score {
            save(@Nullable(NumberContracts.GreaterThanEqual(0)) value: number | null) {
                return value;
            }
        }
        expect(new Score().save(3)).toBe(3);
        expect(new Score().save(null)).toBe(null);
        expect(() => new Score().save(-1)).toThrow();

        const schema = toolSchemaForMethod(Score, 'save');
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.value.type).toEqual(['number', 'null']);
        // Nullable is a constraint, and not @Optional, so the property is still required.
        expect(schema.required).toEqual(['value']);
    });

    it('composes with Verify.check at an I/O boundary (DEC-053)', () => {
        expect(Verify.check(descriptor, 'v', null).ok).toBe(true);
        expect(Verify.check(descriptor, 'v', 2).ok).toBe(true);
        expect(Verify.check(descriptor, 'v', -5).ok).toBe(false);
    });
});
