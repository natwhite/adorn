/**
 * Unit tests for the reified enum/membership descriptor (`@OneOf`, IDEA-21 / GAP-14) and its flow
 * into enforcement and the projections.
 *
 * No `resetRegistry()` here, for the reason `docs.decorators.test.ts` gives: field enforcement reads
 * the registry on every assignment, so resetting mid-file would disarm an installed accessor. Every
 * class below is declared *inside* its test and is a fresh constructor, so registry entries never
 * collide and nothing needs resetting.
 */

import {constraintFromJSON} from '../Core/Descriptor';
import {recordFieldConstraint, recordParameterConstraint} from '../Core/ContractRegistry';
import * as Enums from './enum';
import {schemaForClass} from '../Projections/schema';
import {documentClass, renderMarkdown} from '../Projections/docs';
import {Contract} from '../Adapters/legacy/ContractInstaller';
import {OneOf} from '../ParameterDecorators/Constraints';
import {CreateFieldDecorator} from '../Adapters/legacy/FieldDecoratorFactory';
import {Verify} from '../Validation/Verify';

/** Everything a predicate must survive without throwing, and (mostly) reject. */
const HOSTILE: unknown[] = [null, undefined, NaN, '', 'abc', {}, [], () => 0, true, false, Symbol('s')];

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

describe('the oneOf descriptor', () => {
    it('is a generic-kind membership constraint carrying its members as params', () => {
        const descriptor = Enums.OneOf(['celsius', 'fahrenheit']);

        expect(descriptor.kind).toBe('generic');
        expect(descriptor.constraint).toBe('oneOf');
        expect(descriptor.params).toEqual({values: ['celsius', 'fahrenheit']});
    });

    it('accepts a member and rejects a non-member', () => {
        const descriptor = Enums.OneOf(['celsius', 'fahrenheit']);

        expect(descriptor.predicate('celsius')).toBe(true);
        expect(descriptor.predicate('fahrenheit')).toBe(true);
        expect(descriptor.predicate('kelvin')).toBe(false);
    });

    it('is strict — a wrong-typed value equal only under coercion is NOT a member', () => {
        const descriptor = Enums.OneOf([1, 2, 3]);

        expect(descriptor.predicate(1)).toBe(true);
        expect(descriptor.predicate('1')).toBe(false); // string is not the number
        expect(descriptor.predicate(4)).toBe(false);
    });

    it('supports mixed primitive members, including null and booleans', () => {
        const descriptor = Enums.OneOf(['x', 2, true, null]);

        ['x', 2, true, null].forEach(value => expect(descriptor.predicate(value)).toBe(true));
        [false, 'y', 3, undefined].forEach(value => expect(descriptor.predicate(value)).toBe(false));
    });

    it('is total (BUG-4): never throws and always returns a boolean, rejecting null/undefined', () => {
        const descriptor = Enums.OneOf(['a', 'b']);

        HOSTILE.forEach(value => {
            expect(() => descriptor.predicate(value)).not.toThrow();
            expect(typeof descriptor.predicate(value)).toBe('boolean');
        });
        expect(descriptor.predicate(null)).toBe(false);
        expect(descriptor.predicate(undefined)).toBe(false);
    });

    it('emits schema() = {type, enum} for a homogeneous enum (voice-agent L2 / DEC-072)', () => {
        expect(Enums.OneOf(['celsius', 'fahrenheit']).schema!()).toEqual({
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
        });
        expect(Enums.OneOf([1, 2, 3]).schema!()).toEqual({type: 'number', enum: [1, 2, 3]});
        expect(Enums.OneOf([true, false]).schema!()).toEqual({type: 'boolean', enum: [true, false]});
    });

    it('omits type for a heterogeneous enum — none is true (DEC-072)', () => {
        expect(Enums.OneOf(['a', 1]).schema!()).toEqual({enum: ['a', 1]});
    });

    it('hands schema() a fresh array, never the frozen params array', () => {
        const descriptor = Enums.OneOf(['a', 'b']);
        const fragment = descriptor.schema!() as {enum: unknown[]};

        expect(fragment.enum).toEqual(descriptor.params.values);
        expect(fragment.enum).not.toBe(descriptor.params.values);
    });

    it('describes membership as JSON-rendered prose (unambiguous about type)', () => {
        expect(Enums.OneOf(['celsius', 'fahrenheit']).describe()).toBe('one of "celsius", "fahrenheit"');
        expect(Enums.OneOf([1, 2, 3]).describe()).toBe('one of 1, 2, 3');
        expect(Enums.OneOf([true, false]).describe()).toBe('one of true, false');
    });

    it('never over-claims: {enum} accepts EXACTLY what the predicate accepts', () => {
        const descriptor = Enums.OneOf(['celsius', 'fahrenheit']);
        const members = (descriptor.schema!() as {enum: unknown[]}).enum;

        members.forEach(member => expect(descriptor.predicate(member)).toBe(true));
        expect(members.includes('kelvin')).toBe(false);
        expect(descriptor.predicate('kelvin')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Authoring validation
// ---------------------------------------------------------------------------

describe('oneOf authoring validation', () => {
    it('rejects an empty member set', () => {
        expect(() => Enums.OneOf([])).toThrow(/non-empty array/);
    });

    it('rejects a non-array', () => {
        expect(() => Enums.OneOf('celsius' as unknown as string[])).toThrow(/non-empty array/);
    });

    it('rejects a non-primitive member', () => {
        expect(() => Enums.OneOf([{} as unknown as string])).toThrow(/string, number, boolean, or null/);
        expect(() => Enums.OneOf([[1, 2] as unknown as string])).toThrow(/string, number, boolean, or null/);
        expect(() => Enums.OneOf([undefined as unknown as string])).toThrow(
            /string, number, boolean, or null/,
        );
    });

    it('rejects a non-finite number member — it is not JSON-serialisable', () => {
        expect(() => Enums.OneOf([NaN as unknown as number])).toThrow(/string, number, boolean, or null/);
        expect(() => Enums.OneOf([Infinity as unknown as number])).toThrow(
            /string, number, boolean, or null/,
        );
    });
});

// ---------------------------------------------------------------------------
// Round-trip (DEC-010)
// ---------------------------------------------------------------------------

describe('oneOf round-trips through JSON (DEC-010)', () => {
    it('serialises to identity + params only', () => {
        expect(JSON.parse(JSON.stringify(Enums.OneOf(['a', 'b'])))).toEqual({
            kind: 'generic',
            constraint: 'oneOf',
            params: {values: ['a', 'b']},
        });
    });

    it('rehydrates into an identically-enforcing descriptor', () => {
        const descriptor = Enums.OneOf(['celsius', 'fahrenheit', 42]);
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

        expect(revived.describe()).toBe(descriptor.describe());
        ['celsius', 42, 'kelvin', 0, null, undefined].forEach(value => {
            expect(revived.predicate(value)).toBe(descriptor.predicate(value));
        });
    });
});

// ---------------------------------------------------------------------------
// The projections include the enum
// ---------------------------------------------------------------------------

describe('the projections surface the enum', () => {
    it('the schema projection emits {enum} for a @OneOf field', () => {
        class Reading {}
        recordFieldConstraint(Reading.prototype, 'unit', Enums.OneOf(['celsius', 'fahrenheit']));

        const properties = schemaForClass(Reading).properties as Record<string, unknown>;
        expect(properties.unit).toEqual({type: 'string', enum: ['celsius', 'fahrenheit']});
    });

    it('the schema projection emits {enum} in a method prefixItems tuple', () => {
        class Api {
            call(_unit: string) {
                /* no-op */
            }
        }
        recordParameterConstraint(Api.prototype, 'call', 0, Enums.OneOf(['a', 'b']));

        const call = (schemaForClass(Api).methods as Record<string, {prefixItems: unknown[]}>).call;
        expect(call.prefixItems).toEqual([{type: 'string', enum: ['a', 'b']}]);
    });

    it('the docs projection renders the membership prose', () => {
        class Reading {}
        recordFieldConstraint(Reading.prototype, 'unit', Enums.OneOf(['celsius', 'fahrenheit']));

        const doc = documentClass(Reading);
        const constraint = doc.fields[0].constraints[0];

        expect(constraint.constraint).toBe('oneOf');
        expect(constraint.kind).toBe('generic');
        expect(constraint.expectation).toBe('one of "celsius", "fahrenheit"');
        expect(renderMarkdown([doc])).toContain('one of "celsius", "fahrenheit"');
    });
});

// ---------------------------------------------------------------------------
// End-to-end enforcement, on every layer a descriptor reaches
// ---------------------------------------------------------------------------

describe('@OneOf enforces membership end-to-end', () => {
    it('as a parameter constraint, rejects a non-member with a proper contract violation', () => {
        @Contract()
        class Thermostat {
            setUnit(@OneOf(['celsius', 'fahrenheit']) unit: string) {
                return unit;
            }
        }

        const thermostat = new Thermostat();
        expect(thermostat.setUnit('celsius')).toBe('celsius');

        let message = '';
        try {
            thermostat.setUnit('kelvin');
        } catch (error) {
            message = (error as Error).message;
        }
        // A real violation naming the parameter and stating the descriptor's own expectation.
        expect(message).toContain("parameter 'unit'");
        expect(message).toContain('expected one of "celsius", "fahrenheit"');
    });

    it('as a field constraint via CreateFieldDecorator — no new field decorator needed', () => {
        class LogConfig {
            @CreateFieldDecorator(Enums.OneOf(['debug', 'info', 'warn']))
            level: string = 'info';
        }

        const config = new LogConfig();
        expect(config.level).toBe('info'); // the initializer was validated and read back (not undefined)

        config.level = 'warn';
        expect(config.level).toBe('warn');

        expect(() => {
            config.level = 'verbose';
        }).toThrow(/one of/);
    });

    it('as an imperative assertion via Verify.that', () => {
        expect(Verify.that(Enums.OneOf(['a', 'b']), 'choice', 'a')).toBe('a');
        expect(() => Verify.that(Enums.OneOf(['a', 'b']), 'choice', 'z')).toThrow(/one of "a", "b"/);
    });
});
