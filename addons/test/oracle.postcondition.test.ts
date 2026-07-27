/**
 * The contract oracle (Fuzzing Phase B, DEC-034) — the fuzzer checks the method's postconditions,
 * consuming BOTH bands exactly as the runtime wrapper does, on the same settled value (no drift).
 *
 * These classes are declared **inside** each test (SMELL-18): the field/postcondition bands read the
 * registry, so a class at module scope could be disarmed by another file's reset. `resetConfiguration()`
 * in `beforeEach` restores the default throw-on-violation enforcement the no-drift pins rely on.
 *
 * Discovery note: each `@Ensures` method also carries a decorated parameter, both because a postcondition
 * that relates the result to an argument needs that argument generated soundly, and because the fuzzer
 * discovers methods through `getContractsForClass` (the reified `@Returns` band lands there; a pure
 * `@Ensures` closure lives in the parallel postcondition band). This is the realistic shape.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {Returns} from '../../src/MethodDecorators/Returns';
import {Ensures} from '../../src/MethodDecorators/Ensures';
import {GreaterThan, GreaterThanEqual, LessThanEqual} from '../../src/Contracts/number';
import {Between} from '../../src/ParameterDecorators/Constraints';
import {resetConfiguration} from '../../src/Core/Configuration';
import {resetValueDisclosure, setValueDisclosure} from '../../src/Core/redaction';
import {fuzzMethod} from './oracle';
import {formatFuzzReport} from './report';

beforeEach(() => {
    resetConfiguration();
    resetValueDisclosure();
});
afterEach(resetValueDisclosure);

describe('reified @Returns band — the fuzzer finds a return that violates the descriptor', () => {
    it('finds a counterexample for a wrong implementation, and names the broken guarantee', () => {
        @Contract()
        class BadLedger {
            @Returns(GreaterThanEqual(0))
            compute(@Between(-100, 100) n: number): number {
                return n; // a negative input yields a negative return — violates `>= 0`
            }
        }

        const result = fuzzMethod({
            target: BadLedger,
            method: 'compute',
            subject: () => new BadLedger(),
            numRuns: 300,
        });

        expect(result.oracle).toBe('postcondition');
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toMatch(/greater than or equal to 0/);
        // The shrunk counterexample is a negative number — exactly what breaks the descriptor.
        expect((result.finding!.counterexample as [number])[0]).toBeLessThan(0);
    });

    it('a correct implementation passes, and reports which guarantee it verified', () => {
        @Contract()
        class GoodLedger {
            @Returns(GreaterThanEqual(0))
            compute(@Between(-100, 100) n: number): number {
                return Math.abs(n);
            }
        }

        const result = fuzzMethod({
            target: GoodLedger,
            method: 'compute',
            subject: () => new GoodLedger(),
            numRuns: 300,
        });

        expect(result.passed).toBe(true);
        expect(result.oracle).toBe('postcondition');
        expect(result.oraclesChecked).toHaveLength(1);
        expect(result.oraclesChecked[0]).toMatch(/@Returns/);
        expect(result.oraclesChecked[0]).toMatch(/greater than or equal to 0/);
    });
});

describe('@Ensures closure band — the fuzzer finds a return that violates the closure', () => {
    it('finds a counterexample for a wrong implementation, naming the closure description', () => {
        @Contract()
        class BadWallet {
            @Ensures((result, amount) => (result as number) <= 1000, 'never exceeds 1000')
            topUp(@Between(0, 5000) amount: number): number {
                return amount; // an amount over 1000 breaks the promise
            }
        }

        const result = fuzzMethod({
            target: BadWallet,
            method: 'topUp',
            subject: () => new BadWallet(),
            numRuns: 300,
        });

        expect(result.oracle).toBe('postcondition');
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toBe('never exceeds 1000');
        expect((result.finding!.counterexample as [number])[0]).toBeGreaterThan(1000);
    });

    it('a correct implementation passes', () => {
        @Contract()
        class GoodWallet {
            @Ensures(
                (result, amount) => (result as number) <= (amount as number),
                'never more than deposited',
            )
            topUp(@Between(0, 5000) amount: number): number {
                return amount;
            }
        }

        const result = fuzzMethod({
            target: GoodWallet,
            method: 'topUp',
            subject: () => new GoodWallet(),
            numRuns: 300,
        });

        expect(result.passed).toBe(true);
        expect(result.oraclesChecked).toEqual(['@Ensures: never more than deposited']);
    });

    it('a postcondition that THROWS is a finding, not a swallowed method error (§5.2 pt 1)', () => {
        @Contract()
        class Buggy {
            @Ensures(() => {
                throw new Error('oracle predicate bug');
            }, 'buggy check')
            f(@Between(0, 10) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({target: Buggy, method: 'f', subject: () => new Buggy(), numRuns: 50});

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.message).toMatch(/THREW/);
        expect(result.finding!.message).toMatch(/oracle predicate bug/);
    });
});

describe('a method with BOTH bands — the fuzzer consumes both, reified first', () => {
    it('passes when both hold, and names both guarantees in oraclesChecked', () => {
        @Contract()
        class Scaler {
            @Returns(GreaterThanEqual(0))
            @Ensures((result, n) => (result as number) === (n as number) * 2, 'doubles the input')
            scale(@Between(0, 100) n: number): number {
                return n * 2;
            }
        }

        const result = fuzzMethod({
            target: Scaler,
            method: 'scale',
            subject: () => new Scaler(),
            numRuns: 300,
        });

        expect(result.passed).toBe(true);
        expect(result.oraclesChecked).toHaveLength(2);
        expect(result.oraclesChecked.some(o => /@Returns/.test(o))).toBe(true);
        expect(result.oraclesChecked.some(o => /@Ensures/.test(o) && /doubles the input/.test(o))).toBe(true);
    });

    it('reports the reified @Returns break first when the return is negative', () => {
        @Contract()
        class ReifiedViolator {
            @Returns(GreaterThanEqual(0))
            @Ensures(result => (result as number) < 1000, 'under a thousand')
            f(@Between(-100, 100) n: number): number {
                return n; // negatives break `>= 0`; nothing in range breaks `< 1000`
            }
        }

        const result = fuzzMethod({
            target: ReifiedViolator,
            method: 'f',
            subject: () => new ReifiedViolator(),
            numRuns: 300,
        });

        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toMatch(/greater than or equal to 0/);
    });

    it('catches a closure break even when the reified band holds', () => {
        @Contract()
        class ClosureViolator {
            @Returns(GreaterThanEqual(0))
            @Ensures((result, n) => (result as number) === (n as number), 'returns the input unchanged')
            f(@Between(0, 100) n: number): number {
                return n + 1; // `n+1 >= 0` always holds; `n+1 === n` never does
            }
        }

        const result = fuzzMethod({
            target: ClosureViolator,
            method: 'f',
            subject: () => new ClosureViolator(),
            numRuns: 300,
        });

        expect(result.finding!.type).toBe('postcondition-violation');
        expect(result.finding!.postconditionDescription).toBe('returns the input unchanged');
    });
});

describe('inheritance — a subclass @Returns conjoins the parent (covariant strengthening, free)', () => {
    it('checks the conjoined base+subclass reified band', () => {
        @Contract()
        class Base {
            @Returns(GreaterThan(0))
            make(@Between(-50, 50) n: number): number {
                return n;
            }
        }
        @Contract()
        class Sub extends Base {
            @Returns(LessThanEqual(10))
            make(@Between(-50, 50) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({target: Sub, method: 'make', subject: () => new Sub(), numRuns: 300});

        // Both the parent's and the subclass's guarantee are checked.
        expect(result.oraclesChecked).toHaveLength(2);
        expect(result.oraclesChecked.some(o => /greater than 0/.test(o))).toBe(true);
        expect(result.oraclesChecked.some(o => /less than or equal to 10/.test(o))).toBe(true);
        // A negative input breaks the (base-most) `> 0` guarantee.
        expect(result.finding!.type).toBe('postcondition-violation');
    });
});

describe('auto oracle-mode selection (Phase A floor preserved, Q-3)', () => {
    it("picks 'postcondition' when a postcondition exists and 'weak-invariant' when not", () => {
        @Contract()
        class Mixed {
            @Returns(GreaterThanEqual(0))
            withPost(@Between(0, 10) n: number): number {
                return n;
            }
            noPost(@Between(0, 10) n: number): number {
                return n;
            }
        }
        const subject = () => new Mixed();

        expect(fuzzMethod({target: Mixed, method: 'withPost', subject}).oracle).toBe('postcondition');
        expect(fuzzMethod({target: Mixed, method: 'noPost', subject}).oracle).toBe('weak-invariant');
        // The floor stays selectable: force weak-invariant even when a postcondition exists.
        expect(
            fuzzMethod({target: Mixed, method: 'withPost', subject, oracle: 'weak-invariant'}).oracle,
        ).toBe('weak-invariant');
    });

    it('a no-postcondition method still gets the weak-invariant floor (doesn’t-throw)', () => {
        @Contract()
        class Fragile {
            crash(@Between(0, 100) n: number): number {
                if (n > 50) throw new RangeError('too big');
                return n;
            }
        }

        const result = fuzzMethod({
            target: Fragile,
            method: 'crash',
            subject: () => new Fragile(),
            numRuns: 300,
        });

        expect(result.oracle).toBe('weak-invariant');
        expect(result.finding!.type).toBe('unexpected-throw');
        expect(result.oraclesChecked).toEqual([]);
    });
});

describe('counterexample redaction — a report shows [REDACTED], not the raw value, by default (DEC-030)', () => {
    it('redacts the counterexample and return value, keeping seed+path for replay', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            compute(@Between(-100, 100) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({
            target: Ledger,
            method: 'compute',
            subject: () => new Ledger(),
            numRuns: 300,
        });
        const report = formatFuzzReport(result);

        expect(report).toContain('[REDACTED]');
        // The raw generated number does not appear on the counterexample line...
        expect(report).not.toMatch(/counterexample: \[-?\d/);
        // ...but the value-free replay handle does.
        expect(report).toMatch(/reproduce: seed -?\d+/);
    });

    it('discloses the value only under setValueDisclosure("all")', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            compute(@Between(-100, 100) n: number): number {
                return n;
            }
        }

        setValueDisclosure('all');
        const result = fuzzMethod({
            target: Ledger,
            method: 'compute',
            subject: () => new Ledger(),
            numRuns: 300,
        });
        const report = formatFuzzReport(result);

        expect(report).not.toContain('[REDACTED]');
        expect(report).toMatch(/counterexample: \[-?\d/);
    });
});

describe('DEC-034 no-drift — the fuzzer flags exactly what the enforced wrapper throws on', () => {
    it('reified band: enforced-throws(n) ⟺ the oracle flags n', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            identity(@Between(-100, 100) n: number): number {
                return n;
            }
        }
        const subject = () => new Ledger();

        const result = fuzzMethod({target: Ledger, method: 'identity', subject, numRuns: 500});
        expect(result.finding!.type).toBe('postcondition-violation');

        // (1) The counterexample the fuzzer surfaces is one the ENFORCED wrapper throws on.
        const [bad] = result.finding!.counterexample as [number];
        expect(bad).toBeLessThan(0);
        expect(() => subject().identity(bad)).toThrow(/return value/);

        // (2) A value the postcondition accepts does NOT throw under enforcement.
        expect(() => subject().identity(7)).not.toThrow();

        // (3) The boundary the wrapper enforces IS the boundary the oracle checks (one predicate, DEC-032).
        for (const n of [-100, -1, -0.5, 0, 0.5, 1, 100]) {
            expect(enforcedThrows(() => subject().identity(n))).toBe(n < 0);
        }
    });

    it('closure band: enforced-throws(amount) ⟺ the oracle flags amount', () => {
        @Contract()
        class Wallet {
            @Ensures((result, amount) => (result as number) <= 1000, 'never exceeds 1000')
            topUp(@Between(0, 5000) amount: number): number {
                return amount;
            }
        }
        const subject = () => new Wallet();

        const result = fuzzMethod({target: Wallet, method: 'topUp', subject, numRuns: 500});
        expect(result.finding!.type).toBe('postcondition-violation');

        const [bad] = result.finding!.counterexample as [number];
        expect(bad).toBeGreaterThan(1000);
        expect(() => subject().topUp(bad)).toThrow(/Postcondition failed/);

        for (const amount of [0, 500, 1000, 1000.5, 2000, 5000]) {
            expect(enforcedThrows(() => subject().topUp(amount))).toBe(amount > 1000);
        }
    });

    it('a correct implementation: the fuzzer passes and the wrapper never throws over the domain', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            identity(@Between(-100, 100) n: number): number {
                return Math.abs(n);
            }
        }
        const subject = () => new Ledger();

        const result = fuzzMethod({target: Ledger, method: 'identity', subject, numRuns: 500});
        expect(result.passed).toBe(true);
        for (const n of [-100, -1, 0, 1, 100]) {
            expect(enforcedThrows(() => subject().identity(n))).toBe(false);
        }
    });
});

/** Whether calling `run` throws — the enforced wrapper's verdict, as a boolean for the no-drift pins. */
function enforcedThrows(run: () => unknown): boolean {
    try {
        run();
        return false;
    } catch {
        return true;
    }
}
