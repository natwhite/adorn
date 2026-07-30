/**
 * The capstone end-to-end Wave-1 test (plan §6.3).
 *
 * ONE tool method exercises all of Wave 1 at once — an `@ArrayOf` param, an `@Optional` param, a
 * `@Describe`d param, a string-format (`@Uuid`) param, and a `@Tool` method description — and pins BOTH
 * halves of the no-drift claim:
 *
 *   1. `toolSchemaForMethod` emits the EXACT expected schema (properties / required /
 *      additionalProperties / description / format / items).
 *   2. The installed `@Contract()` method's ENFORCEMENT agrees: every value the schema marks invalid is
 *      one the real method throws on, and the one value the schema marks omittable (`days`) is one
 *      enforcement accepts absent.
 *
 * This is the executable proof that the four mechanisms compose and that the projection and the runtime
 * cannot disagree (DEC-006).
 */

import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {ArrayOf, GreaterThanEqual, NotEmpty, Uuid} from '../src/ParameterDecorators/Constraints';
import {Optional} from '../src/Markers/Optional';
import {Describe} from '../src/Markers/Describe';
import {Tool} from '../src/Markers/Tool';
import {toolSchemaForMethod} from '../src/Projections/schema';
import * as StringContracts from '../src/Contracts/string';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

@Contract()
class Weather {
    @Tool('Look up a forecast')
    lookup(
        @ArrayOf(StringContracts.NotEmpty(), {minItems: 1}) tags: string[],
        @Optional() @GreaterThanEqual(1) days: number,
        @Describe('The city to look up') @NotEmpty() city: string,
        @Uuid() requestId: string,
    ): string {
        return `${tags.join(',')}#${days}@${city}:${requestId}`;
    }
}

describe('Wave-1 capstone: the exact emitted tool schema', () => {
    it('composes @ArrayOf + @Optional + @Describe + @Uuid + @Tool into one exact schema', () => {
        expect(toolSchemaForMethod(Weather, 'lookup')).toEqual({
            title: 'Weather.lookup',
            description: 'Look up a forecast', // ← @Tool
            type: 'object',
            properties: {
                // @Describe overrides the property description; the constraint fragment is intact.
                city: {description: 'The city to look up', type: 'string', minLength: 1},
                // @Optional → present in properties, dropped from required below.
                days: {type: 'number', minimum: 1},
                // @Uuid → the validating format.
                requestId: {type: 'string', format: 'uuid'},
                // @ArrayOf → the container fragment inheriting the item's own schema.
                tags: {type: 'array', items: {type: 'string', minLength: 1}, minItems: 1},
            },
            // Param-index order; `days` (index 1) omitted because it is @Optional.
            required: ['tags', 'city', 'requestId'],
            additionalProperties: false,
        });
    });
});

describe('Wave-1 capstone: enforcement agrees with the schema (no drift)', () => {
    const weather = new Weather();

    it('accepts the schema-valid call, with the @Optional `days` absent', () => {
        // `days` omitted (undefined) — the one position the schema marks omittable — passes.
        expect(() => weather.lookup(['x'], undefined as unknown as number, 'NYC', VALID_UUID)).not.toThrow();
    });

    it('throws on exactly the values the schema rejects', () => {
        // tags: violates minItems:1
        expect(() => weather.lookup([], 5, 'NYC', VALID_UUID)).toThrow();
        // days: present but violates minimum:1 (@Optional does not weaken a PRESENT value)
        expect(() => weather.lookup(['x'], 0, 'NYC', VALID_UUID)).toThrow();
        // city: empty violates minLength:1
        expect(() => weather.lookup(['x'], 2, '', VALID_UUID)).toThrow();
        // requestId: not a UUID
        expect(() => weather.lookup(['x'], 2, 'NYC', 'not-a-uuid')).toThrow();
    });

    it('a fully valid present call succeeds', () => {
        expect(weather.lookup(['a', 'b'], 3, 'NYC', VALID_UUID)).toContain('NYC');
    });
});
