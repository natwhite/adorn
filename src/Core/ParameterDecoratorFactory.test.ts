/**
 * BUG-14 — enforcement and documentation must name the same parameter.
 *
 * ## Why this file exists at all
 *
 * `setParameterMetadata` had no production caller. It was reachable only from its own unit tests and
 * from `src/Projections/docs.test.ts`, **which populates the registry by hand**. So the projection's
 * suite was green while describing a registry state no decorator had ever produced: enforcement
 * recovered real names for its violation messages and told nobody, and one declaration yielded an
 * error saying `parameter 'sku'` beside a document saying `arg0`.
 *
 * That is the failure mode DEC-011 and the plan both call worse than an unenforced contract — the
 * artifact looks complete. It survived because every existing test approached the registry from the
 * write side.
 *
 * **Everything below therefore goes through real `@` syntax.** No test in this file calls
 * `recordParameterConstraint` or `setParameterMetadata` directly; the classes are decorated the way a
 * user decorates them, installed the way `@Contract()` installs them, and then read through the same
 * projection a documentation run reads. A fix verified only by unit test would have reproduced
 * precisely the blind spot that hid the bug.
 *
 * `reflect-metadata` is deliberately NOT loaded here — see the sibling
 * `ParameterDecoratorFactory.metadata.test.ts` for the type half. Splitting them is what proves the
 * degradation is honest rather than incidental: names must flow with or without it.
 */

import {
    GreaterThan,
    GreaterThanEqual,
    StringMinLength,
} from '../ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from './ParameterDecoratorFactory';
import {Contract, Validate} from './ContractInstaller';
import {getContract} from './ContractRegistry';
import {documentClass} from '../Projections/docs';
import {DecoratorFactory} from './common';

describe('preconditions of this file', () => {
    it('runs WITHOUT reflect-metadata, so no design:paramtypes is available', () => {
        // If this fails the file is asserting the wrong half of the story: the
        // "degrades honestly" assertions below would be trivially satisfiable.
        expect(typeof (Reflect as any).getMetadata).toBe('undefined');
    });
});

describe('BUG-14 — parameter names reach the registry from the real decorator path', () => {
    @Contract()
    class Order {
        place(@StringMinLength(3) sku: string, @GreaterThanEqual(1) quantity: number) {
            return `${sku}x${quantity}`;
        }
    }

    it('records the recovered names, not nothing', () => {
        const contract = getContract(Order.prototype, 'place')!;

        expect(contract.params.map(p => p.name)).toEqual(['sku', 'quantity']);
    });

    it('renders the real names in the generated document', () => {
        const [method] = documentClass(Order).methods;

        expect(method.signature).toBe('Order.place(sku, quantity)');
        expect(method.parameters.map(p => p.name)).toEqual(['sku', 'quantity']);
        expect(method.parameters.every(p => p.nameRecovered)).toBe(true);
    });

    /**
     * THE REGRESSION ITSELF. Everything above could pass while the two artifacts still disagreed —
     * this is the assertion that ties them together, by extracting the name from each side and
     * comparing them rather than comparing each to a literal.
     */
    it('the violation message and the document name the same parameter', () => {
        let thrown = '';
        try {
            new Order().place('ab', 5);
        } catch (error: any) {
            thrown = error.message;
        }

        const enforced = /parameter '([^']+)'/.exec(thrown)![1];
        const documented = documentClass(Order).methods[0].parameters[0].name;

        expect(enforced).toBe(documented);

        // ...and the whole message, so a future change to either side is visible rather than merely
        // consistent-with-itself.
        expect(thrown).toBe(
            "Value Error: Order.place(sku, quantity) parameter 'sku' " +
            "expected a string of length greater than 3 but received 'ab' instead",
        );
    });

    it('records names on the @Validate() path too, not only @Contract()', () => {
        class Shipment {
            @Validate()
            send(@StringMinLength(2) carrier: string) { return carrier; }
        }

        expect(getContract(Shipment.prototype, 'send')!.params[0].name).toBe('carrier');
        expect(documentClass(Shipment).methods[0].signature).toBe('Shipment.send(carrier)');
    });

    it('records names for a static method as well', () => {
        @Contract()
        class Parser {
            static parse(@StringMinLength(3) input: string) { return input.trim(); }
        }

        expect(getContract(Parser, 'parse')!.params[0].name).toBe('input');
        expect(documentClass(Parser).methods[0].signature).toBe('Parser.parse(input)');
    });
});

describe('types — present when the toolchain emits them, absent when it does not', () => {
    @Contract()
    class Order {
        place(@StringMinLength(3) sku: string) { return sku; }
    }

    it('records no type at all without reflect-metadata, rather than inventing one', () => {
        // The honest degradation. `design:paramtypes` needs `emitDecoratorMetadata` AND a metadata
        // polyfill; esbuild ignores the former permanently (DEC-004) and Babel drops legacy
        // parameter decorators outright. A type could have been guessed from `typeof value` on the
        // first call — that would be a claim the compiler never made, so it is not made here.
        const parameter = getContract(Order.prototype, 'place')!.params[0];

        expect(parameter.type).toBeUndefined();
        expect(parameter.name).toBe('sku'); // names do NOT depend on the metadata emit
    });

    it('omits the Type column value in the document instead of filling it with a guess', () => {
        const parameter = documentClass(Order).methods[0].parameters[0];

        expect(parameter.typeName).toBeUndefined();
        expect('typeName' in parameter).toBe(false);
    });
});

describe('Q-10 — how much of the arity problem the name recovery solves', () => {
    it('names an UNDECORATED leading parameter instead of rendering arg0', () => {
        @Contract()
        class Report {
            render(format: string, @GreaterThanEqual(1) pageSize: number) { return `${format}${pageSize}`; }
        }

        // Position 0 carries no constraint, so before this it had no registry entry at all and the
        // signature was rebuilt as `arg0`. The name parse sees the whole declaration.
        expect(documentClass(Report).methods[0].signature).toBe('Report.render(format, pageSize)');
        expect(getContract(Report.prototype, 'render')!.params.map(p => p.index)).toEqual([0, 1]);
    });

    it('keeps a TRAILING undecorated parameter visible instead of dropping it', () => {
        @Contract()
        class Report {
            render(@StringMinLength(1) format: string, verbose: boolean) { return `${format}${verbose}`; }
        }

        // The signature used to be rebuilt as `0..maxContractedIndex`, so a trailing undecorated
        // parameter vanished entirely — a document describing a narrower method than the code has.
        expect(documentClass(Report).methods[0].signature).toBe('Report.render(format, verbose)');
    });

    it('adds no constraint rows for the positions it merely names', () => {
        @Contract()
        class Report {
            render(format: string, @GreaterThanEqual(1) pageSize: number) { return `${format}${pageSize}`; }
        }

        const parameters = documentClass(Report).methods[0].parameters;

        expect(parameters[0].constraints).toEqual([]);
        expect(parameters[1].constraints).toHaveLength(1);
    });

    it('does NOT invent positions when the name parse cannot be trusted', () => {
        // `getParamNames` regex-parses `toString()`, and a destructured parameter defeats it:
        // `['{a', 'b}', 'n']` is three "names" for two parameters. Recording those onto decorated
        // positions keeps enforcement and the registry saying the same (imperfect) thing; conjuring
        // a THIRD parameter out of the miscount would put a fiction in the document that nothing at
        // runtime would ever contradict.
        @Contract()
        class Odd {
            run({a, b}: {a: number, b: number}, @GreaterThan(0) n: number) { return a + b + n; }
        }

        const indices = getContract(Odd.prototype, 'run')!.params.map(p => p.index);

        expect(indices).toEqual([1]);
        expect(indices).not.toContain(2);
    });

    it('does not invent positions for a rest parameter either', () => {
        @Contract()
        class Sum {
            add(@GreaterThan(0) first: number, ...rest: number[]) { return first + rest.length; }
        }

        // `...rest` is not a fixed slot, so the parse is not treated as a signature. The decorated
        // position still gets its name.
        expect(getContract(Sum.prototype, 'add')!.params.map(p => p.index)).toEqual([0]);
        expect(getContract(Sum.prototype, 'add')!.params[0].name).toBe('first');
    });
});

describe('the registry is not given contracts it cannot describe', () => {
    it('a CreateSimpleDecorator-only method still records nothing (SMELL-14 unchanged)', () => {
        const NonEmpty = () => ParameterDecoratorFactory.CreateSimpleDecorator(params => {
            if (!params.value) throw new Error(`${params.signature} must not be empty`);
        });

        @Contract()
        class Legacy {
            run(@NonEmpty() value: string) { return value; }
        }

        // Signature capture must not be the thing that finally creates a phantom entry for a
        // closure-only method — a projection would then render it as "contracted, no constraints",
        // which is a different lie from the one SMELL-14 already documents.
        expect(getContract(Legacy.prototype, 'run')).toBeUndefined();
        expect(documentClass(Legacy).methods).toEqual([]);

        // ...and it is still enforced, which is exactly SMELL-14's point.
        expect(() => new Legacy().run('')).toThrow(/must not be empty/);
    });
});

describe('BUG-12 — getObjectName resolves the constructor band', () => {
    it('returns the class name for a prototype', () => {
        class Task { run() { return 1; } }

        expect(DecoratorFactory.getObjectName(Task.prototype)).toBe('Task');
    });

    it('returns the class name for a CONSTRUCTOR, not "Function"', () => {
        class Task { static parse() { return 1; } }

        // A static member's decoration target IS the constructor, so `target.constructor` is
        // `Function`. That produced `Function.parse(input)` in every static violation message.
        expect(DecoratorFactory.getObjectName(Task)).toBe('Task');
        expect(DecoratorFactory.getObjectName(Task)).not.toBe('Function');
    });

    it('still reports Function for an actual function-typed value', () => {
        // Not over-corrected: `Function` really is the answer when the thing being named is the
        // `Function` constructor itself.
        expect(DecoratorFactory.getObjectName(Function)).toBe('Function');
    });

    it('degrades to a falsy name rather than throwing on unnameable targets', () => {
        // Callers substitute their own placeholder — `ContractInstaller` uses `<anonymous class>`.
        expect(DecoratorFactory.getObjectName(Object.create(null))).toBeFalsy();
        expect(DecoratorFactory.getObjectName(class {})).toBe('');
        expect(DecoratorFactory.getObjectName((class {}).prototype)).toBe('');
    });
});
