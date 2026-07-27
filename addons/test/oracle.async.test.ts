/**
 * The async contract oracle (Fuzzing Phase B, DEC-034) — `fuzzMethodAsync` / `fuzzClassAsync`.
 *
 * Enforcement awaits the settled value before checking postconditions (the installer's `isThenable`
 * branch); the fuzzer must too. `fc.check(fc.property(...))` is synchronous, so the async twins use
 * `fc.asyncProperty` and `await fc.check(...)`, awaiting the resolved value before the oracle. A rejected
 * Promise skips both bands and is a robustness finding — the async twin of a sync throw — never a false
 * postcondition pass. The sync `fuzzMethod` declines an async method loudly rather than checking a
 * Promise object as if it were the answer.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {Returns} from '../../src/MethodDecorators/Returns';
import {Ensures} from '../../src/MethodDecorators/Ensures';
import {GreaterThanEqual} from '../../src/Contracts/number';
import {Between} from '../../src/ParameterDecorators/Constraints';
import {resetConfiguration} from '../../src/Core/Configuration';
import {fuzzClassAsync, fuzzMethod, fuzzMethodAsync} from './oracle';

beforeEach(() => {
    resetConfiguration();
});

describe('fuzzMethodAsync awaits the resolved value, then checks the postcondition', () => {
    it('finds a resolved value that violates the reified @Returns band', async () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async fetch(@Between(-100, 100) n: number): Promise<number> {
                return n;
            }
        }

        const result = await fuzzMethodAsync({
            target: Api,
            method: 'fetch',
            subject: () => new Api(),
            numRuns: 300,
        });

        expect(result.oracle).toBe('postcondition');
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toMatch(/greater than or equal to 0/);
        expect((result.finding!.counterexample as [number])[0]).toBeLessThan(0);
    });

    it('checks a resolved value against an @Ensures closure', async () => {
        @Contract()
        class Api {
            @Ensures((result, n) => (result as number) === (n as number), 'echoes the input')
            async echo(@Between(0, 100) n: number): Promise<number> {
                return n + 1; // never equal to the input — always breaks the promise
            }
        }

        const result = await fuzzMethodAsync({
            target: Api,
            method: 'echo',
            subject: () => new Api(),
            numRuns: 200,
        });

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toBe('echoes the input');
    });

    it('a correct async implementation passes with its guarantee named', async () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async fetch(@Between(-100, 100) n: number): Promise<number> {
                return Math.abs(n);
            }
        }

        const result = await fuzzMethodAsync({
            target: Api,
            method: 'fetch',
            subject: () => new Api(),
            numRuns: 300,
        });

        expect(result.passed).toBe(true);
        expect(result.oraclesChecked).toHaveLength(1);
    });
});

describe('a rejected Promise is a robustness finding, never a false postcondition pass', () => {
    it('reports the rejection as an unexpected-throw (the async twin of a sync throw)', async () => {
        @Contract()
        class Flaky {
            @Returns(GreaterThanEqual(0))
            async fetch(@Between(0, 10) n: number): Promise<number> {
                void n;
                throw new Error('upstream down');
            }
        }

        const result = await fuzzMethodAsync({
            target: Flaky,
            method: 'fetch',
            subject: () => new Flaky(),
            numRuns: 50,
        });

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('unexpected-throw');
        expect(result.finding!.message).toMatch(/upstream down/);
    });
});

describe('the sync fuzzMethod declines an async method — no Promise checked as a value', () => {
    it('returns a declined result pointing at fuzzMethodAsync', () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async fetch(@Between(0, 10) n: number): Promise<number> {
                return n;
            }
        }

        const result = fuzzMethod({target: Api, method: 'fetch', subject: () => new Api()});

        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/async/);
        expect(result.reason).toMatch(/fuzzMethodAsync/);
    });
});

describe('fuzzClassAsync fuzzes every method, awaiting each in turn', () => {
    it('returns one result per contracted method', async () => {
        @Contract()
        class Service {
            @Returns(GreaterThanEqual(0))
            async a(@Between(0, 10) n: number): Promise<number> {
                return n;
            }
            @Returns(GreaterThanEqual(0))
            async b(@Between(0, 10) n: number): Promise<number> {
                return n;
            }
        }

        const results = await fuzzClassAsync(Service, {subject: () => new Service(), numRuns: 40});

        expect(results).toHaveLength(2);
        expect(results.every(r => r.passed)).toBe(true);
        expect(results.every(r => r.oracle === 'postcondition')).toBe(true);
    });
});

describe('DEC-034 no-drift (async) — the fuzzer flags exactly what the enforced async wrapper rejects on', () => {
    it('enforced rejection ⟺ the oracle flags, for the reified band', async () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async fetch(@Between(-100, 100) n: number): Promise<number> {
                return n;
            }
        }
        const subject = () => new Api();

        const result = await fuzzMethodAsync({target: Api, method: 'fetch', subject, numRuns: 400});
        const [bad] = result.finding!.counterexample as [number];
        expect(bad).toBeLessThan(0);

        // The enforced wrapper (assert restored after the run) rejects on exactly the flagged input,
        // and resolves on an accepted one.
        await expect(subject().fetch(bad)).rejects.toThrow(/return value/);
        await expect(subject().fetch(42)).resolves.toBe(42);
    });
});
