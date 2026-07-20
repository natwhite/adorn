/**
 * Tests for the documentation projection.
 *
 * **The registry is populated by hand here, not by decorators.** Registry-driven installation is
 * P1.3 and is not landed, so nothing wires a decorator to `recordParameterConstraint` yet. These
 * tests therefore exercise exactly the contract the projection actually depends on — the registry's
 * read API — which is what P1.3 will populate. They are not a substitute for an end-to-end test of
 * "decorate a class, get docs"; that test belongs with P1.3.
 */

import {
    markInstalled,
    recordParameterConstraint,
    registerContractedClass,
    resetRegistry,
    setParameterMetadata,
} from '../Core/ContractRegistry';
import {GreaterThanEqual, LessThanEqual, Positive} from '../Contracts/number';
import {StringMinLength} from '../Contracts/string';
import {
    ClassDoc,
    documentClass,
    documentContracts,
    generateMarkdown,
    renderMarkdown,
} from './docs';

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
            name: 'positive (Positive)',
            descriptor: Positive(),
            identity: 'positive',
            kind: 'number',
            params: {min: 0},
            expectation: 'a positive number',
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
                run(_value: unknown) { /* no-op */ }
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
                run(_value: unknown) { /* no-op */ }
            }

            recordParameterConstraint(Task.prototype, 'run', 0, testCase.descriptor);

            const markdown = renderMarkdown([documentClass(Task)]);

            expect(markdown).toContain(`\`${testCase.identity}\``);
            expect(markdown).toContain(testCase.expectation);
        });
    });

    it('keeps `positive` distinct from `min` even though they share a derivation', () => {
        // The identity is what documentation *names* ("must be positive"); `params.min` is what a
        // schema projection reads. Collapsing the two would lose the former — see number.ts.
        class Task {
            run(_a: number, _b: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, Positive());
        recordParameterConstraint(Task.prototype, 'run', 1, GreaterThanEqual(0));

        const parameters = methodNamed(documentClass(Task), 'run').parameters;

        expect(parameters[0].constraints[0].constraint).toBe('positive');
        expect(parameters[1].constraints[0].constraint).toBe('min');
        expect(parameters[0].constraints[0].params).toEqual(parameters[1].constraints[0].params);
        expect(parameters[0].constraints[0].expectation)
            .not.toBe(parameters[1].constraints[0].expectation);
    });
});

// ---------------------------------------------------------------------------
// A method with several parameters
// ---------------------------------------------------------------------------

describe('a method with several parameters', () => {
    class Task {
        send(_message: string, _count: number, _retries: number) { /* no-op */ }
    }

    beforeEach(() => {
        recordParameterConstraint(Task.prototype, 'send', 0, StringMinLength(10));
        setParameterMetadata(Task.prototype, 'send', 0, {name: 'message', type: String});

        recordParameterConstraint(Task.prototype, 'send', 1, GreaterThanEqual(1));
        recordParameterConstraint(Task.prototype, 'send', 1, LessThanEqual(100));
        setParameterMetadata(Task.prototype, 'send', 1, {name: 'count', type: Number});

        recordParameterConstraint(Task.prototype, 'send', 2, Positive());
        setParameterMetadata(Task.prototype, 'send', 2, {name: 'retries', type: Number});
    });

    it('orders parameters by index and keeps several constraints on one position', () => {
        const method = methodNamed(documentClass(Task), 'send');

        expect(method.parameters.map(parameter => parameter.index)).toEqual([0, 1, 2]);
        expect(method.parameters.map(parameter => parameter.name)).toEqual(['message', 'count', 'retries']);
        expect(method.parameters[1].constraints.map(constraint => constraint.constraint))
            .toEqual(['min', 'max']);
    });

    it('builds a signature from the recovered names', () => {
        expect(methodNamed(documentClass(Task), 'send').signature)
            .toBe('Task.send(message, count, retries)');
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

        expect(renderMarkdown([documentClass(Task)])).toBe([
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
            '| `retries` (2) | `Number` | `positive` | a positive number |',
            '',
        ].join('\n'));
    });
});

// ---------------------------------------------------------------------------
// The empty cases
// ---------------------------------------------------------------------------

describe('the empty case', () => {
    it('models a class with no contracts as an empty method list, not a failure', () => {
        class Plain {
            run() { /* no-op */ }
        }

        const classDoc = documentClass(Plain);

        expect(classDoc.name).toBe('Plain');
        expect(classDoc.methods).toEqual([]);
    });

    it('renders a class with no contracts without inventing any', () => {
        class Plain {
            run() { /* no-op */ }
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
            run(_value: unknown) { /* no-op */ }
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
            run(_value: number) { /* no-op */ }
        }

        class Unregistered {
            run(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Documented.prototype, 'run', 0, Positive());
        recordParameterConstraint(Unregistered.prototype, 'run', 0, Positive());
        registerContractedClass(Documented);

        expect(documentContracts().map(classDoc => classDoc.name)).toEqual(['Documented']);
    });

    it('generateMarkdown walks the registry in one call', () => {
        class Task {
            send(_message: string) { /* no-op */ }
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
            run(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, Positive());

        const parameter = methodNamed(documentClass(Task), 'run').parameters[0];

        expect(parameter.name).toBe('arg0');
        expect(parameter.nameRecovered).toBe(false);
        expect(parameter.typeName).toBeUndefined();
    });

    it('fills undecorated leading positions in the signature', () => {
        class Task {
            run(_ignored: string, _value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'run', 1, Positive());
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
            run(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, Positive());

        const classDoc = documentClass(Task);

        expect(methodNamed(classDoc, 'run').installed).toBe(false);
        expect(renderMarkdown([classDoc])).toContain('**Not enforced.**');

        markInstalled(Task.prototype, 'run');

        expect(renderMarkdown([documentClass(Task)])).not.toContain('**Not enforced.**');
    });

    it('documents static methods, which are recorded against the constructor', () => {
        class Task {
            static parse(_input: string) { /* no-op */ }

            run(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task, 'parse', 0, StringMinLength(3));
        recordParameterConstraint(Task.prototype, 'run', 0, Positive());

        const classDoc = documentClass(Task);

        expect(classDoc.methods.map(method => ({name: method.name, isStatic: method.isStatic})))
            .toEqual([
                {name: 'run', isStatic: false},
                {name: 'parse', isStatic: true},
            ]);
        expect(renderMarkdown([classDoc])).toContain('### Task.parse(arg0) _(static)_');
    });

    it('orders methods deterministically regardless of decoration order', () => {
        class Task {
            zebra(_value: number) { /* no-op */ }

            alpha(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'zebra', 0, Positive());
        recordParameterConstraint(Task.prototype, 'alpha', 0, Positive());

        expect(documentClass(Task).methods.map(method => method.name)).toEqual(['alpha', 'zebra']);
    });

    it('renders a symbol method key', () => {
        const key = Symbol('send');

        class Task {
        }

        recordParameterConstraint(Task.prototype, key, 0, Positive());

        expect(methodNamed(documentClass(Task), 'Symbol(send)').signature)
            .toBe('Task.Symbol(send)(arg0)');
    });

    it('carries the reserved pre/post slots, empty, without rendering them', () => {
        // Postconditions are the top Tier 2 item (IDEA-4) and the registry already reserves the
        // slot. Carrying it here means adding them extends the renderer, not the model.
        class Task {
            run(_value: number) { /* no-op */ }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, Positive());

        const method = methodNamed(documentClass(Task), 'run');

        expect(method.pre).toEqual([]);
        expect(method.post).toEqual([]);
    });

    it('names an anonymous class rather than emitting an empty heading', () => {
        const Anonymous = (() => class { })();
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

        const markdown = renderMarkdown([{
            name: 'Task',
            methods: [{
                name: 'run',
                isStatic: false,
                signature: 'Task.run(value)',
                installed: true,
                parameters: [{index: 0, name: 'value', nameRecovered: true, constraints: [piped]}],
                pre: [],
                post: [],
            }],
        }]);

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
