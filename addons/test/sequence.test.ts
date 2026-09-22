/**
 * The stateful call-sequence tester (DEC-090) — the payoff of `@EnabledWhen` (DEC-089).
 *
 * These pin the things that matter: a not-enabled call is SKIPPED, not false-positived (the payoff a
 * naive tester gets wrong); a genuine multi-step interaction that breaks an invariant is FOUND and
 * shrunk; a throwing `@EnabledWhen` guard is a finding (not a skip, not an unexpected-throw);
 * `@Requires` starvation is a warning; the run is deterministic under a fixed seed; declines are honest;
 * inheritance is respected; and the async twin awaits each settled value.
 *
 * Classes are declared INSIDE each test (SMELL-18) — the registry bands read on assignment, so a class
 * at module scope could be disarmed by another file's `resetRegistry`. `resetConfiguration()` restores
 * the default throw-on-violation enforcement the oracle relies on.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {Between, Integer} from '../../src/ParameterDecorators/Constraints';
import {Enforce} from '../../src/FieldDecorators/Enforce';
import {Requires} from '../../src/MethodDecorators/Requires';
import {EnabledWhen} from '../../src/MethodDecorators/EnabledWhen';
import {resetConfiguration} from '../../src/Core/Configuration';
import {fuzzSequence, fuzzSequenceAsync} from './sequence';
import {formatSequenceReport} from './report';

beforeEach(resetConfiguration);

describe('the payoff — enabledness gating skips a not-enabled call instead of false-positiving', () => {
    it('drives a @EnabledWhen-guarded nullary pop() and never calls it on an empty stack', () => {
        @Contract()
        class Stack {
            private items: number[] = [];
            push(@Integer() x: number): void {
                this.items.push(x);
            }
            // Nullary + guarded ONLY by @EnabledWhen: invisible to the contract band, so the driver must
            // enumerate it via the enabledness band. The canary proves it is never run on an empty stack.
            @EnabledWhen((self: Stack) => self.items.length > 0, 'stack is non-empty')
            pop(): number {
                const v = this.items.pop();
                if (v === undefined) throw new Error('pop on empty — enabledness gating failed');
                return v;
            }
        }

        const result = fuzzSequence(Stack, {subject: () => new Stack(), numRuns: 200, maxSteps: 12});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.finding).toBeUndefined();
        // Both commands were driven; pop came from the enabledness band and carries a guard.
        expect(result.commands.map(c => c.method).sort()).toEqual(['pop', 'push']);
        expect(result.commands.find(c => c.method === 'pop')!.enabledness).toBe(true);
    });
});

describe('finding — a genuine multi-step interaction that breaks an invariant is found and shrunk', () => {
    it('finds a sequence of takes that drives a @Enforce field negative (needs ≥3 steps)', () => {
        @Contract()
        class Countdown {
            @Enforce.greaterThanEqual(0) remaining = 8;
            take(@Between(1, 3) n: number): void {
                this.remaining -= n; // the validating setter throws once the cumulative take exceeds 8
            }
        }

        const result = fuzzSequence(Countdown, {subject: () => new Countdown(), numRuns: 300, maxSteps: 15});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(false);
        expect(result.finding).toBeDefined();
        expect(['contract-violation', 'invariant-violation']).toContain(result.finding!.type);
        // No single take from 8 can go negative (max step 3), so the counterexample is a real sequence.
        expect(result.finding!.steps.length).toBeGreaterThanOrEqual(3);
        expect(result.finding!.steps.every(s => s.method === 'take')).toBe(true);
        expect(typeof result.finding!.seed).toBe('number');
    });
});

describe('finding — a throwing @EnabledWhen guard is a defect, not a skip or an unexpected-throw', () => {
    it('classifies a guard that throws as enabledness-guard-throw', () => {
        @Contract()
        class Fragile {
            inner: {ready: boolean} | null = {ready: true};
            @EnabledWhen((self: Fragile) => self.inner!.ready, 'inner is ready')
            act(): void {
                this.inner = null; // the NEXT act's guard dereferences null → the guard throws
            }
        }

        const result = fuzzSequence(Fragile, {subject: () => new Fragile(), numRuns: 200, maxSteps: 10});

        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('enabledness-guard-throw');
        expect(result.finding!.message).toMatch(/THREW/);
        expect(result.finding!.message).not.toMatch(/Not enabled/);
    });
});

describe('warnings — @Requires starvation is surfaced, a not-enabled command is not starvation', () => {
    it('surfaces the @Requires generate-and-filter warning without a finding', () => {
        @Contract()
        class Gated {
            total = 0;
            @Requires((n: number) => n > 8, 'n exceeds 8') // ~20% of [0,10] — below the starvation threshold
            add(@Between(0, 10) n: number): void {
                this.total += n;
            }
        }

        const result = fuzzSequence(Gated, {subject: () => new Gated(), numRuns: 60, maxSteps: 8});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.warnings.some(w => /@Requires generate-and-filter/.test(w))).toBe(true);
    });
});

describe('determinism — a fixed seed reproduces the finding exactly', () => {
    it('two runs with the same seed give the same steps, seed, and path', () => {
        @Contract()
        class Countdown {
            @Enforce.greaterThanEqual(0) remaining = 8;
            take(@Between(1, 3) n: number): void {
                this.remaining -= n;
            }
        }
        const opts = {subject: () => new Countdown(), numRuns: 300, maxSteps: 15, seed: 777};

        const a = fuzzSequence(Countdown, opts);
        const b = fuzzSequence(Countdown, opts);

        expect(a.passed).toBe(false);
        expect(b.finding!.seed).toBe(a.finding!.seed);
        expect(b.finding!.path).toBe(a.finding!.path);
        expect(b.finding!.steps).toEqual(a.finding!.steps);
    });
});

describe('declines — honest, never a silent skip', () => {
    it('declines an instance class with no subject factory', () => {
        @Contract()
        class Wallet {
            @Enforce.greaterThanEqual(0) balance = 0;
            deposit(@Between(1, 5) n: number): void {
                this.balance += n;
            }
        }
        const result = fuzzSequence(Wallet, {subject: undefined as unknown as () => object});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/subject/);
    });

    it('declines a class with no contracted instance commands to sequence', () => {
        @Contract()
        class Empty {
            plain(): number {
                return 1; // no per-position, @Returns, or @EnabledWhen constraint → nothing to sequence
            }
        }
        const result = fuzzSequence(Empty, {subject: () => new Empty()});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/no contracted instance methods|nothing to sequence/i);
    });
});

describe('inheritance — an inherited @EnabledWhen is respected when sequencing a subclass (DEC-022)', () => {
    it('skips a not-enabled inherited command on a subclass', () => {
        @Contract()
        class Base {
            depth = 0;
            rise(@Between(1, 3) n: number): void {
                this.depth += n;
            }
            @EnabledWhen((self: Base) => self.depth > 0, 'depth above zero')
            drop(): void {
                if (this.depth <= 0) throw new Error('drop below zero — inherited guard not respected');
                this.depth -= 1;
            }
        }
        @Contract()
        class Sub extends Base {
            rise(n: number): void {
                super.rise(n);
            }
            drop(): void {
                super.drop();
            }
        }

        const result = fuzzSequence(Sub, {subject: () => new Sub(), numRuns: 200, maxSteps: 12});

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true); // the inherited guard makes drop-on-empty a SKIP, not a crash
        expect(result.commands.find(c => c.method === 'drop')!.enabledness).toBe(true);
    });
});

describe('async — fuzzSequenceAsync awaits each settled value; sync declines an async class', () => {
    it('sequences async methods cleanly, gating an async @EnabledWhen pop()', async () => {
        @Contract()
        class AsyncStack {
            private items: number[] = [];
            async push(@Integer() x: number): Promise<void> {
                this.items.push(x);
            }
            @EnabledWhen((self: AsyncStack) => self.items.length > 0, 'non-empty')
            async pop(): Promise<number> {
                const v = this.items.pop();
                if (v === undefined) throw new Error('pop on empty');
                return v;
            }
        }
        const result = await fuzzSequenceAsync(AsyncStack, {
            subject: () => new AsyncStack(),
            numRuns: 150,
            maxSteps: 12,
        });
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
    });

    it('finds a rejection during an enabled async step', async () => {
        @Contract()
        class Rejecter {
            count = 0;
            async bump(@Between(1, 3) n: number): Promise<void> {
                this.count += n;
                if (this.count > 5) throw new Error('boom over five');
            }
        }
        const result = await fuzzSequenceAsync(Rejecter, {
            subject: () => new Rejecter(),
            numRuns: 200,
            maxSteps: 10,
        });
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toMatch(/unexpected-throw|contract-violation/);
    });

    it('declines a synchronous run on an async class, pointing at the async twin', () => {
        @Contract()
        class AsyncOnly {
            value = 0;
            async set(@Between(0, 9) n: number): Promise<void> {
                this.value = n;
            }
        }
        const result = fuzzSequence(AsyncOnly, {subject: () => new AsyncOnly(), numRuns: 50});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/async|thenable/i);
    });
});

describe('report — the boundary is always stated', () => {
    it('renders the command set, coverage, and a shrunk finding with a reproduce line', () => {
        @Contract()
        class Countdown {
            @Enforce.greaterThanEqual(0) remaining = 0; // any take overflows immediately — a guaranteed finding
            take(@Between(1, 3) n: number): void {
                this.remaining -= n;
            }
        }
        const result = fuzzSequence(Countdown, {subject: () => new Countdown(), numRuns: 100, maxSteps: 10});
        const report = formatSequenceReport(result, {basis: 'Countdown'});

        expect(report).toMatch(/stateful-sequence report/);
        expect(report).toMatch(/Scope: Countdown/);
        expect(report).toMatch(/take/);
        expect(result.passed).toBe(false);
        expect(report).toMatch(/FOUND/);
        expect(report).toMatch(/shrunk sequence/);
        expect(report).toMatch(/reproduce: seed/);
        // The standing "samples, not a proof" disclaimer is always present.
        expect(report).toMatch(/samples/i);
    });

    it('renders a clean run and a declined run without throwing', () => {
        @Contract()
        class Safe {
            @Enforce.greaterThanEqual(0) balance = 0;
            deposit(@Between(1, 5) n: number): void {
                this.balance += n; // only ever increases — always valid
            }
        }
        const clean = formatSequenceReport(
            fuzzSequence(Safe, {subject: () => new Safe(), numRuns: 100, maxSteps: 10}),
            {basis: 'Safe'},
        );
        expect(clean).toMatch(/clean/);
        expect(clean).toMatch(/invariants re-checked each step: balance/);

        const declined = formatSequenceReport(
            fuzzSequence(Safe, {subject: undefined as unknown as () => object}),
        );
        expect(declined).toMatch(/DECLINED/);
    });
});
