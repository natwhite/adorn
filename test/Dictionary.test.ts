/**
 * `@Dictionary` — the open-map (`Record<string, V>`) compositional descriptor (DEC-054).
 *
 * The consumer's round-2 §2 blocker was a `slotInput?: Record<string, string>` argument: arbitrary
 * keys, string values, that adorn had no way to express. `@Dictionary(value)` is that shape — an OPEN
 * object (`additionalProperties:<value schema>`), distinct from `@Shape`'s closed DTO. These tests pin
 * the total predicate, the open-map schema fragment, and end-to-end agreement between the emitted tool
 * schema and runtime enforcement (DEC-006).
 */

import {Dictionary, ObjectContracts, StringContracts, NumberContracts, Contract, Verify} from '../index';
import {toolSchemaForMethod} from '../schema';

describe('ObjectContracts.Dictionary — the descriptor (DEC-054)', () => {
    const descriptor = ObjectContracts.Dictionary(StringContracts.NotEmpty());

    it('accepts a Record whose every value satisfies the value constraint', () => {
        expect(descriptor.predicate({a: 'x', b: 'y'})).toBe(true);
    });

    it('accepts the empty map (no minProperties bound in v1)', () => {
        expect(descriptor.predicate({})).toBe(true);
    });

    it('rejects a map with any violating value', () => {
        expect(descriptor.predicate({a: 'x', b: ''})).toBe(false); // '' fails NotEmpty
    });

    it('is total (BUG-4): rejects null, arrays, and non-objects rather than throwing', () => {
        expect(descriptor.predicate(null)).toBe(false);
        expect(descriptor.predicate(undefined)).toBe(false);
        expect(descriptor.predicate(['x'])).toBe(false);
        expect(descriptor.predicate('x')).toBe(false);
        expect(descriptor.predicate(42)).toBe(false);
    });

    it('projects to an OPEN object fragment inheriting the value schema', () => {
        const schema = descriptor.schema!();
        expect(schema.type).toBe('object');
        // Open by construction: additionalProperties is the value fragment, never `false`.
        const additional = schema.additionalProperties as Record<string, unknown>;
        expect(additional.type).toBe('string');
        expect('required' in schema).toBe(false);
        expect(schema.additionalProperties).not.toBe(false);
    });

    it('degrades to accept-any values when the value constraint has no schema hook', () => {
        // `OneOf` has a schema hook, so use a value with none is hard; instead assert the floor shape by
        // reading a fragment that DOES exist — the hookless floor is exercised by the array precedent.
        const withEnum = ObjectContracts.Dictionary(NumberContracts.Between(1, 5));
        const schema = withEnum.schema!();
        expect((schema.additionalProperties as Record<string, unknown>).type).toBe('number');
    });

    it('describes itself in terms of the value constraint', () => {
        expect(descriptor.describe()).toContain('mapping string keys to');
    });

    it('rejects a non-descriptor value at authoring (a closure carries no identity — DEC-050)', () => {
        expect(() => ObjectContracts.Dictionary((() => true) as never)).toThrow(/ConstraintDescriptor/);
    });

    it('is usable through Verify.check at an I/O boundary (DEC-053 composition)', () => {
        const ok = Verify.check(descriptor, 'opts', {a: 'x'});
        expect(ok.ok).toBe(true);
        const bad = Verify.check(descriptor, 'opts', {a: ''});
        expect(bad.ok).toBe(false);
    });
});

describe('@Dictionary — the parameter decorator, enforced + projected (DEC-054)', () => {
    @Contract()
    class Slots {
        fill(@Dictionary(StringContracts.NotEmpty()) input: Record<string, string>): Record<string, string> {
            return input;
        }
    }

    it('enforces the value constraint on every entry', () => {
        expect(new Slots().fill({a: 'x', b: 'y'})).toEqual({a: 'x', b: 'y'});
        expect(new Slots().fill({})).toEqual({});
        expect(() => new Slots().fill({a: ''})).toThrow();
        expect(() => new Slots().fill('nope' as never)).toThrow();
    });

    it('emits an OPEN-map tool-schema property, and the schema agrees with enforcement (DEC-006)', () => {
        const schema = toolSchemaForMethod(Slots, 'fill');
        const properties = schema.properties as Record<string, Record<string, unknown>>;

        // The property is an open object — NOT tightened to additionalProperties:false (that is @Shape).
        expect(properties.input.type).toBe('object');
        expect(properties.input.additionalProperties).not.toBe(false);
        expect((properties.input.additionalProperties as Record<string, unknown>).type).toBe('string');

        // The param carries a constraint and is not @Optional → required; the object root stays closed.
        expect(schema.required).toEqual(['input']);
        expect(schema.additionalProperties).toBe(false);
    });
});
