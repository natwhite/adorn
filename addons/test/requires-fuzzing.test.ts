/**
 * `@Requires` cross-parameter preconditions in the fuzzer (DEC-057 fuzzer integration).
 *
 * The fuzzer filters its generated argument tuples through `evaluatePreconditions(getEffectivePreconditions
 * (...))` — the EXACT read + oracle enforcement runs — so it tests a method only on tuples the installed
 * `@Requires` guard accepts. That closes the false positive DEC-057 deferred: before, a per-position-valid
 * tuple that violates a cross-parameter precondition hit the live guard's `"Precondition failed: …"` throw,
 * which `isAdornViolation` (only the `"Value Error:"` prefix) misclassified as an `unexpected-throw`.
 *
 * Classes are declared INSIDE each test (SMELL-18) and `resetConfiguration()` restores default
 * throw-on-violation enforcement that the no-drift pin relies on.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {Between} from '../../src/ParameterDecorators/Constraints';
import {Requires} from '../../src/MethodDecorators/Requires';
import {Ensures} from '../../src/MethodDecorators/Ensures';
import {resetConfiguration} from '../../src/Core/Configuration';
import {evaluatePreconditions, getEffectivePreconditions} from '../../index';
import {fuzzMethod, fuzzMethodAsync} from './oracle';

beforeEach(resetConfiguration);

describe('@Requires fuzzing (DEC-057) — the mixed case closes the false positive', () => {
    it('a @Requires method fuzzes with NO false positive', () => {
        @Contract()
        class Range {
            @Requires((start: number, end: number) => start < end, 'start before end')
            span(@Between(0, 10) start: number, @Between(0, 10) end: number): number {
                return end - start;
            }
        }
        const result = fuzzMethod({target: Range, method: 'span', subject: () => new Range(), numRuns: 200});
        // Before the fix, ~half the drawn tuples had start >= end and tripped the live precondition guard,
        // misclassified as an unexpected-throw. The filter now admits only start < end tuples → clean.
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.finding).toBeUndefined();
    });

    it('a method with no @Requires is unaffected — zero overhead, no precondition warning', () => {
        @Contract()
        class Plain {
            add(@Between(0, 10) a: number, @Between(0, 10) b: number): number {
                return a + b;
            }
        }
        const result = fuzzMethod({target: Plain, method: 'add', subject: () => new Plain(), numRuns: 100});
        expect(result.passed).toBe(true);
        expect(result.warnings.some(w => /@Requires/.test(w))).toBe(false);
    });
});

describe('@Requires fuzzing — starvation is surfaced, never a silent pass', () => {
    it('an unsatisfiable-over-the-domain precondition DECLINES honestly (0% acceptance)', () => {
        @Contract()
        class Never {
            @Requires(() => false, 'impossible')
            run(@Between(0, 10) n: number): number {
                return n;
            }
        }
        const result = fuzzMethod({target: Never, method: 'run', subject: () => new Never()});
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/precondition/i);
        expect(result.reason).toMatch(/impossible/);
        expect(result.passed).toBe(false);
    });

    it('a narrow-but-nonzero precondition surfaces a starvation WARNING, not a clean silent pass', () => {
        @Contract()
        class Narrow {
            // `a > 8` over [0,10] accepts ~20% of tuples — below STARVATION_THRESHOLD (25%), above 0%.
            @Requires((a: number) => a > 8, 'a exceeds 8')
            pick(@Between(0, 10) a: number, @Between(0, 10) b: number): number {
                return a + b;
            }
        }
        const result = fuzzMethod({target: Narrow, method: 'pick', subject: () => new Narrow(), numRuns: 50});
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.warnings.some(w => /@Requires generate-and-filter/.test(w))).toBe(true);
    });
});

describe('@Requires fuzzing — inheritance, layering, async', () => {
    it('an inherited @Requires is respected when fuzzing a subclass override (DEC-022 union)', () => {
        @Contract()
        class Base {
            @Requires((start: number, end: number) => start < end, 'start before end')
            span(@Between(0, 10) start: number, @Between(0, 10) end: number): number {
                return end - start;
            }
        }
        @Contract()
        class Sub extends Base {
            span(start: number, end: number): number {
                return (end - start) * 2; // pure override — inherits Base's params AND @Requires
            }
        }
        const result = fuzzMethod({target: Sub, method: 'span', subject: () => new Sub(), numRuns: 200});
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true); // no false positive ⇒ the inherited precondition filtered the tuples
    });

    it('@Requires + @Ensures: filters by the precondition AND still catches a postcondition break', () => {
        @Contract()
        class Ledger {
            @Requires((lo: number, hi: number) => lo < hi, 'lo < hi')
            @Ensures((result: unknown) => (result as number) >= 0, 'non-negative span')
            span(@Between(0, 100) lo: number, @Between(0, 100) hi: number): number {
                return lo - hi; // @Requires guarantees lo < hi, so lo - hi is NEGATIVE → breaks @Ensures
            }
        }
        const result = fuzzMethod({target: Ledger, method: 'span', subject: () => new Ledger(), numRuns: 300});
        // The filter admits only lo < hi tuples; on those the postcondition breaks — proving the filter did
        // not suppress the postcondition oracle (layering, not replacement).
        expect(result.passed).toBe(false);
        expect(result.finding!.type).toBe('postcondition-violation');
    });

    it('async: fuzzMethodAsync on a @Requires async method fuzzes with no false positive', async () => {
        @Contract()
        class AsyncRange {
            @Requires((start: number, end: number) => start < end, 'start before end')
            async span(@Between(0, 10) start: number, @Between(0, 10) end: number): Promise<number> {
                return end - start;
            }
        }
        const result = await fuzzMethodAsync({
            target: AsyncRange,
            method: 'span',
            subject: () => new AsyncRange(),
            numRuns: 200,
        });
        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);
    });
});

describe('@Requires fuzzing — no-drift and the finding-F decline message', () => {
    it('no-drift: EVERY tuple the method receives satisfies the effective precondition', () => {
        const seen: Array<[number, number]> = [];
        @Contract()
        class Booking {
            @Requires((start: number, end: number) => start < end, 'start before end')
            reserve(@Between(0, 100) start: number, @Between(0, 100) end: number): [number, number] {
                seen.push([start, end]);
                return [start, end];
            }
        }
        const result = fuzzMethod({
            target: Booking,
            method: 'reserve',
            subject: () => new Booking(),
            numRuns: 300,
        });
        expect(result.declined).toBe(false);

        const pres = getEffectivePreconditions(Booking.prototype, 'reserve');
        expect(seen.length).toBeGreaterThan(0);
        // filter-admits(x) ⟺ enforcement-accepts(x): every run tuple is precondition-valid...
        for (const args of seen) {
            expect(evaluatePreconditions(pres, args).ok).toBe(true);
        }
        // ...and a hand-picked violating tuple both fails the filter predicate AND throws under enforcement.
        expect(evaluatePreconditions(pres, [9, 2]).ok).toBe(false);
        expect(() => new Booking().reserve(9, 2)).toThrow(/Precondition failed/);
    });

    it('a @Requires-ONLY method declines with an accurate reason, not "no contract recorded" (finding F)', () => {
        @Contract()
        class OnlyRequires {
            @Requires((start: number, end: number) => start < end, 'start before end')
            reserve(start: number, end: number): [number, number] {
                return [start, end];
            }
        }
        const result = fuzzMethod({
            target: OnlyRequires,
            method: 'reserve',
            subject: () => new OnlyRequires(),
        });
        expect(result.declined).toBe(true);
        expect(result.reason).toMatch(/@Requires/);
        expect(result.reason).not.toMatch(/no contract recorded/);
    });
});
