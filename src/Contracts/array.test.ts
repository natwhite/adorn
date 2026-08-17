/**
 * Unit tests for the reified array descriptor (`@ArrayOf`, DEC-050 / IDEA-22 / GAP-15) — the first
 * *compositional* constraint — and its flow into enforcement and the projections.
 *
 * No `resetRegistry()` here, for the reason `enum.test.ts` gives: every class is declared *inside* its
 * test and is a fresh constructor, so registry entries never collide and nothing needs resetting.
 */

import {constraintFromJSON, defineConstraint} from '../Core/Descriptor';
import {recordFieldConstraint} from '../Core/ContractRegistry';
import * as Arrays from './array';
import * as Numbers from './number';
import * as Strings from './string';
import * as Enums from './enum';
import {schemaForClass, toolSchemaForMethod} from '../Projections/schema';
import {documentClass, renderMarkdown} from '../Projections/docs';
import {Contract} from '../Adapters/legacy/ContractInstaller';
import {ArrayOf} from '../ParameterDecorators/Constraints';
import {CreateFieldDecorator} from '../Adapters/legacy/FieldDecoratorFactory';
import {Verify} from '../Validation/Verify';

/** Everything a total predicate must survive without throwing. */
const HOSTILE: unknown[] = [null, undefined, NaN, '', 'abc', {}, 0, () => 0, true, false, Symbol('s')];

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

describe('the arrayOf descriptor', () => {
    it('is a generic-kind constraint carrying the item as serialised data + optional bounds', () => {
        const descriptor = Arrays.ArrayOf(Numbers.GreaterThanEqual(0), {minItems: 1});

        expect(descriptor.kind).toBe('generic');
        expect(descriptor.constraint).toBe('arrayOf');
        expect(descriptor.params).toEqual({
            item: {kind: 'number', constraint: 'min', params: {min: 0}},
            minItems: 1,
        });
    });

    it('accepts a valid array and rejects one with a bad element', () => {
        const descriptor = Arrays.ArrayOf(Numbers.GreaterThanEqual(0));

        expect(descriptor.predicate([1, 2, 3])).toBe(true);
        expect(descriptor.predicate([0])).toBe(true);
        expect(descriptor.predicate([-1])).toBe(false);
        expect(descriptor.predicate([1, -1, 2])).toBe(false);
    });

    it('is total (BUG-4): null/undefined/non-array are rejected, never thrown', () => {
        const descriptor = Arrays.ArrayOf(Numbers.GreaterThanEqual(0));

        HOSTILE.forEach(value => {
            expect(() => descriptor.predicate(value)).not.toThrow();
            expect(typeof descriptor.predicate(value)).toBe('boolean');
        });
        expect(descriptor.predicate(null)).toBe(false);
        expect(descriptor.predicate(undefined)).toBe(false);
        expect(descriptor.predicate('12')).toBe(false); // a string is not an array
        expect(descriptor.predicate({length: 1})).toBe(false); // array-like is not an array
    });

    it('an empty array passes with no minItems, and fails minItems:1', () => {
        expect(Arrays.ArrayOf(Numbers.Integer()).predicate([])).toBe(true);
        expect(Arrays.ArrayOf(Numbers.Integer(), {minItems: 1}).predicate([])).toBe(false);
        // minItems:0 is allowed and equivalent to omitting it.
        expect(Arrays.ArrayOf(Numbers.Integer(), {minItems: 0}).predicate([])).toBe(true);
    });

    it('enforces the length bounds', () => {
        const descriptor = Arrays.ArrayOf(Numbers.Integer(), {minItems: 2, maxItems: 3});

        expect(descriptor.predicate([1])).toBe(false); // too short
        expect(descriptor.predicate([1, 2])).toBe(true);
        expect(descriptor.predicate([1, 2, 3])).toBe(true);
        expect(descriptor.predicate([1, 2, 3, 4])).toBe(false); // too long
    });

    it('freezes params AND the embedded serialised item (DEC-010)', () => {
        const descriptor = Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1});

        expect(Object.isFrozen(descriptor.params)).toBe(true);
        expect(Object.isFrozen(descriptor.params.item)).toBe(true);
        expect(Object.isFrozen(descriptor.params.item.params)).toBe(true);
    });

    it('describes readably, inheriting the item prose and naming the bounds', () => {
        expect(Arrays.ArrayOf(Numbers.GreaterThanEqual(0)).describe()).toBe(
            'an array of a number greater than or equal to 0',
        );
        expect(Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1}).describe()).toBe(
            'an array of a non-empty string (at least 1 item)',
        );
        expect(Arrays.ArrayOf(Numbers.Integer(), {maxItems: 5}).describe()).toBe(
            'an array of an integer (at most 5 items)',
        );
        expect(Arrays.ArrayOf(Numbers.Integer(), {minItems: 1, maxItems: 5}).describe()).toBe(
            'an array of an integer (1..5 items)',
        );
    });
});

// ---------------------------------------------------------------------------
// schema() inheritance and the under-claim floor
// ---------------------------------------------------------------------------

describe('the arrayOf schema inherits the item fragment (never re-tightening it)', () => {
    it('emits {type:array, items:<item schema>, minItems?} for a hooked item', () => {
        expect(Arrays.ArrayOf(Numbers.GreaterThanEqual(0), {minItems: 1}).schema!()).toEqual({
            type: 'array',
            items: {type: 'number', minimum: 0},
            minItems: 1,
        });
    });

    it('emits both bounds when both are supplied', () => {
        expect(Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1, maxItems: 4}).schema!()).toEqual({
            type: 'array',
            items: {type: 'string', minLength: 1},
            minItems: 1,
            maxItems: 4,
        });
    });

    it('degrades items to {} when the item supplies no schema() hook (the honest floor)', () => {
        const hookless = defineConstraint({
            kind: 'generic',
            constraint: 'array-test-hookless-item',
            derive: () => (v: unknown) => typeof v === 'number',
            describe: () => 'a hookless thing',
        });

        expect(Arrays.ArrayOf(hookless({})).schema!()).toEqual({type: 'array', items: {}});
    });

    it('inherits an item under-claim: an array of a flagged matches degrades to items:{type:string}', () => {
        // `matches` with the `i` flag has no faithful JSON Schema `pattern`, so it degrades to
        // {type:'string'} — and the array fragment inherits exactly that, never re-adding a pattern.
        expect(Arrays.ArrayOf(Strings.Matches(/^a+$/i)).schema!()).toEqual({
            type: 'array',
            items: {type: 'string'},
        });
    });
});

// ---------------------------------------------------------------------------
// Authoring validation
// ---------------------------------------------------------------------------

describe('arrayOf authoring validation', () => {
    it('rejects a non-descriptor item (including a hand-written closure — no toJSON)', () => {
        expect(() => Arrays.ArrayOf(null as never)).toThrow(/ConstraintDescriptor/);
        expect(() => Arrays.ArrayOf((() => undefined) as never)).toThrow(/ConstraintDescriptor/);
        expect(() => Arrays.ArrayOf({} as never)).toThrow(/ConstraintDescriptor/);
    });

    it('rejects a negative or non-integer bound', () => {
        expect(() => Arrays.ArrayOf(Numbers.Integer(), {minItems: -1})).toThrow(/non-negative integer/);
        expect(() => Arrays.ArrayOf(Numbers.Integer(), {maxItems: 1.5})).toThrow(/non-negative integer/);
        expect(() => Arrays.ArrayOf(Numbers.Integer(), {minItems: Infinity})).toThrow(/non-negative integer/);
    });

    it('rejects minItems greater than maxItems — nothing could satisfy it', () => {
        expect(() => Arrays.ArrayOf(Numbers.Integer(), {minItems: 3, maxItems: 2})).toThrow(
            /must not exceed/,
        );
    });
});

// ---------------------------------------------------------------------------
// Round-trip (DEC-010), including nested + regex/enum items
// ---------------------------------------------------------------------------

describe('arrayOf round-trips through JSON (DEC-050)', () => {
    it('serialises to identity + params (the item carried as its own serialised form)', () => {
        expect(JSON.parse(JSON.stringify(Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1})))).toEqual({
            kind: 'generic',
            constraint: 'arrayOf',
            params: {
                item: {kind: 'string', constraint: 'notEmpty', params: {minLength: 1}},
                minItems: 1,
            },
        });
    });

    it('rehydrates into an identically-enforcing, identically-schema descriptor', () => {
        const descriptor = Arrays.ArrayOf(Numbers.GreaterThanEqual(0), {minItems: 1});
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

        expect(revived.describe()).toBe(descriptor.describe());
        expect(revived.schema!()).toEqual(descriptor.schema!());
        [[1, 2, 3], [0], [-1], [], 'x', null, undefined].forEach(value => {
            expect(revived.predicate(value)).toBe(descriptor.predicate(value));
        });
    });

    it('round-trips an @ArrayOf of a matches item (RegExp through {source,flags})', () => {
        const descriptor = Arrays.ArrayOf(Strings.Matches(/^a+$/), {minItems: 1});
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

        expect(revived.schema!()).toEqual({
            type: 'array',
            items: {type: 'string', pattern: '^a+$'},
            minItems: 1,
        });
        expect(revived.predicate(['aaa'])).toBe(true);
        expect(revived.predicate(['b'])).toBe(false);
        expect(revived.predicate([])).toBe(false); // minItems:1
    });

    it('round-trips an @ArrayOf of a oneOf item', () => {
        const descriptor = Arrays.ArrayOf(Enums.OneOf(['a', 'b']));
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

        expect(revived.schema!()).toEqual({type: 'array', items: {type: 'string', enum: ['a', 'b']}});
        expect(revived.predicate(['a', 'b', 'a'])).toBe(true);
        expect(revived.predicate(['a', 'z'])).toBe(false);
    });

    it('nests: @ArrayOf(@ArrayOf(@OneOf)) round-trips its predicate AND schema', () => {
        const descriptor = Arrays.ArrayOf(Arrays.ArrayOf(Enums.OneOf(['a', 'b'])));

        expect(descriptor.predicate([['a'], ['b', 'a']])).toBe(true);
        expect(descriptor.predicate([['a'], ['z']])).toBe(false);
        expect(descriptor.predicate(['a'])).toBe(false); // inner must be an array
        expect(descriptor.schema!()).toEqual({
            type: 'array',
            items: {type: 'array', items: {type: 'string', enum: ['a', 'b']}},
        });

        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));
        expect(revived.schema!()).toEqual(descriptor.schema!());
        expect(revived.predicate([['a'], ['b', 'a']])).toBe(true);
        expect(revived.predicate([['a'], ['z']])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The projections surface the array
// ---------------------------------------------------------------------------

describe('the projections surface the array', () => {
    it('the schema projection emits the array fragment for a field, canonically ordered', () => {
        class Cart {}
        recordFieldConstraint(Cart.prototype, 'tags', Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1}));

        const properties = schemaForClass(Cart).properties as Record<string, unknown>;
        expect(properties.tags).toEqual({
            type: 'array',
            items: {type: 'string', minLength: 1},
            minItems: 1,
        });
        // Canonical key order: type, items, minItems (KEY_ORDER places the bounds right after items).
        expect(Object.keys(properties.tags as object)).toEqual(['type', 'items', 'minItems']);
    });

    it('the docs projection renders the array prose', () => {
        class Cart {}
        recordFieldConstraint(Cart.prototype, 'tags', Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 1}));

        const doc = documentClass(Cart);
        const constraint = doc.fields[0].constraints[0];

        expect(constraint.constraint).toBe('arrayOf');
        expect(constraint.expectation).toBe('an array of a non-empty string (at least 1 item)');
        expect(renderMarkdown([doc])).toContain('an array of a non-empty string');
    });

    it('toolSchemaForMethod emits the array schema in properties and the param in required', () => {
        @Contract()
        class TagTool {
            label(@ArrayOf(Strings.NotEmpty(), {minItems: 1}) tags: string[]) {
                return tags.join(',');
            }
        }

        const schema = toolSchemaForMethod(TagTool, 'label');
        expect(schema.properties).toEqual({
            tags: {type: 'array', items: {type: 'string', minLength: 1}, minItems: 1},
        });
        expect(schema.required).toEqual(['tags']);
    });
});

// ---------------------------------------------------------------------------
// End-to-end enforcement, on every layer a descriptor reaches
// ---------------------------------------------------------------------------

describe('@ArrayOf enforces end-to-end', () => {
    it('as a parameter constraint, rejects a bad array with a proper contract violation', () => {
        @Contract()
        class Basket {
            add(@ArrayOf(Strings.NotEmpty(), {minItems: 1}) tags: string[]) {
                return tags;
            }
        }

        const basket = new Basket();
        expect(basket.add(['x', 'y'])).toEqual(['x', 'y']);

        expect(() => basket.add([])).toThrow(); // fails minItems:1
        expect(() => basket.add(['ok', ''])).toThrow(); // a bad element
        expect(() => basket.add('nope' as unknown as string[])).toThrow(); // not an array

        let message = '';
        try {
            basket.add([]);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("parameter 'tags'");
        expect(message).toContain('expected an array of a non-empty string (at least 1 item)');
    });

    it('as a field constraint via CreateFieldDecorator — no new field decorator needed', () => {
        class Config {
            @CreateFieldDecorator(Arrays.ArrayOf(Numbers.GreaterThanEqual(0)))
            scores: number[] = [1, 2, 3];
        }

        const config = new Config();
        expect(config.scores).toEqual([1, 2, 3]); // initializer validated and read back

        config.scores = [10];
        expect(config.scores).toEqual([10]);

        expect(() => {
            config.scores = [-1];
        }).toThrow();
    });

    it('as an imperative assertion via Verify.that', () => {
        const descriptor = Arrays.ArrayOf(Enums.OneOf(['a', 'b']));
        expect(Verify.that(descriptor, 'choices', ['a', 'b'])).toEqual(['a', 'b']);
        expect(() => Verify.that(descriptor, 'choices', ['a', 'z'])).toThrow(/an array of/);
    });
});
