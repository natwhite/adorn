/**
 * The weak invariant oracle (foundation §5.3) — what it catches, and what it honestly does not.
 *
 * These tests declare each contracted class **inside** the test that uses it (SMELL-18): the field
 * band reads the registry on every assignment, so a class declared at module scope could be disarmed
 * by another file's `resetRegistry`. `resetConfiguration()` in `beforeEach` restores the default
 * throw-on-violation enforcement the oracle relies on.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {Between, GreaterThanEqual, Integer, NotEmpty} from '../../src/ParameterDecorators/Constraints';
import {Enforce} from '../../src/FieldDecorators/Enforce';
import {resetConfiguration} from '../../src/Core/Configuration';
import {fuzzClass, fuzzMethod} from './oracle';

beforeEach(() => {
    resetConfiguration();
});

describe('robustness — the oracle finds a planted crash and reports its seed', () => {
    it('finds a valid input that crashes the method, with a reproducible seed and counterexample', () => {
        @Contract()
        class Fragile {
            // `notEmpty` admits a 10 000-char string; the body crashes on any string longer than 3.
            parse(@NotEmpty() text: string): number {
                if (text.length > 3) throw new RangeError('too long');
                return text.length;
            }
        }

        const result = fuzzMethod({
            target: Fragile,
            method: 'parse',
            subject: () => new Fragile(),
            numRuns: 300,
        });

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(false);
        expect(result.finding).toBeDefined();
        expect(result.finding!.type).toBe('unexpected-throw');
        expect(result.finding!.message).toMatch(/too long/);
        expect(typeof result.finding!.seed).toBe('number');
        // The counterexample is the argument tuple; shrunk, it is a shortest over-length string.
        const [arg] = result.finding!.counterexample as [string];
        expect(typeof arg).toBe('string');
        expect(arg.length).toBeGreaterThan(3);
    });
});

describe('a contract violation on precondition-valid input is a finding, not a crash', () => {
    it('flags a method that drives a @Enforce field out of bounds (the accessor throws)', () => {
        @Contract()
        class Counter {
            @Enforce.greaterThanEqual(0) count = 5;
            decrement(@Between(1, 10) by: number): void {
                // For by > 5 the new value is negative; the validating setter throws a "Value Error:".
                this.count = this.count - by;
            }
        }

        const result = fuzzMethod({
            target: Counter,
            method: 'decrement',
            subject: () => new Counter(),
            numRuns: 300,
        });

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('contract-violation');
        expect(result.finding!.message).toMatch(/^Value Error:/);
    });
});

describe('invariant preservation — the narrow delta over field accessors (stated honestly)', () => {
    it('catches a field left out of bounds when a method BYPASSES the validating accessor', () => {
        @Contract()
        class Ledger {
            @Enforce.greaterThanEqual(0) balance = 100;
            // A mutation that does NOT go through the accessor — an ordinary `this.balance = target`
            // would THROW at assignment (and be caught as a contract-violation); this defineProperty
            // bypass leaves the field silently out of bounds, which ONLY the invariant re-check sees.
            // That is the exact, narrow delta the re-check adds over field-accessor enforcement.
            forceSet(@Between(-100, 100) target: number): void {
                Object.defineProperty(this, 'balance', {
                    value: target,
                    configurable: true,
                    enumerable: true,
                    writable: true,
                });
            }
        }

        const result = fuzzMethod({
            target: Ledger,
            method: 'forceSet',
            subject: () => new Ledger(),
            numRuns: 300,
        });

        expect(result.invariantsChecked).toContain('balance');
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('invariant-violation');
        expect(result.finding!.field).toBe('balance');
        expect(result.finding!.constraint).toBe('min');
        // The counterexample is a negative target — a value the accessor would have rejected.
        expect((result.finding!.counterexample as [number])[0]).toBeLessThan(0);
    });

    it('does NOT fire for ordinary assignment, which the accessor already guards (no false delta)', () => {
        @Contract()
        class Safe {
            @Enforce.greaterThanEqual(0) balance = 100;
            add(@Between(0, 50) amount: number): void {
                this.balance = this.balance + amount; // only ever increases — always valid
            }
        }

        const result = fuzzMethod({target: Safe, method: 'add', subject: () => new Safe(), numRuns: 200});
        expect(result.passed).toBe(true);
        expect(result.finding).toBeUndefined();
    });
});

describe('a clean method passes, and the pass is reproducible', () => {
    it('reports passed with the coverage that backs the claim', () => {
        @Contract()
        class Adder {
            add(@Between(0, 100) a: number, @Between(0, 100) b: number): number {
                return a + b;
            }
        }

        const result = fuzzMethod({
            target: Adder,
            method: 'add',
            subject: () => new Adder(),
            numRuns: 200,
        });

        expect(result.passed).toBe(true);
        expect(result.declined).toBe(false);
        expect(typeof result.seed).toBe('number');
        expect(result.coverage.map(c => c.strategy)).toEqual(['parametric', 'parametric']);
    });

    it('same seed reproduces the same counterexample (fast-check seed + pure generators, DEC-010)', () => {
        const make = () => {
            @Contract()
            class Fragile {
                parse(@NotEmpty() text: string): number {
                    if (text.length > 3) throw new RangeError('too long');
                    return text.length;
                }
            }
            return Fragile;
        };

        const A = make();
        const B = make();
        const run = (Cls: Function) =>
            fuzzMethod({
                target: Cls,
                method: 'parse',
                subject: () => new (Cls as new () => object)(),
                seed: 4242,
                numRuns: 300,
            });

        const first = run(A);
        const second = run(B);
        expect(first.finding).toBeDefined();
        expect(second.finding).toBeDefined();
        expect(second.seed).toBe(first.seed);
        expect(second.finding!.counterexample).toEqual(first.finding!.counterexample);
    });
});

describe('declining honestly — never a silent skip (report-own-boundary, §3)', () => {
    it('declines a method with no recorded contract', () => {
        @Contract()
        class Plain {
            greet(@NotEmpty() name: string): string {
                return `hi ${name}`;
            }
        }

        const result = fuzzMethod({target: Plain, method: 'untouched' as never, subject: () => new Plain()});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/no contract recorded/);
    });

    it('declines an instance method when no subject factory is supplied', () => {
        @Contract()
        class NeedsSubject {
            run(@GreaterThanEqual(0) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({target: NeedsSubject, method: 'run'});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/instance method/);
    });
});

describe('static methods need no subject and skip the invariant re-check (no receiver)', () => {
    it('fuzzes a static method against its parameter contracts', () => {
        @Contract()
        class Parser {
            static clamp(@Between(0, 10) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({target: Parser, method: 'clamp'});
        expect(result.isStatic).toBe(true);
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.invariantsChecked).toEqual([]);
    });
});

describe('fuzzClass fuzzes both bands of a class', () => {
    it('returns one result per contracted method, declining instance methods without a subject', () => {
        @Contract()
        class Mixed {
            static id(@Integer() n: number): number {
                return n;
            }
            echo(@NotEmpty() s: string): string {
                return s;
            }
        }

        const withoutSubject = fuzzClass(Mixed);
        expect(withoutSubject).toHaveLength(2);
        const echo = withoutSubject.find(r => r.method === 'echo')!;
        expect(echo.declined).toBe(true); // instance method, no subject

        const withSubject = fuzzClass(Mixed, {subject: () => new Mixed()});
        expect(withSubject.every(r => !r.declined)).toBe(true);
    });
});
