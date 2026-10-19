/**
 * `fuzzFunction` — the free-function entry point (Fuzzing Phase B, voice-agent L19).
 *
 * A `contract()`-wrapped function is the shape a zero-class consumer actually has, and it was the one
 * shape the fuzzer could not accept (`fuzzMethod` is keyed on a class + method name). These pins prove the
 * functional path runs the SAME oracle the method path runs — both postcondition bands, the precondition
 * gate, the weak-invariant floor, async settling — sourced from the spec the wrapper now exposes, and that
 * "declined" stays distinct from "clean" for the cases that cannot be fuzzed.
 *
 * `resetConfiguration()` restores the default throw-on-violation policy the no-drift reads rely on; the
 * functional path runs the RAW target (not the wrapper), so a run never actually trips that policy, but the
 * reset keeps these tests independent of order regardless.
 */

import * as fc from 'fast-check';
import {contract, contractSpecOf, NumberContracts, StringContracts} from '../../index';
import {resetConfiguration} from '../../src/Core/Configuration';
import {resetValueDisclosure} from '../../src/Core/redaction';
import {fuzzFunction, fuzzFunctionAsync} from './oracle';
import {formatFuzzReport} from './report';

beforeEach(() => {
    resetConfiguration();
    resetValueDisclosure();
});
afterEach(resetValueDisclosure);

describe('fuzzFunction — a contract() function is fuzzed with the contract oracle (L19)', () => {
    it('a correct function passes, auto-selects the postcondition oracle, and covers its params', () => {
        const absVal = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            function absVal(n: number): number {
                return Math.abs(n);
            },
        );

        const result = fuzzFunction(absVal, {numRuns: 300});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.free).toBe(true);
        expect(result.target).toBe('absVal');
        expect(result.oracle).toBe('postcondition');
        // The param was contract-generated, not gap-filled — the spec's descriptor reached the generator.
        expect(result.coverage[0].constraints).toContain('between');
        expect(result.oraclesChecked.join(' ')).toMatch(/greater than or equal to 0/);
    });

    it('finds a return-descriptor violation and names the broken guarantee', () => {
        const identity = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            function identity(n: number): number {
                return n; // a negative input returns a negative number — violates `>= 0`
            },
        );

        const result = fuzzFunction(identity, {numRuns: 300, seed: 11});

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toMatch(/greater than or equal to 0/);
        expect((result.finding!.counterexample as [number])[0]).toBeLessThan(0);
    });

    it('finds a closure @Ensures-band violation (result related to an argument)', () => {
        const identity = contract(
            {
                params: [NumberContracts.Between(-100, 100)],
                ensures: [
                    {
                        predicate: (r: unknown, n: unknown) => r === Math.abs(n as number),
                        description: 'result is abs(n)',
                    },
                ],
            },
            function identity(n: number): number {
                return n;
            },
        );

        const result = fuzzFunction(identity, {numRuns: 300, seed: 5});

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toMatch(/abs\(n\)/);
    });

    it('the weak-invariant floor still applies with no postconditions: an input that crashes is found', () => {
        const risky = contract(
            {params: [NumberContracts.Between(-100, 100)]},
            function risky(n: number): number {
                if (n < 0) throw new Error('boom on negatives');
                return n;
            },
        );

        const result = fuzzFunction(risky, {numRuns: 300, seed: 3});

        expect(result.oracle).toBe('weak-invariant');
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('unexpected-throw');
        expect(result.finding!.message).toMatch(/boom on negatives/);
    });

    it('the precondition gate filters the domain, exactly as @Requires does (DEC-057)', () => {
        // Without the `requires` gate a negative `n` would return negative and break `>= 0`. The gate
        // restricts generated tuples to `n >= 0`, so a correct-under-precondition function passes — proving
        // the whole-tuple gate is applied on the functional path too.
        const gated = contract(
            {
                params: [NumberContracts.Between(-100, 100)],
                requires: [(n: number) => n >= 0],
                returns: NumberContracts.GreaterThanEqual(0),
            },
            function gated(n: number): number {
                return n;
            },
        );

        const result = fuzzFunction(gated, {numRuns: 300});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
    });

    it('honours an explicit weak-invariant override, skipping the postcondition oracle', () => {
        const identity = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            function identity(n: number): number {
                return n; // would break `>= 0`, but the override never checks it
            },
        );

        const result = fuzzFunction(identity, {numRuns: 200, oracle: 'weak-invariant'});

        expect(result.oracle).toBe('weak-invariant');
        expect(result.passed).toBe(true); // no crash; the return band was deliberately not checked
    });
});

describe('fuzzFunction — declines, distinct from clean (L19)', () => {
    it('declines a function not produced by contract(), naming why', () => {
        const plain = (n: number): number => n * 2;

        const result = fuzzFunction(plain, {numRuns: 50});

        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/not a contract\(\) function/);
        expect(result.free).toBe(true);
    });

    it('declines a sync fuzz of an async function, pointing at fuzzFunctionAsync', () => {
        const later = contract(
            {params: [NumberContracts.Between(0, 10)], returns: NumberContracts.GreaterThanEqual(0)},
            async function later(n: number): Promise<number> {
                return n;
            },
        );

        const result = fuzzFunction(later, {numRuns: 50});

        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/fuzzFunctionAsync/);
    });
});

describe('fuzzFunctionAsync — the async twin (L19)', () => {
    it('awaits the settled value and passes a correct async function', async () => {
        const asyncAbs = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            async function asyncAbs(n: number): Promise<number> {
                return Math.abs(n);
            },
        );

        const result = await fuzzFunctionAsync(asyncAbs, {numRuns: 200});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.oracle).toBe('postcondition');
    });

    it('finds a violation in the settled value of an async function', async () => {
        const asyncId = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            async function asyncId(n: number): Promise<number> {
                return n;
            },
        );

        const result = await fuzzFunctionAsync(asyncId, {numRuns: 300, seed: 7});

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect((result.finding!.counterexample as [number])[0]).toBeLessThan(0);
    });
});

describe('fuzzFunction infers arity, so a params-less spec is not a false positive (L22)', () => {
    it('generates a position for an argument the spec does not describe (arity from Function.length)', () => {
        // A spec with only `returns` is legal — every ContractSpec field is optional. The function still
        // takes an argument; deriving zero positions and calling it with none would throw and misreport a
        // clean function. Arity is now read from the function, so the position is generated and gap-filled.
        const usesArg = contract(
            {returns: NumberContracts.GreaterThanEqual(0)},
            function usesArg(o: {n: number}): number {
                return Math.abs(o.n); // dereferences its argument — a no-arg call would throw
            },
        );

        const result = fuzzFunction(usesArg, {numRuns: 50, gapFill: fc.record({n: fc.integer()})});

        expect(result.coverage.length).toBe(1); // from Function.length, not the absent spec.params
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true); // no spurious unexpected-throw from a zero-argument call
    });

    it('generates every position up to the arity, gap-filling the ones the spec does not declare', () => {
        const twoArgs = contract(
            {params: [NumberContracts.Between(0, 10)]}, // declares position 0 only
            function twoArgs(a: number, b: {n: number}): number {
                return a + b.n;
            },
        );

        const result = fuzzFunction(twoArgs, {numRuns: 50, gapFill: fc.record({n: fc.integer()})});

        expect(result.coverage.length).toBe(2); // max(spec.params.length = 1, Function.length = 2)
        expect(result.coverage[0].constraints).toContain('between'); // declared position keeps its generator
        expect(result.coverage[1].strategy).toBe('gap-fill'); // undeclared position, gap-filled
        expect(result.passed).toBe(true);
    });

    it('a genuinely nullary function runs with no arguments and is not declined', () => {
        const nullary = contract({returns: NumberContracts.GreaterThanEqual(0)}, function nullary(): number {
            return 42;
        });

        const result = fuzzFunction(nullary, {numRuns: 10});

        expect(result.coverage.length).toBe(0);
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
    });
});

describe('the wrapper is now introspectable (L19)', () => {
    it('contractSpecOf recovers the spec a contract() wrapper enforces; a plain function has none', () => {
        const spec = {params: [NumberContracts.Between(1, 7)]};
        const f = contract(spec, (n: number) => n);

        expect(contractSpecOf(f)).toBe(spec);
        expect(contractSpecOf((n: number) => n)).toBeUndefined();
    });

    it('preserves the wrapped function name, so a report can say what it fuzzed (not "wrapped")', () => {
        const f = contract({params: [StringContracts.NotEmpty()]}, function greet(s: string) {
            return s;
        });
        expect(f.name).toBe('greet');
    });

    it('preserves the wrapped function arity (Function.length), not just its name (L22)', () => {
        const f = contract(
            {returns: NumberContracts.GreaterThanEqual(0)},
            function add(a: number, b: number): number {
                return a + b;
            },
        );
        expect(f.length).toBe(2); // a bare (...args) => … wrapper would report 0
        expect(f.name).toBe('add');
    });
});

describe('the fuzz report renders a free function honestly (L19)', () => {
    it('names it target(), with no class-only field-invariant line', () => {
        const absVal = contract(
            {params: [NumberContracts.Between(-100, 100)], returns: NumberContracts.GreaterThanEqual(0)},
            function absVal(n: number): number {
                return Math.abs(n);
            },
        );

        const report = formatFuzzReport(fuzzFunction(absVal, {numRuns: 50}));

        expect(report).toMatch(/absVal\(\)/);
        expect(report).not.toMatch(/class declares no field contracts/);
    });
});
