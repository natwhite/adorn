/**
 * `@Describe('…')` (parameter) + `@Tool('…')` (method) — record-only description markers (Q-30).
 *
 * These are pure annotations: they never reject a value (posture-neutral). `@Describe` becomes a
 * parameter's `description`; `@Tool` becomes the tool schema's top-level `description`. The load-bearing
 * behaviour is the **S1 union**: the tool-schema projection unions the description bands with the contract
 * band rather than pivoting on the latter, so (a) a `@Tool`-only method with no constrained params still
 * projects (it used to NPE), and (b) a `@Describe` on an *unconstrained* parameter surfaces (it used to be
 * silently dropped). Both flow into the docs projection too.
 *
 * Driven by real `@` decorator syntax; classes are declared inside each test (fresh constructors), so no
 * `resetRegistry` is needed.
 */

import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {GreaterThanEqual, NotEmpty} from '../src/ParameterDecorators/Constraints';
import {Describe} from '../src/Markers/Describe';
import {Tool} from '../src/Markers/Tool';
import {toolSchemaForMethod} from '../src/Projections/schema';
import {documentClass, renderMarkdown} from '../src/Projections/docs';
import {JsonObject} from '../src/Core/Descriptor';

// ---------------------------------------------------------------------------
// S1 — the union, not a pivot on the contract band
// ---------------------------------------------------------------------------

describe('S1: the tool schema unions the marker bands (not a pivot on the contract band)', () => {
    it('a @Tool-only method with NO constrained params projects (used to NPE), carrying its description', () => {
        @Contract()
        class Clock {
            @Tool('Get the current time')
            now(): string {
                return new Date().toISOString();
            }
        }

        // The probe-confirmed NPE case: no contract entry, but the method still projects.
        expect(toolSchemaForMethod(Clock, 'now')).toEqual({
            title: 'Clock.now',
            description: 'Get the current time',
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
        });
    });

    it('a @Describe on an UNCONSTRAINED parameter surfaces in properties (used to be dropped)', () => {
        @Contract()
        class Search {
            find(@NotEmpty() query: string, @Describe('the city to look up') city: string): string {
                return `${query}:${city}`;
            }
        }

        const schema = toolSchemaForMethod(Search, 'find');
        // `city` carries no constraint, yet its @Describe surfaces as {description} over the {} fragment.
        expect((schema.properties as Record<string, JsonObject>).city).toEqual({
            description: 'the city to look up',
        });
        // Unconstrained → not required; the constrained sibling still is.
        expect(schema.required).toEqual(['query']);
    });
});

// ---------------------------------------------------------------------------
// Where the descriptions land, and precedence
// ---------------------------------------------------------------------------

describe('@Describe lands on the property description (no describe() fallback)', () => {
    it('a @Describe`d param carries the @Describe text; an un-@Describe`d one carries NO description', () => {
        @Contract()
        class Weather {
            get(
                @Describe('The city to look up') @NotEmpty() city: string,
                @GreaterThanEqual(1) days: number,
            ): string {
                return `${city}:${days}`;
            }
        }

        const props = toolSchemaForMethod(Weather, 'get').properties as Record<string, JsonObject>;
        // @Describe is the SOLE source of a property description — it does not fall back to the
        // constraint's own describe() prose ("a non-empty string"); the keyword fragment is intact.
        expect(props.city).toEqual({description: 'The city to look up', type: 'string', minLength: 1});
        // No @Describe → no description key at all (the deliberate DEC-048 narrowing, plan §4.3).
        expect('description' in props.days).toBe(false);
        expect(props.days).toEqual({type: 'number', minimum: 1});
    });
});

describe('@Tool lands on the tool-level description; the option overrides it', () => {
    @Contract()
    class Forecast {
        @Tool('Look up a forecast')
        lookup(@NotEmpty() city: string): string {
            return city;
        }
    }

    it('emits the @Tool text as the schema description when no option is given', () => {
        expect(toolSchemaForMethod(Forecast, 'lookup').description).toBe('Look up a forecast');
    });

    it('the toolSchemaForMethod({description}) OPTION overrides @Tool when both are present', () => {
        const schema = toolSchemaForMethod(Forecast, 'lookup', {description: 'A better description'});
        expect(schema.description).toBe('A better description');
    });

    it('a method with neither @Tool nor an option emits no description', () => {
        @Contract()
        class Plain {
            act(@NotEmpty() x: string): string {
                return x;
            }
        }
        expect(toolSchemaForMethod(Plain, 'act').description).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Inheritance — nearest-declaration-wins (a plain annotation, not a precondition)
// ---------------------------------------------------------------------------

describe('description inheritance is nearest-declaration-wins', () => {
    it('an inherited @Tool / @Describe is honoured for an undecorated subclass override', () => {
        @Contract()
        class Base {
            @Tool('base tool')
            act(@Describe('base param') @NotEmpty() x: string): string {
                return x;
            }
        }
        @Contract()
        class Sub extends Base {}

        const schema = toolSchemaForMethod(Sub, 'act');
        expect(schema.description).toBe('base tool');
        expect((schema.properties as Record<string, JsonObject>).x.description).toBe('base param');
    });

    it('a subclass override with its own @Describe shadows the base description (nearest wins)', () => {
        @Contract()
        class Base {
            act(@Describe('base param') @NotEmpty() x: string): string {
                return x;
            }
        }
        @Contract()
        class Sub extends Base {
            act(@Describe('sub param') @NotEmpty() x: string): string {
                return `sub:${x}`;
            }
        }

        expect((toolSchemaForMethod(Sub, 'act').properties as Record<string, JsonObject>).x.description).toBe(
            'sub param',
        );
    });
});

// ---------------------------------------------------------------------------
// Misuse — placement + argument validation
// ---------------------------------------------------------------------------

describe('@Describe / @Tool reject misuse', () => {
    it('@Tool throws when not applied to a method', () => {
        expect(() =>
            (Tool('x') as (t: object, k: string, d?: PropertyDescriptor) => void)({}, 'notAMethod'),
        ).toThrow(/must be applied to a method/);
    });

    it('@Describe throws when not applied to a parameter', () => {
        expect(() => (Describe('x') as (t: object, k?: string) => void)({}, 'method')).toThrow(
            /must be applied to a parameter/,
        );
    });

    it('both reject an empty / non-string text at authoring time', () => {
        expect(() => Tool('')).toThrow(/non-empty string/);
        expect(() => Describe('')).toThrow(/non-empty string/);
        expect(() => Tool(undefined as unknown as string)).toThrow(/non-empty string/);
        expect(() => Describe(42 as unknown as string)).toThrow(/non-empty string/);
    });
});

// ---------------------------------------------------------------------------
// Docs projection shows the descriptions (Q-30)
// ---------------------------------------------------------------------------

describe('the docs projection surfaces @Describe / @Tool', () => {
    @Contract()
    class Weather {
        @Tool('Look up a weather forecast')
        lookup(@Describe('The city to look up') @NotEmpty() city: string): string {
            return city;
        }
    }

    it('carries the descriptions in the docs MODEL', () => {
        const doc = documentClass(Weather);
        const method = doc.methods.find(m => m.name === 'lookup')!;
        expect(method.description).toBe('Look up a weather forecast');
        expect(method.parameters[0].description).toBe('The city to look up');
    });

    it('RENDERS the tool description (heads the section) and a parameter Description column', () => {
        const markdown = renderMarkdown([documentClass(Weather)]);
        expect(markdown).toContain('_Look up a weather forecast_');
        expect(markdown).toContain('| Parameter | Type | Constraint | Expectation | Description |');
        expect(markdown).toContain('The city to look up');
    });

    it('leaves an un-described method/param table exactly four columns (additive-only)', () => {
        @Contract()
        class Plain {
            act(@NotEmpty() x: string): string {
                return x;
            }
        }
        const markdown = renderMarkdown([documentClass(Plain)]);
        // No @Describe anywhere → the classic four-column table, unchanged.
        expect(markdown).toContain('| Parameter | Type | Constraint | Expectation |');
        expect(markdown).not.toContain('| Parameter | Type | Constraint | Expectation | Description |');
    });
});
