/**
 * Unit tests for the JSON Schema projection, against the registry's **read API** — the twin of
 * `docs.test.ts`, and populated the same way: by hand through the write API, not by decorators.
 *
 * Driving the registry directly is the cheapest way to reach the shapes that matter here — a merged
 * numeric range, a constraint whose descriptor deliberately under-claims, an inherited field, a
 * symbol key — and it pins exactly the read contract this projection depends on. What it cannot do is
 * notice a missing production writer (the BUG-14 lesson), which is `*.decorators.test.ts`'s job for
 * the pipeline as a whole; these tests pin the projection.
 *
 * The **under-claim ethic is asserted explicitly** throughout: where a constraint has no faithful
 * schema, the emitted fragment must be the *weaker* true statement, and a test evaluates the
 * descriptor's own `predicate` to show the schema never rejects a value enforcement accepts.
 */

import {
    markFieldInstalled,
    markInstalled,
    recordFieldConstraint,
    recordParameterConstraint,
    registerContractedClass,
    resetRegistry,
    setParameterMetadata,
} from '../Core/ContractRegistry';
import {ConstraintDescriptor, defineConstraint, JsonObject} from '../Core/Descriptor';
import {
    Between,
    GreaterThan,
    GreaterThanEqual,
    Integer,
    LessThan,
    LessThanEqual,
    MultipleOf,
} from '../Contracts/number';
import {Email, Matches, MaxLength, NotEmpty, StringMinLength, Url} from '../Contracts/string';
import {ClassSchema, generateSchema, schemaForClass, schemaForContracts, serializeSchema} from './schema';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

beforeEach(resetRegistry);

/**
 * A constraint whose definition supplies **no `schema()` hook**. Defined once at module scope — the
 * definition table is process-global and rejects a duplicate identity, and `resetRegistry` does not
 * clear it. This is the projection's first real consumer of "a descriptor that cannot be projected".
 */
const opaqueConstraint = defineConstraint({
    kind: 'generic',
    constraint: 'test.opaque',
    derive: () => (value: unknown) => value !== undefined,
    describe: () => 'a defined value',
});

/** The merged schema for a single instance field — the most common assertion target below. */
function fieldSchema(constructor: Function, name: string): JsonObject {
    return (schemaForClass(constructor).properties as JsonObject)[name] as JsonObject;
}

// ---------------------------------------------------------------------------
// The built-in fragments, surfaced through the projection
// ---------------------------------------------------------------------------

describe('surfacing each built-in descriptor schema()', () => {
    // One case per built-in that supplies a `schema()`. Each asserts the projection emits the
    // descriptor's *own* fragment unchanged — the seam is "read schema() off the descriptor", and
    // this pins that nothing is re-derived or re-tightened on the way through.
    const exact: Array<{name: string; descriptor: ConstraintDescriptor; fragment: JsonObject}> = [
        {name: 'GreaterThanEqual', descriptor: GreaterThanEqual(5), fragment: {type: 'number', minimum: 5}},
        {name: 'LessThanEqual', descriptor: LessThanEqual(100), fragment: {type: 'number', maximum: 100}},
        {name: 'GreaterThan', descriptor: GreaterThan(0), fragment: {type: 'number', exclusiveMinimum: 0}},
        {name: 'LessThan', descriptor: LessThan(10), fragment: {type: 'number', exclusiveMaximum: 10}},
        {name: 'Between', descriptor: Between(1, 10), fragment: {type: 'number', minimum: 1, maximum: 10}},
        {name: 'Integer', descriptor: Integer(), fragment: {type: 'integer'}},
        {name: 'MultipleOf', descriptor: MultipleOf(5), fragment: {type: 'number', multipleOf: 5}},
        {name: 'StringMinLength', descriptor: StringMinLength(10), fragment: {type: 'string', minLength: 10}},
        {name: 'MaxLength', descriptor: MaxLength(20), fragment: {type: 'string', maxLength: 20}},
        {name: 'NotEmpty', descriptor: NotEmpty(), fragment: {type: 'string', minLength: 1}},
        {
            name: 'Matches (no flags)',
            descriptor: Matches('^a+$'),
            fragment: {type: 'string', pattern: '^a+$'},
        },
    ];

    exact.forEach(testCase => {
        it(`emits ${testCase.name}`, () => {
            class Model {}
            recordFieldConstraint(Model.prototype, 'value', testCase.descriptor);

            expect(fieldSchema(Model, 'value')).toEqual(testCase.fragment);
        });
    });

    it('emits email as a pattern, not format: email (the descriptor under-claims deliberately)', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'contact', Email());

        const schema = fieldSchema(Model, 'contact');
        expect(schema.type).toBe('string');
        expect(typeof schema.pattern).toBe('string');
        expect(schema.format).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Merging several constraints on one position
// ---------------------------------------------------------------------------

describe('merging constraints on one position', () => {
    it('combines a numeric range into ONE object, not two', () => {
        class Basket {}
        recordFieldConstraint(Basket.prototype, 'capacity', GreaterThanEqual(1));
        recordFieldConstraint(Basket.prototype, 'capacity', LessThanEqual(100));

        const schema = fieldSchema(Basket, 'capacity');

        expect(schema).toEqual({type: 'number', minimum: 1, maximum: 100});
        // "one object, not two" — a single fragment carrying both bounds.
        expect(Object.keys(schema)).toEqual(['type', 'minimum', 'maximum']);
    });

    it('narrows type to integer when integer meets a numeric bound (integer ⊂ number)', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'step', Integer());
        recordFieldConstraint(Model.prototype, 'step', GreaterThanEqual(1));

        expect(fieldSchema(Model, 'step')).toEqual({type: 'integer', minimum: 1});
    });

    it('takes the tighter bound when two lower bounds overlap', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'n', GreaterThanEqual(1));
        recordFieldConstraint(Model.prototype, 'n', GreaterThanEqual(5));

        // ≥1 ∧ ≥5 is ≥5 — exactly the set enforcement checks, neither over- nor under-claimed.
        expect(fieldSchema(Model, 'n')).toEqual({type: 'number', minimum: 5});
    });

    it('keeps distinct inclusive and exclusive bounds side by side', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'n', GreaterThanEqual(5));
        recordFieldConstraint(Model.prototype, 'n', GreaterThan(3));

        // Different keywords, so both coexist; their conjunction (≥5 ∧ >3 = ≥5) is faithful.
        expect(fieldSchema(Model, 'n')).toEqual({type: 'number', minimum: 5, exclusiveMinimum: 3});
    });

    it('falls back to allOf when two patterns cannot combine — and the fallback is exact conjunction', () => {
        class Model {}
        const anchoredStart = Matches('^a');
        const anchoredEnd = Matches('b$');
        recordFieldConstraint(Model.prototype, 'code', anchoredStart);
        recordFieldConstraint(Model.prototype, 'code', anchoredEnd);

        const schema = fieldSchema(Model, 'code');

        expect(schema).toEqual({
            allOf: [
                {type: 'string', pattern: '^a'},
                {type: 'string', pattern: 'b$'},
            ],
        });
        // allOf IS conjunction: a value must satisfy both, exactly as enforcement runs both predicates.
        expect(anchoredStart.predicate('ab')).toBe(true);
        expect(anchoredEnd.predicate('ab')).toBe(true);
    });

    it('falls back to allOf when two multipleOf values cannot combine', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'n', MultipleOf(2));
        recordFieldConstraint(Model.prototype, 'n', MultipleOf(3));

        expect(fieldSchema(Model, 'n')).toEqual({
            allOf: [
                {type: 'number', multipleOf: 2},
                {type: 'number', multipleOf: 3},
            ],
        });
    });
});

// ---------------------------------------------------------------------------
// Honest degradation (under-claim, never over-claim)
// ---------------------------------------------------------------------------

describe('honest degradation', () => {
    it('degrades a flagged Matches to {type:string} and does NOT reject what enforcement accepts', () => {
        class Model {}
        const caseInsensitive = Matches('^foo$', 'i');
        recordFieldConstraint(Model.prototype, 'name', caseInsensitive);

        const schema = fieldSchema(Model, 'name');

        // No `pattern`: a case-sensitive one would reject 'FOO', which enforcement accepts.
        expect(schema).toEqual({type: 'string'});
        expect(schema.pattern).toBeUndefined();
        // The proof the degradation is honest: enforcement accepts 'FOO'; the schema has nothing
        // that would reject it. Under-claim — the schema accepts at least what enforcement does.
        expect(caseInsensitive.predicate('FOO')).toBe(true);
    });

    it('degrades url to format:uri, which accepts more than enforcement (never less)', () => {
        class Model {}
        const httpOnly = Url();
        recordFieldConstraint(Model.prototype, 'homepage', httpOnly);

        const schema = fieldSchema(Model, 'homepage');

        expect(schema).toEqual({type: 'string', format: 'uri'});
        // Enforcement rejects a non-http(s) protocol; `format: 'uri'` is an annotation that does not,
        // so the schema accepts a superset. That is the safe direction — enforcement stays stricter.
        expect(httpOnly.predicate('ftp://host/file')).toBe(false);
    });

    it('degrades a constraint with no schema() hook to {} (accept anything)', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'anything', opaqueConstraint({}));

        // A constraint we cannot express weakens the position to accept-anything rather than
        // asserting a bound we cannot back.
        expect(fieldSchema(Model, 'anything')).toEqual({});
    });

    it('mixes an expressible and an opaque constraint, keeping only what it can back', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'n', GreaterThanEqual(1));
        recordFieldConstraint(Model.prototype, 'n', opaqueConstraint({}));

        // The opaque constraint contributes no fragment, so the merge is just the expressible one.
        expect(fieldSchema(Model, 'n')).toEqual({type: 'number', minimum: 1});
    });

    it('never emits required or additionalProperties on the class object schema', () => {
        class Basket {}
        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));

        const schema: ClassSchema = schemaForClass(Basket);

        // A field constraint bounds a value when assigned; it does not assert presence or exclusivity.
        // Emitting either would reject an object enforcement accepts.
        expect(schema.required).toBeUndefined();
        expect(schema.additionalProperties).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// A method with several parameters
// ---------------------------------------------------------------------------

describe('a multi-parameter method', () => {
    class Task {
        send(_message: string, _count: number, _retries: number) {
            /* no-op */
        }
    }

    beforeEach(() => {
        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(3));
        recordParameterConstraint(Task.prototype, 'send', 1, GreaterThanEqual(1));
        recordParameterConstraint(Task.prototype, 'send', 1, LessThanEqual(100));
        recordParameterConstraint(Task.prototype, 'send', 2, GreaterThan(0));
    });

    it('projects the method to a positional argument tuple, one merged schema per position', () => {
        const send = (schemaForClass(Task).methods as JsonObject).send as JsonObject;

        expect(send.type).toBe('array');
        expect(send.title).toBe('Task.send');
        expect(send.prefixItems).toEqual([
            {type: 'string', minLength: 3},
            {type: 'number', minimum: 1, maximum: 100},
            {type: 'number', exclusiveMinimum: 0},
        ]);
    });

    it('fills an undecorated leading position with {} rather than dropping it', () => {
        class Order {
            place(_ignored: string, _quantity: number) {
                /* no-op */
            }
        }
        recordParameterConstraint(Order.prototype, 'place', 1, GreaterThan(0));

        const place = (schemaForClass(Order).methods as JsonObject).place as JsonObject;

        expect(place.prefixItems).toEqual([{}, {type: 'number', exclusiveMinimum: 0}]);
    });

    it('emits no minItems/maxItems, so a trailing-optional or variadic call is not rejected', () => {
        const send = (schemaForClass(Task).methods as JsonObject).send as JsonObject;

        expect(send.minItems).toBeUndefined();
        expect(send.maxItems).toBeUndefined();
        expect(send.items).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Fields, and the static band
// ---------------------------------------------------------------------------

describe('contracted fields', () => {
    it('projects an instance field into the root properties', () => {
        class Basket {}
        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));
        markFieldInstalled(Basket.prototype, 'itemCount');

        expect(fieldSchema(Basket, 'itemCount')).toEqual({type: 'number', exclusiveMinimum: 0});
    });

    it('projects a static field into staticProperties, not the instance properties', () => {
        // The other key band: a static field is recorded against the constructor. A projection
        // walking only the prototype would drop it silently (DEC-018).
        class Widget {}
        recordFieldConstraint(Widget, 'limit', GreaterThanEqual(1));
        recordFieldConstraint(Widget.prototype, 'count', GreaterThan(0));

        const schema = schemaForClass(Widget);

        expect((schema.properties as JsonObject).count).toEqual({type: 'number', exclusiveMinimum: 0});
        expect((schema.properties as JsonObject).limit).toBeUndefined();
        expect(schema.staticProperties).toEqual({
            type: 'object',
            properties: {limit: {type: 'number', minimum: 1}},
        });
    });

    it('renders a symbol field key', () => {
        const key = Symbol('hidden');
        class Basket {}
        recordFieldConstraint(Basket.prototype, key, GreaterThan(0));

        expect((schemaForClass(Basket).properties as JsonObject)['Symbol(hidden)']).toEqual({
            type: 'number',
            exclusiveMinimum: 0,
        });
    });
});

// ---------------------------------------------------------------------------
// Static methods
// ---------------------------------------------------------------------------

describe('static methods', () => {
    it('projects a static method into staticMethods', () => {
        class Task {
            static parse(_input: string) {
                /* no-op */
            }
        }
        recordParameterConstraint(Task, 'parse', 0, StringMinLength(3));

        const schema = schemaForClass(Task);

        expect(schema.methods).toBeUndefined();
        expect((schema.staticMethods as JsonObject).parse).toEqual({
            title: 'Task.parse',
            type: 'array',
            prefixItems: [{type: 'string', minLength: 3}],
        });
    });
});

// ---------------------------------------------------------------------------
// Inheritance — the effective (union) reads (DEC-021, DEC-022)
// ---------------------------------------------------------------------------

describe('inheritance', () => {
    it('surfaces an inherited field constraint in the subclass schema', () => {
        class Base {}
        class Sub extends Base {}
        recordFieldConstraint(Base.prototype, 'count', GreaterThanEqual(0));

        // Sub declares nothing for `count`; enforcement still applies the inherited bound (DEC-021),
        // so the schema must report it — reporting only own declarations would put the artifact
        // behind what is enforced (DEC-016 / BUG-16).
        expect(fieldSchema(Sub, 'count')).toEqual({type: 'number', minimum: 0});
    });

    it('unions a subclass strengthening with its inherited field bound', () => {
        class Base {}
        class Sub extends Base {}
        recordFieldConstraint(Base.prototype, 'count', GreaterThanEqual(0));
        recordFieldConstraint(Sub.prototype, 'count', LessThanEqual(100));

        // Base's lower bound and Sub's upper bound merge into one object — the union DEC-021 resolves.
        expect(fieldSchema(Sub, 'count')).toEqual({type: 'number', minimum: 0, maximum: 100});
    });

    it('surfaces an inherited method parameter constraint in the subclass schema (DEC-022)', () => {
        class Base {
            greet(_name: string) {
                /* no-op */
            }
        }
        class Sub extends Base {}
        recordParameterConstraint(Base.prototype, 'greet', 0, StringMinLength(3));

        const greet = (schemaForClass(Sub).methods as JsonObject).greet as JsonObject;

        expect(greet.prefixItems).toEqual([{type: 'string', minLength: 3}]);
    });
});

// ---------------------------------------------------------------------------
// The empty case
// ---------------------------------------------------------------------------

describe('the empty case', () => {
    it('models a class with no contracts as a bare instance-object schema, not a failure', () => {
        class Plain {
            run() {
                /* no-op */
            }
        }

        expect(schemaForClass(Plain)).toEqual({
            $schema: DIALECT,
            title: 'Plain',
            type: 'object',
            properties: {},
        });
    });

    it('omits the method/static keywords entirely when there is nothing to put in them', () => {
        class Plain {}
        const schema = schemaForClass(Plain);

        expect(schema.methods).toBeUndefined();
        expect(schema.staticMethods).toBeUndefined();
        expect(schema.staticProperties).toBeUndefined();
    });

    it('returns an empty model from schemaForContracts when nothing is registered', () => {
        expect(schemaForContracts()).toEqual([]);
    });

    it('serialises an empty registry to an honest empty bundle', () => {
        const parsed = JSON.parse(serializeSchema([]));

        expect(parsed).toEqual({$schema: DIALECT, $defs: {}});
    });
});

// ---------------------------------------------------------------------------
// Draft 2020-12 well-formedness (structural hand-check, no validator dependency)
// ---------------------------------------------------------------------------

describe('draft 2020-12 well-formedness', () => {
    it('declares the 2020-12 dialect and an object root', () => {
        class Basket {}
        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));

        const schema = schemaForClass(Basket);

        expect(schema.$schema).toBe(DIALECT);
        expect(schema.type).toBe('object');
        expect(schema.title).toBe('Basket');
    });

    it('uses prefixItems (the 2020-12 tuple keyword), not a legacy array-form items', () => {
        class Task {
            send(_a: string) {
                /* no-op */
            }
        }
        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(3));

        const send = (schemaForClass(Task).methods as JsonObject).send as JsonObject;

        expect(Array.isArray(send.prefixItems)).toBe(true);
        // draft-04..07/2019 tuple validation used `items: [ ... ]`; 2020-12 renamed it to prefixItems,
        // and an array-valued `items` would be misread by a 2020-12 validator.
        expect(Array.isArray(send.items)).toBe(false);
    });

    it('emits exclusiveMinimum as a number (2020-12), not a boolean (draft-04)', () => {
        class Model {}
        recordFieldConstraint(Model.prototype, 'n', GreaterThan(0));

        expect(typeof fieldSchema(Model, 'n').exclusiveMinimum).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('serialisation', () => {
    it('round-trips a class schema through JSON unchanged', () => {
        class Basket {}
        recordFieldConstraint(Basket.prototype, 'capacity', GreaterThanEqual(1));
        recordFieldConstraint(Basket.prototype, 'capacity', LessThanEqual(100));

        const schema = schemaForClass(Basket);

        expect(JSON.parse(serializeSchema(schema))).toEqual(schema);
    });

    it('indents with two spaces by default and honours an override', () => {
        class Plain {}

        expect(serializeSchema(schemaForClass(Plain)).split('\n')[1]).toBe('  "$schema": "' + DIALECT + '",');
        expect(serializeSchema(schemaForClass(Plain), {indent: 4}).split('\n')[1]).toBe(
            '    "$schema": "' + DIALECT + '",',
        );
    });

    it('bundles multiple classes under $defs by title, stripping each inner $schema', () => {
        class Task {}
        class Basket {}
        recordFieldConstraint(Task.prototype, 'retries', GreaterThan(0));
        recordFieldConstraint(Basket.prototype, 'capacity', GreaterThanEqual(1));
        registerContractedClass(Task);
        registerContractedClass(Basket);

        const bundle = JSON.parse(serializeSchema(schemaForContracts()));

        expect(bundle.$schema).toBe(DIALECT);
        expect(Object.keys(bundle.$defs).sort()).toEqual(['Basket', 'Task']);
        // The bundle's own $schema declares the dialect; embedded resources do not redeclare it.
        expect(bundle.$defs.Task.$schema).toBeUndefined();
        expect(bundle.$defs.Task.properties.retries).toEqual({type: 'number', exclusiveMinimum: 0});
    });

    it('generateSchema walks the registry in one call', () => {
        class Task {
            send(_message: string) {
                /* no-op */
            }
        }
        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(10));
        registerContractedClass(Task);

        const parsed = JSON.parse(generateSchema());

        expect(parsed.$defs.Task.methods.send.prefixItems).toEqual([{type: 'string', minLength: 10}]);
    });

    it('orders keywords canonically, so a regenerated schema does not churn', () => {
        class Model {}
        // Record max before min; the output order must not depend on declaration order.
        recordFieldConstraint(Model.prototype, 'n', LessThanEqual(100));
        recordFieldConstraint(Model.prototype, 'n', GreaterThanEqual(1));

        expect(Object.keys(fieldSchema(Model, 'n'))).toEqual(['type', 'minimum', 'maximum']);
    });
});

// ---------------------------------------------------------------------------
// Registry shapes the projection has to survive
// ---------------------------------------------------------------------------

describe('degraded and unusual registry entries', () => {
    it('is unaffected by installed-state — the schema projects the declaration', () => {
        // Unlike the docs renderer, which flags recorded-but-uninstalled loudly, the schema describes
        // what is contracted. An uninstalled contract projects identically to an installed one.
        class Uninstalled {}
        class Installed {}
        recordFieldConstraint(Uninstalled.prototype, 'n', GreaterThan(0));
        recordFieldConstraint(Installed.prototype, 'n', GreaterThan(0));
        markInstalled(Installed.prototype, 'n');

        expect(fieldSchema(Uninstalled, 'n')).toEqual(fieldSchema(Installed, 'n'));
    });

    it('handles a parameter recorded with metadata but no constraints', () => {
        class Task {
            run(_value: unknown) {
                /* no-op */
            }
        }
        setParameterMetadata(Task.prototype, 'run', 0, {name: 'value'});

        const run = (schemaForClass(Task).methods as JsonObject).run as JsonObject;

        // The position exists but is unconstrained — {} (accept anything), not a dropped slot.
        expect(run.prefixItems).toEqual([{}]);
    });

    it('names an anonymous class rather than emitting an empty title', () => {
        const Anonymous = (() => class {})();
        Object.defineProperty(Anonymous, 'name', {value: ''});

        expect(schemaForClass(Anonymous).title).toBe('(anonymous class)');
    });

    it('rejects a non-constructor', () => {
        expect(() => schemaForClass({} as unknown as Function)).toThrow(/constructor/);
    });
});

// ---------------------------------------------------------------------------
// Layering (DEC-012)
// ---------------------------------------------------------------------------

describe('layering (DEC-012)', () => {
    it('imports from Core/ and Contracts/ only — never from an adapter', () => {
        // The same mechanical guard docs.test.ts applies. A projection that binds to the legacy
        // adapter silently loses the standard-decorator authoring path.
        const source: string = require('fs').readFileSync(require.resolve('./schema.ts'), 'utf8');
        const imports = source.match(/^import[\s\S]*?from '([^']+)';/gm) || [];

        expect(imports.length).toBeGreaterThan(0);
        imports.forEach(statement => {
            const specifier = (statement.match(/from '([^']+)'/) as RegExpMatchArray)[1];
            expect(specifier).toMatch(/^\.\.\/(Core|Contracts)\//);
        });
    });

    it('never imports from ./docs — it shares the registry reads, not the docs model', () => {
        const source: string = require('fs').readFileSync(require.resolve('./schema.ts'), 'utf8');

        expect(source).not.toMatch(/from '\.\/docs'/);
    });
});
