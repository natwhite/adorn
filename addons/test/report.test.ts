/**
 * The boundary report (foundation §3, §7.2, §8) — the report-own-boundary discipline.
 *
 * A green fuzz result is the most over-readable artifact adorn produces, so a clean run must be
 * distinguishable from "never looked", and the report must state what it did and did not cover. These
 * tests hold it to that: covered vs declined, every strategy named, findings carrying their seed, and
 * the warn-vs-trust disclaimers always present.
 */

import * as fc from 'fast-check';
import {Contract} from '../../src/Core/ContractInstaller';
import {
    Between,
    Email,
    GreaterThanEqual,
    Integer,
    Matches,
    MultipleOf,
    NotEmpty,
} from '../../src/ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from '../../src/Core/ParameterDecoratorFactory';
import {resetConfiguration} from '../../src/Core/Configuration';
import {fuzzMethod} from './oracle';
import {formatFuzzReport} from './report';

beforeEach(() => {
    resetConfiguration();
});

describe('the report distinguishes covered from declined (§3)', () => {
    it('prints a clean covered method and a declined one as clearly different states', () => {
        @Contract()
        class Service {
            handle(@GreaterThanEqual(0) n: number): number {
                return n;
            }
        }

        const covered = fuzzMethod({target: Service, method: 'handle', subject: () => new Service()});
        const declined = fuzzMethod({
            target: Service,
            method: 'ghost' as never,
            subject: () => new Service(),
        });
        const report = formatFuzzReport([covered, declined], {basis: 'Service'});

        expect(report).toMatch(/Scope: Service/);
        expect(report).toMatch(/Fuzzed 1 method\(s\); declined 1; findings 0/);
        expect(report).toMatch(/Service\.handle: clean/);
        expect(report).toMatch(/DECLINED — no contract recorded/);
    });

    it('an empty batch says "nothing was pointed at the fuzzer", not "no bugs"', () => {
        const report = formatFuzzReport([]);
        expect(report).toMatch(/Fuzzed 0 methods/);
        expect(report).toMatch(/NOT "no bugs"/);
    });
});

describe('every generation strategy is named in the coverage block (§8)', () => {
    it('names parametric, curated, delegation, and a gap-filled closure position', () => {
        // A hand-written closure never reaches the registry (SMELL-14), so its position is
        // indistinguishable from an undecorated one — the report says exactly that.
        const NoBlanks = ParameterDecoratorFactory.CreateSimpleDecorator<string>(params => {
            if (typeof params.value === 'string' && params.value.trim() === '') {
                throw new Error('Value Error: must not be blank');
            }
        });

        @Contract()
        class Profile {
            update(
                @NoBlanks handle: string,
                @Email() email: string,
                @Matches(/^[a-z]{2,4}$/) code: string,
                @GreaterThanEqual(0) age: number,
            ): void {
                void handle;
                void email;
                void code;
                void age;
            }
        }

        const result = fuzzMethod({
            target: Profile,
            method: 'update',
            subject: () => new Profile(),
            gapFill: fc.constant('safe'),
            numRuns: 40,
        });
        const report = formatFuzzReport(result);

        expect(result.coverage.map(c => c.strategy)).toEqual([
            'gap-fill',
            'curated',
            'delegation',
            'parametric',
        ]);
        expect(report).toMatch(/parametric \(sound by construction\)/);
        expect(report).toMatch(/curated sample set/);
        expect(report).toMatch(/delegation → fc\.stringMatching/);
        // The Q-3 closure floor, named at the position rather than pretended covered.
        expect(report).toMatch(/gap-filled with a broad arbitrary/);
        expect(report).toMatch(/hand-written closure invisible to the registry/);
    });
});

describe('a finding is reported with its reproducible seed and counterexample (§7.1)', () => {
    it('prints FOUND, the counterexample, and a reproduce-with-seed line', () => {
        @Contract()
        class Crasher {
            boom(@NotEmpty() text: string): void {
                if (text.length > 2) throw new Error('kaboom');
            }
        }

        const result = fuzzMethod({
            target: Crasher,
            method: 'boom',
            subject: () => new Crasher(),
            numRuns: 200,
        });
        const report = formatFuzzReport(result);

        expect(report).toMatch(/Crasher\.boom: FOUND \(unexpected-throw\)/);
        expect(report).toMatch(/counterexample: \[/);
        // fast-check seeds may be negative.
        expect(report).toMatch(/reproduce: seed -?\d+/);
    });
});

describe('warnings — the things a developer cannot see (§7.2)', () => {
    it('always carries the side-effects and "fuzzed ≠ proved" disclaimers', () => {
        @Contract()
        class Ok {
            ping(@Between(0, 10) n: number): number {
                return n;
            }
        }
        const result = fuzzMethod({target: Ok, method: 'ping', subject: () => new Ok()});
        const report = formatFuzzReport(result);

        expect(report).toMatch(/runs the REAL method/);
        expect(report).toMatch(/does not verify/);
    });

    it('surfaces filter starvation on a running method (the filter_too_much analogue)', () => {
        @Contract()
        class Stepper {
            // Integer multiples of 7 in [0, 1000] are a ~16% slice of the integer base — sound to
            // generate by filter, but a run "covers" far fewer distinct values than its case count.
            step(@Integer() @Between(0, 1000) @MultipleOf(7) size: number): number {
                return size;
            }
        }

        const result = fuzzMethod({
            target: Stepper,
            method: 'step',
            subject: () => new Stepper(),
            numRuns: 40,
        });
        const report = formatFuzzReport(result);

        expect(result.coverage[0].strategy).toBe('filter');
        expect(result.coverage[0].starved).toBe(true);
        expect(report).toMatch(/STARVING/);
        expect(report).toMatch(/generate-and-filter accepts only/);
    });

    it('reports a method declined by starvation with the reason, not a hang', () => {
        @Contract()
        class Narrow {
            // There is no multiple of 7 in [1, 6] at all, so the filter accepts none of its samples
            // and the method is declined with a stated reason rather than hanging.
            pick(@Between(1, 6) @MultipleOf(7) value: number): number {
                return value;
            }
        }

        const result = fuzzMethod({target: Narrow, method: 'pick', subject: () => new Narrow()});
        const report = formatFuzzReport(result);

        expect(result.declined).toBe(true);
        expect(report).toMatch(/DECLINED —/);
        expect(report).toMatch(/could not be generated/);
    });
});
