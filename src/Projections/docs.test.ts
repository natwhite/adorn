/**
 * Unit tests for the documentation projection, against the registry's **read API**.
 *
 * **The registry is populated by hand here, not by decorators** — deliberately, and no longer alone.
 * Driving the write API directly is the cheapest way to reach shapes a real decorator cannot easily
 * produce (a symbol key, a constraint-free parameter, an anonymous class, a pipe in author prose), and
 * it pins exactly the read contract the projection depends on.
 *
 * What it **cannot** do is notice that no production caller ever writes what it reads. That is how
 * BUG-14 stayed green here while enforcement said `parameter 'sku'` and this projection said `arg0`:
 * these tests supplied the name themselves, so the missing writer was invisible. `docs.decorators.test.ts`
 * is the answer to that — it decorates classes with real `@` syntax and asserts through the rendered
 * document, comparing enforcement and documentation *to each other*. Neither file replaces the other.
 *
 * Note also that this file runs **without `reflect-metadata`**, so `design:type` is genuinely
 * unavailable — which is what lets it assert honest degradation (an absent type renders as absent)
 * rather than merely asserting nothing read it.
 */

import {
    markFieldInstalled,
    markInstalled,
    recordFieldConstraint,
    recordParameterConstraint,
    registerContractedClass,
    resetRegistry,
    setFieldMetadata,
    setParameterMetadata,
} from '../Core/ContractRegistry';
import {GreaterThan, GreaterThanEqual, LessThanEqual} from '../Contracts/number';
import {Matches, StringMinLength} from '../Contracts/string';
import {ClassDoc, documentClass, documentContracts, generateMarkdown, renderMarkdown} from './docs';

beforeEach(resetRegistry);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Finds the `MethodDoc` for `name`, failing the test rather than returning `undefined`. */
function methodNamed(classDoc: ClassDoc, name: string) {
    const method = classDoc.methods.filter(entry => entry.name === name)[0];
    expect(method).toBeDefined();
    return method;
}

// ---------------------------------------------------------------------------
// The four ported built-ins
// ---------------------------------------------------------------------------

describe('rendering the ported built-in constraints', () => {
    /**
     * One case per built-in descriptor in `src/Contracts/`. Each asserts the projection surfaces
     * the constraint *identity* and the descriptor's own `describe()` output — the two things
     * DEC-006 says documentation is derived from — rather than any prose this module invents.
     */
    const cases = [
        {
            name: 'min (GreaterThanEqual)',
            descriptor: GreaterThanEqual(5),
            identity: 'min',
            kind: 'number',
            params: {min: 5},
            expectation: 'a number greater than or equal to 5',
        },
        {
            name: 'max (LessThanEqual)',
            descriptor: LessThanEqual(100),
            identity: 'max',
            kind: 'number',
            params: {max: 100},
            expectation: 'a number less than or equal to 100',
        },
        {
            name: 'greaterThan (GreaterThan)',
            descriptor: GreaterThan(0),
            identity: 'greaterThan',
            kind: 'number',
            // An *exclusive* lower bound, so it projects to `exclusiveMinimum` in a
            // schema rather than to `minimum`.
            params: {exclusiveMin: 0},
            expectation: 'a number greater than 0',
        },
        {
            name: 'minLength (StringMinLength)',
            descriptor: StringMinLength(10),
            identity: 'minLength',
            kind: 'string',
            params: {minLength: 10},
            expectation: 'a string of length greater than 10',
        },
    ];

    cases.forEach(testCase => {
        it(`models ${testCase.name}`, () => {
            class Task {
                run(_value: unknown) {
                    /* no-op */
                }
            }

            recordParameterConstraint(Task.prototype, 'run', 0, testCase.descriptor);

            const constraint = methodNamed(documentClass(Task), 'run').parameters[0].constraints[0];

            expect(constraint.constraint).toBe(testCase.identity);
            expect(constraint.kind).toBe(testCase.kind);
            expect(constraint.params).toEqual(testCase.params);
            expect(constraint.expectation).toBe(testCase.expectation);
        });

        it(`renders ${testCase.name} into markdown`, () => {
            class Task {
                run(_value: unknown) {
                    /* no-op */
                }
            }

            recordParameterConstraint(Task.prototype, 'run', 0, testCase.descriptor);

            const markdown = renderMarkdown([documentClass(Task)]);

            expect(markdown).toContain(`\`${testCase.identity}\``);
            expect(markdown).toContain(testCase.expectation);
        });
    });

    /*
     * Removed with DEC-020: 'keeps `positive` distinct from `min` even though they share a
     * derivation'. It pinned that two identities carrying *identical* params still project
     * distinct prose, and `positive`/`greaterThan` were the only pair that could demonstrate
     * it. After the removal no two built-ins share params, so the test had no subject left —
     * rewritten mechanically it would have compared `greaterThan` to itself and asserted its
     * expectation differed from its own. The principle it guarded (identity is what a
     * projection prints, params are what it reads) is documented in `Contracts/number.ts`.
     */
});

// ---------------------------------------------------------------------------
// A method with several parameters
// ---------------------------------------------------------------------------

describe('a method with several parameters', () => {
    class Task {
        send(_message: string, _count: number, _retries: number) {
            /* no-op */
        }
    }

    beforeEach(() => {
        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(10));
        setParameterMetadata(Task.prototype, 'send', 0, {name: 'message', type: String});

        recordParameterConstraint(Task.prototype, 'send', 1, GreaterThanEqual(1));
        recordParameterConstraint(Task.prototype, 'send', 1, LessThanEqual(100));
        setParameterMetadata(Task.prototype, 'send', 1, {name: 'count', type: Number});

        recordParameterConstraint(Task.prototype, 'send', 2, GreaterThan(0));
        setParameterMetadata(Task.prototype, 'send', 2, {name: 'retries', type: Number});
    });

    it('orders parameters by index and keeps several constraints on one position', () => {
        const method = methodNamed(documentClass(Task), 'send');

        expect(method.parameters.map(parameter => parameter.index)).toEqual([0, 1, 2]);
        expect(method.parameters.map(parameter => parameter.name)).toEqual(['message', 'count', 'retries']);
        expect(method.parameters[1].constraints.map(constraint => constraint.constraint)).toEqual([
            'min',
            'max',
        ]);
    });

    it('builds a signature from the recovered names', () => {
        expect(methodNamed(documentClass(Task), 'send').signature).toBe('Task.send(message, count, retries)');
    });

    it('surfaces the reflected type name, flagged as advisory by being name-only', () => {
        const parameters = methodNamed(documentClass(Task), 'send').parameters;

        expect(parameters[0].typeName).toBe('String');
        expect(parameters[1].typeName).toBe('Number');
    });

    it('emits one table row per constraint, not per parameter', () => {
        const markdown = renderMarkdown([documentClass(Task)]);
        const rows = markdown.split('\n').filter(line => /^\| `/.test(line));

        expect(rows).toHaveLength(4);
        expect(rows[1]).toContain('`count` (1)');
        expect(rows[2]).toContain('`count` (1)');
        expect(rows[1]).toContain('a number greater than or equal to 1');
        expect(rows[2]).toContain('a number less than or equal to 100');
    });

    it('renders the whole class as a stable markdown document', () => {
        markInstalled(Task.prototype, 'send');

        expect(renderMarkdown([documentClass(Task)])).toBe(
            [
                '# Contracts',
                '',
                '## Task',
                '',
                '### Task.send(message, count, retries)',
                '',
                '| Parameter | Type | Constraint | Expectation |',
                '| --- | --- | --- | --- |',
                '| `message` (0) | `String` | `minLength` | a string of length greater than 10 |',
                '| `count` (1) | `Number` | `min` | a number greater than or equal to 1 |',
                '| `count` (1) | `Number` | `max` | a number less than or equal to 100 |',
                '| `retries` (2) | `Number` | `greaterThan` | a number greater than 0 |',
                '',
            ].join('\n'),
        );
    });
});

// ---------------------------------------------------------------------------
// The field band (GAP-9)
// ---------------------------------------------------------------------------

describe('contracted fields', () => {
    /** Table rows of the `### Fields` section — the field twin of the parameter-row filter above. */
    function fieldRows(markdown: string): string[] {
        const lines = markdown.split('\n');
        const start = lines.indexOf('### Fields');
        if (start < 0) return [];
        return lines.slice(start + 1).filter(line => /^\| `/.test(line));
    }

    it('models a field with its constraints, type, and installed flag', () => {
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));
        setFieldMetadata(Basket.prototype, 'itemCount', {type: Number});
        markFieldInstalled(Basket.prototype, 'itemCount');

        const [field] = documentClass(Basket).fields;

        expect(field.name).toBe('itemCount');
        expect(field.isStatic).toBe(false);
        expect(field.typeName).toBe('Number');
        expect(field.installed).toBe(true);
        expect(field.constraints.map(constraint => constraint.constraint)).toEqual(['greaterThan']);
        expect(field.constraints[0].expectation).toBe('a number greater than 0');
    });

    it('carries several constraints on one field, in recorded order', () => {
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'capacity', GreaterThanEqual(1));
        recordFieldConstraint(Basket.prototype, 'capacity', LessThanEqual(100));

        const [field] = documentClass(Basket).fields;

        expect(field.constraints.map(constraint => constraint.constraint)).toEqual(['min', 'max']);
    });

    it('emits one table row per constraint, not per field', () => {
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'capacity', GreaterThanEqual(1));
        recordFieldConstraint(Basket.prototype, 'capacity', LessThanEqual(100));
        markFieldInstalled(Basket.prototype, 'capacity');

        const rows = fieldRows(renderMarkdown([documentClass(Basket)]));

        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('a number greater than or equal to 1');
        expect(rows[1]).toContain('a number less than or equal to 100');
    });

    it('documents static fields, which are recorded against the constructor', () => {
        // The other key band. A projection walking only the prototype would drop this row entirely
        // and nothing would throw to reveal it — which is why the walk lives in the registry (DEC-018).
        class Widget {}

        recordFieldConstraint(Widget, 'limit', GreaterThanEqual(1));
        recordFieldConstraint(Widget.prototype, 'count', GreaterThan(0));
        markFieldInstalled(Widget, 'limit');
        markFieldInstalled(Widget.prototype, 'count');

        const classDoc = documentClass(Widget);

        expect(classDoc.fields.map(field => ({name: field.name, isStatic: field.isStatic}))).toEqual([
            {name: 'count', isStatic: false},
            {name: 'limit', isStatic: true},
        ]);
        expect(fieldRows(renderMarkdown([classDoc])).map(row => row.split('|')[1].trim())).toEqual([
            '`count`',
            '`limit` _(static)_',
        ]);
    });

    it('orders fields deterministically regardless of decoration order', () => {
        class Widget {}

        recordFieldConstraint(Widget.prototype, 'zebra', GreaterThan(0));
        recordFieldConstraint(Widget.prototype, 'alpha', GreaterThan(0));

        expect(documentClass(Widget).fields.map(field => field.name)).toEqual(['alpha', 'zebra']);
    });

    it('marks a field whose contracts are recorded but not installed, naming it', () => {
        // Same reasoning as the method warning: a document describing an unenforced guarantee is
        // worse than no document. Named individually because one table can hold both kinds.
        class Widget {}

        recordFieldConstraint(Widget.prototype, 'unarmed', GreaterThan(0));
        recordFieldConstraint(Widget.prototype, 'armed', GreaterThan(0));
        markFieldInstalled(Widget.prototype, 'armed');

        const markdown = renderMarkdown([documentClass(Widget)]);

        expect(markdown).toContain('**Not enforced.**');
        expect(markdown).toContain('`unarmed`');
        expect(markdown).toMatch(/\*\*Not enforced\.\*\*[^\n]*`unarmed`/);
        // The enforced field must not be swept into the warning alongside it.
        expect(markdown).not.toMatch(/\*\*Not enforced\.\*\*[^\n]*`armed`,/);
    });

    it('renders an absent type as absent rather than guessing one', () => {
        // `emitDecoratorMetadata` is unavailable under a transpile-only toolchain (DEC-004) and this
        // file runs without `reflect-metadata` at all, so there is genuinely no type to report. The
        // document must say so instead of inferring one from an assigned value.
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));
        markFieldInstalled(Basket.prototype, 'itemCount');

        const [field] = documentClass(Basket).fields;

        expect(field.typeName).toBeUndefined();
        expect(fieldRows(renderMarkdown([documentClass(Basket)]))[0]).toContain('| — |');
    });

    it('renders a symbol field key', () => {
        const key = Symbol('hidden');

        class Basket {}

        recordFieldConstraint(Basket.prototype, key, GreaterThan(0));
        markFieldInstalled(Basket.prototype, key);

        expect(documentClass(Basket).fields[0].name).toBe('Symbol(hidden)');
        expect(fieldRows(renderMarkdown([documentClass(Basket)]))[0]).toContain('`Symbol(hidden)`');
    });

    it('handles a field recorded with metadata but no constraints', () => {
        // Reachable via `setFieldMetadata` alone. An empty table with a header and no rows would be
        // a worse artifact than saying plainly that nothing is constrained.
        class Basket {}

        setFieldMetadata(Basket.prototype, 'itemCount', {type: Number});

        const markdown = renderMarkdown([documentClass(Basket)]);

        expect(markdown).toContain('### Fields');
        expect(markdown).toContain('_No field constraints recorded._');
        expect(markdown).not.toContain('| Field |');
    });

    it('renders both bands for a class carrying methods and fields', () => {
        class Task {
            send(_message: string) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(10));
        setParameterMetadata(Task.prototype, 'send', 0, {name: 'message', type: String});
        markInstalled(Task.prototype, 'send');

        recordFieldConstraint(Task.prototype, 'retries', GreaterThan(0));
        setFieldMetadata(Task.prototype, 'retries', {type: Number});
        markFieldInstalled(Task.prototype, 'retries');

        expect(renderMarkdown([documentClass(Task)])).toBe(
            [
                '# Contracts',
                '',
                '## Task',
                '',
                '### Task.send(message)',
                '',
                '| Parameter | Type | Constraint | Expectation |',
                '| --- | --- | --- | --- |',
                '| `message` (0) | `String` | `minLength` | a string of length greater than 10 |',
                '',
                '### Fields',
                '',
                '| Field | Type | Constraint | Expectation |',
                '| --- | --- | --- | --- |',
                '| `retries` | `Number` | `greaterThan` | a number greater than 0 |',
                '',
            ].join('\n'),
        );
    });

    it('escapes a pipe in a field expectation so it cannot split a row', () => {
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'code', Matches('^a|b$'));
        markFieldInstalled(Basket.prototype, 'code');

        const row = fieldRows(renderMarkdown([documentClass(Basket)]))[0];

        expect(row).toContain('\\|');
        // Four cells means five unescaped delimiters, so six parts once the leading and trailing
        // empties are counted — the same arithmetic the parameter-table case uses.
        expect(row.split(/(?<!\\)\|/)).toHaveLength(6);
    });
});

// ---------------------------------------------------------------------------
// The empty cases
// ---------------------------------------------------------------------------

describe('the empty case', () => {
    it('models a class with no contracts as empty method AND field lists, not a failure', () => {
        class Plain {
            run() {
                /* no-op */
            }
        }

        const classDoc = documentClass(Plain);

        expect(classDoc.name).toBe('Plain');
        expect(classDoc.methods).toEqual([]);
        expect(classDoc.fields).toEqual([]);
    });

    it('does NOT report a field-only class as having no contracts', () => {
        // The regression guard for this task. `_No contracts recorded._` keyed on `methods.length`
        // alone, so a class contracted purely through fields was enforced at runtime and reported as
        // having nothing — a document that looks complete and is not (DEC-011).
        class Basket {}

        recordFieldConstraint(Basket.prototype, 'itemCount', GreaterThan(0));
        markFieldInstalled(Basket.prototype, 'itemCount');

        const markdown = renderMarkdown([documentClass(Basket)]);

        expect(documentClass(Basket).methods).toEqual([]);
        expect(markdown).not.toContain('_No contracts recorded._');
        expect(markdown).toContain('`greaterThan`');
    });

    it('renders a class with no contracts without inventing any', () => {
        class Plain {
            run() {
                /* no-op */
            }
        }

        const markdown = renderMarkdown([documentClass(Plain)]);

        expect(markdown).toContain('## Plain');
        expect(markdown).toContain('_No contracts recorded._');
        expect(markdown).not.toContain('| Parameter |');
    });

    it('says why an empty registry might be empty, rather than rendering a bare heading', () => {
        // An empty document is the expected result of forgetting to import the modules being
        // documented (DEC-007), and that is indistinguishable from "there are no contracts".
        const markdown = renderMarkdown([]);

        expect(markdown).toContain('_No contracted classes are registered._');
        expect(markdown).toContain('imported and evaluated');
    });

    it('handles a parameter recorded with metadata but no constraints', () => {
        class Task {
            run(_value: unknown) {
                /* no-op */
            }
        }

        setParameterMetadata(Task.prototype, 'run', 0, {name: 'value', type: String});

        const markdown = renderMarkdown([documentClass(Task)]);

        expect(markdown).toContain('_No parameter constraints recorded._');
        expect(markdown).not.toContain('| Parameter |');
    });
});

// ---------------------------------------------------------------------------
// Enumeration — the whole-registry walk
// ---------------------------------------------------------------------------

describe('walking the registry (DEC-011)', () => {
    it('documents exactly the classes registered for enumeration', () => {
        class Documented {
            run(_value: number) {
                /* no-op */
            }
        }

        class Unregistered {
            run(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Documented.prototype, 'run', 0, GreaterThan(0));
        recordParameterConstraint(Unregistered.prototype, 'run', 0, GreaterThan(0));
        registerContractedClass(Documented);

        expect(documentContracts().map(classDoc => classDoc.name)).toEqual(['Documented']);
    });

    it('generateMarkdown walks the registry in one call', () => {
        class Task {
            send(_message: string) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(10));
        setParameterMetadata(Task.prototype, 'send', 0, {name: 'message'});
        registerContractedClass(Task);

        const markdown = generateMarkdown();

        expect(markdown).toContain('## Task');
        expect(markdown).toContain('### Task.send(message)');
        expect(markdown).toContain('a string of length greater than 10');
    });

    it('accepts a title override', () => {
        expect(generateMarkdown({title: 'API Contracts'})).toContain('# API Contracts');
    });

    it('returns an empty model when nothing is registered', () => {
        expect(documentContracts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Registry shapes the projection has to survive
// ---------------------------------------------------------------------------

describe('degraded and unusual registry entries', () => {
    it('falls back to positional names and flags that it did so', () => {
        // Parameter names are not always recoverable at runtime — minification renames them and
        // there is no other runtime source (plan §1.4). The fallback must be visible in the model,
        // not silently indistinguishable from a real name.
        class Task {
            run(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, GreaterThan(0));

        const parameter = methodNamed(documentClass(Task), 'run').parameters[0];

        expect(parameter.name).toBe('arg0');
        expect(parameter.nameRecovered).toBe(false);
        expect(parameter.typeName).toBeUndefined();
    });

    it('fills undecorated leading positions in the signature', () => {
        class Task {
            run(_ignored: string, _value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'run', 1, GreaterThan(0));
        setParameterMetadata(Task.prototype, 'run', 1, {name: 'value'});

        const method = methodNamed(documentClass(Task), 'run');

        // Position 0 has no registry entry, so it can only be named positionally — and it is
        // absent from the parameter table, which lists contracted positions only.
        expect(method.signature).toBe('Task.run(arg0, value)');
        expect(method.parameters.map(parameter => parameter.index)).toEqual([1]);
    });

    it('marks a method whose contracts are recorded but not installed', () => {
        // Until P1.3 lands nothing installs, so this is currently the norm. It must be loud: a
        // document describing an unenforced guarantee is worse than no document.
        class Task {
            run(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, GreaterThan(0));

        const classDoc = documentClass(Task);

        expect(methodNamed(classDoc, 'run').installed).toBe(false);
        expect(renderMarkdown([classDoc])).toContain('**Not enforced.**');

        markInstalled(Task.prototype, 'run');

        expect(renderMarkdown([documentClass(Task)])).not.toContain('**Not enforced.**');
    });

    it('documents static methods, which are recorded against the constructor', () => {
        class Task {
            static parse(_input: string) {
                /* no-op */
            }

            run(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task, 'parse', 0, StringMinLength(3));
        recordParameterConstraint(Task.prototype, 'run', 0, GreaterThan(0));

        const classDoc = documentClass(Task);

        expect(classDoc.methods.map(method => ({name: method.name, isStatic: method.isStatic}))).toEqual([
            {name: 'run', isStatic: false},
            {name: 'parse', isStatic: true},
        ]);
        expect(renderMarkdown([classDoc])).toContain('### Task.parse(arg0) _(static)_');
    });

    it('orders methods deterministically regardless of decoration order', () => {
        class Task {
            zebra(_value: number) {
                /* no-op */
            }

            alpha(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'zebra', 0, GreaterThan(0));
        recordParameterConstraint(Task.prototype, 'alpha', 0, GreaterThan(0));

        expect(documentClass(Task).methods.map(method => method.name)).toEqual(['alpha', 'zebra']);
    });

    it('renders a symbol method key', () => {
        const key = Symbol('send');

        class Task {}

        recordParameterConstraint(Task.prototype, key, 0, GreaterThan(0));

        expect(methodNamed(documentClass(Task), 'Symbol(send)').signature).toBe('Task.Symbol(send)(arg0)');
    });

    it('carries the reserved pre/post slots, empty, without rendering them', () => {
        // Postconditions are the top Tier 2 item (IDEA-4) and the registry already reserves the
        // slot. Carrying it here means adding them extends the renderer, not the model.
        class Task {
            run(_value: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, GreaterThan(0));

        const method = methodNamed(documentClass(Task), 'run');

        expect(method.pre).toEqual([]);
        expect(method.post).toEqual([]);
    });

    it('names an anonymous class rather than emitting an empty heading', () => {
        const Anonymous = (() => class {})();
        Object.defineProperty(Anonymous, 'name', {value: ''});

        expect(documentClass(Anonymous).name).toBe('(anonymous class)');
    });

    it('rejects a non-constructor', () => {
        expect(() => documentClass({} as any)).toThrow(/constructor/);
    });
});

// ---------------------------------------------------------------------------
// Markdown correctness
// ---------------------------------------------------------------------------

describe('markdown escaping', () => {
    it('escapes a pipe in an expectation so it cannot split a table row', () => {
        // A `matches` constraint over `^a|b$` is the obvious future case. Author-supplied prose
        // reaching a table cell unescaped would silently corrupt the document.
        const piped = {
            kind: 'string' as const,
            constraint: 'matches',
            params: {source: '^a|b$'},
            expectation: 'a string matching /^a|b$/',
        };

        const markdown = renderMarkdown([
            {
                name: 'Task',
                // `fields` is required rather than optional on `ClassDoc`: an optional band is one a
                // future projection can silently forget to populate, which is the failure this whole
                // task exists to remove. The cost is this one line.
                fields: [],
                methods: [
                    {
                        name: 'run',
                        isStatic: false,
                        signature: 'Task.run(value)',
                        installed: true,
                        parameters: [{index: 0, name: 'value', nameRecovered: true, constraints: [piped]}],
                        pre: [],
                        post: [],
                    },
                ],
            },
        ]);

        const row = markdown.split('\n').filter(line => /^\| `value`/.test(line))[0];

        expect(row).toContain('\\|');
        // Split on *unescaped* pipes — the delimiters a markdown renderer would honour. Four cells
        // means five delimiters, so six parts once the leading and trailing empties are counted.
        expect(row.split(/(?<!\\)\|/)).toHaveLength(6);
    });
});

// ---------------------------------------------------------------------------
// Layering (DEC-012)
// ---------------------------------------------------------------------------

describe('layering (DEC-012)', () => {
    it('imports from Core only — never from an adapter', () => {
        // Mechanical guard on the rule that makes "four artifacts from one declaration" hold for
        // both authoring forms. If a projection binds to the legacy adapter, the standard-decorator
        // path silently loses documentation.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const source: string = require('fs').readFileSync(require.resolve('./docs.ts'), 'utf8');
        const imports = source.match(/^import[\s\S]*?from '([^']+)';/gm) || [];

        expect(imports.length).toBeGreaterThan(0);
        imports.forEach(statement => {
            const specifier = (statement.match(/from '([^']+)'/) as RegExpMatchArray)[1];
            expect(specifier).toMatch(/^\.\.\/(Core|Contracts)\//);
        });
    });
});
