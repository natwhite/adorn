/**
 * `toolSchemaForMethod` — the prescriptive LLM tool-call schema for one method (IDEA-20 / DEC-048).
 *
 * Driven by **real `@` decorator syntax** rather than hand-populated registry writes, because the
 * whole point of the projection is names + fragments arriving from a genuine declaration: the
 * parameter names come from `captureSignature` at `@Contract()` install time (BUG-14), and the
 * fragments from each descriptor's own `schema()` merged by the *same* `mergeFragments` the
 * descriptive `schemaForClass` uses (no fork, DEC-010).
 *
 * No `resetRegistry()` — classes are declared at module scope (installed once) or inside their test,
 * each a fresh constructor, so registry entries never collide. (Method enforcement bakes its checks at
 * install time, so a reset would not disarm it, but the projection *reads* the registry, so a reset
 * would erase what it reads — simplest to avoid it entirely.)
 */

import {Contract} from '../Adapters/legacy/ContractInstaller';
import {GreaterThanEqual, LessThanEqual, NotEmpty, OneOf} from '../ParameterDecorators/Constraints';
import {JsonObject} from '../Core/Descriptor';
import {schemaForClass, toolSchemaForMethod} from './schema';

// The realistic tool, authored exactly as a user would — one structured object the model sends,
// modelled as a method's named parameter list. `@OneOf` is the real reified enum (the spike simulated
// it with `@Matches`); `days` carries two bounds that merge into one fragment.
@Contract()
class WeatherTool {
    getWeather(
        @NotEmpty() location: string,
        @OneOf(['celsius', 'fahrenheit']) unit: string,
        @GreaterThanEqual(1) @LessThanEqual(7) days: number,
    ): string {
        return `weather for ${location} in ${unit} over ${days} day(s)`;
    }
}

// ---------------------------------------------------------------------------
// The emitted shape
// ---------------------------------------------------------------------------

describe('the tight tool-object shape (DEC-048)', () => {
    it('re-keys the params by name, merges each fragment, and tightens with required + additionalProperties', () => {
        expect(toolSchemaForMethod(WeatherTool, 'getWeather')).toEqual({
            title: 'WeatherTool.getWeather',
            type: 'object',
            properties: {
                location: {type: 'string', minLength: 1},
                unit: {enum: ['celsius', 'fahrenheit']}, // the reified @OneOf, as {enum}
                days: {type: 'number', minimum: 1, maximum: 7}, // the DEC-029 conjunction, inherited unchanged
            },
            required: ['location', 'unit', 'days'], // every param carries ≥1 constraint
            additionalProperties: false, // a method's parameter set is closed
        });
    });

    it('passes options.description through as the tool-level description', () => {
        const schema = toolSchemaForMethod(WeatherTool, 'getWeather', {
            description: 'Look up a weather forecast.',
        });

        expect(schema.description).toBe('Look up a weather forecast.');
        // Everything else is unchanged by the description.
        expect(schema.title).toBe('WeatherTool.getWeather');
        expect(schema.additionalProperties).toBe(false);
    });

    it('omits description entirely when none is supplied', () => {
        expect(toolSchemaForMethod(WeatherTool, 'getWeather').description).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// required = "carries ≥1 constraint"
// ---------------------------------------------------------------------------

describe('required is "carries ≥1 constraint", not TS optionality (DEC-048)', () => {
    it('includes an unconstrained-but-known param in properties but NOT in required', () => {
        // `limit` has no decorator; captureSignature still records its name (trustworthy signature), so
        // the registry knows the position. It appears as `{}` (accept-anything) and is not required.
        @Contract()
        class Search {
            find(@NotEmpty() query: string, limit: number) {
                return `${query}:${limit}`;
            }
        }

        const schema = toolSchemaForMethod(Search, 'find');

        expect(schema.properties).toEqual({
            query: {type: 'string', minLength: 1},
            limit: {},
        });
        expect(schema.required).toEqual(['query']);
    });
});

// ---------------------------------------------------------------------------
// The end-to-end no-drift claim — the feedback's core point, verified
// ---------------------------------------------------------------------------

describe('the tool schema and the installed enforcement cannot drift', () => {
    it('a value the schema rejects is exactly one the real @Contract method throws on', () => {
        const tool = new WeatherTool();
        const properties = toolSchemaForMethod(WeatherTool, 'getWeather').properties as Record<
            string,
            JsonObject
        >;

        // A call the schema admits succeeds against the real method.
        expect(tool.getWeather('NYC', 'celsius', 3)).toContain('NYC');

        // unit: the schema's enum excludes 'kelvin' — and the real method throws on it.
        expect((properties.unit.enum as string[]).includes('kelvin')).toBe(false);
        expect(() => tool.getWeather('NYC', 'kelvin', 3)).toThrow();

        // days: the schema's minimum is 1 — and days:0 throws.
        expect(properties.days.minimum).toBe(1);
        expect(() => tool.getWeather('NYC', 'celsius', 0)).toThrow();

        // location: the schema's minLength is 1 — and the empty string throws.
        expect(properties.location.minLength).toBe(1);
        expect(() => tool.getWeather('', 'celsius', 3)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// schemaForClass stays descriptive — the two postures coexist (DEC-029 untouched)
// ---------------------------------------------------------------------------

describe('schemaForClass is untouched — descriptive under-claim beside the prescriptive sibling', () => {
    it('still emits a positional tuple with no required/additionalProperties at the root', () => {
        const classSchema = schemaForClass(WeatherTool);
        const method = (classSchema.methods as Record<string, JsonObject>).getWeather;

        // The descriptive method view is still a positional argument tuple, not an object.
        expect(method.type).toBe('array');
        expect(Array.isArray(method.prefixItems)).toBe(true);
        // The root instance schema under-claims: no required, no additionalProperties.
        expect(classSchema.required).toBeUndefined();
        expect(classSchema.additionalProperties).toBeUndefined();
        // @OneOf flows into the descriptive tuple as {enum} too — one descriptor, both projections.
        expect((method.prefixItems as JsonObject[])[1]).toEqual({enum: ['celsius', 'fahrenheit']});
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
    it('a method with no contracted params yields an empty tool schema, not an error', () => {
        @Contract()
        class Ping {
            ping() {
                return 'pong';
            }
        }

        expect(toolSchemaForMethod(Ping, 'ping')).toEqual({
            title: 'Ping.ping',
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
        });
    });

    it('throws for a method that does not exist on the class', () => {
        class Whatever {
            real() {
                /* no-op */
            }
        }

        expect(() => toolSchemaForMethod(Whatever, 'imaginary')).toThrow(/no method 'imaginary'/);
    });

    it('rejects a non-constructor', () => {
        expect(() => toolSchemaForMethod({} as unknown as Function, 'x')).toThrow(/constructor/);
    });

    it('projects an inherited contracted method for the subclass (DEC-022 union, free)', () => {
        @Contract()
        class Base {
            act(@NotEmpty() name: string) {
                return name;
            }
        }
        class Sub extends Base {}

        const schema = toolSchemaForMethod(Sub, 'act');

        expect(schema.title).toBe('Sub.act');
        expect(schema.properties).toEqual({name: {type: 'string', minLength: 1}});
        expect(schema.required).toEqual(['name']);
    });

    it('projects a static contracted method (the other key band)', () => {
        @Contract()
        class Parser {
            static parse(@NotEmpty() input: string) {
                return input;
            }
        }

        const schema = toolSchemaForMethod(Parser, 'parse');

        expect(schema.title).toBe('Parser.parse');
        expect(schema.properties).toEqual({input: {type: 'string', minLength: 1}});
        expect(schema.required).toEqual(['input']);
    });
});
