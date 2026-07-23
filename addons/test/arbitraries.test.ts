/**
 * Soundness of generation — the mirror of `schema.test.ts`'s under-claim tests.
 *
 * The governing invariant (foundation §4.1): a generator derived from a constraint produces **only**
 * values that constraint accepts. `schema.test.ts` proves each descriptor's `schema()` never rejects
 * a value its `predicate` accepts; this proves each descriptor's generated values are never rejected
 * by that same `predicate`. Both evaluate the descriptor's OWN predicate — the single source — so
 * neither can drift from enforcement (DEC-010).
 */

import * as fc from 'fast-check';
import {ConstraintDescriptor, defineConstraint} from '../../src/Core/Descriptor';
import * as Numbers from '../../src/Contracts/number';
import * as Strings from '../../src/Contracts/string';
import {arbitraryForConstraint, arbitraryForParameter} from './arbitraries';

const SAMPLES = 500;

/** Every generated value satisfies the descriptor's own predicate — soundness, asserted directly. */
function assertAllAccepted(arbitrary: fc.Arbitrary<unknown>, predicate: (v: unknown) => boolean): void {
    const values = fc.sample(arbitrary, {numRuns: SAMPLES, seed: 7});
    const rejected = values.filter(v => !predicate(v));
    expect(rejected).toEqual([]);
}

describe('parametric numeric generators are sound by construction', () => {
    const cases: Array<[string, ConstraintDescriptor]> = [
        ['min (GreaterThanEqual)', Numbers.GreaterThanEqual(5)],
        ['max (LessThanEqual)', Numbers.LessThanEqual(20)],
        ['greaterThan', Numbers.GreaterThan(0)],
        ['lessThan', Numbers.LessThan(100)],
        ['between', Numbers.Between(-10, 10)],
        ['integer', Numbers.Integer()],
        ['multipleOf (integer divisor)', Numbers.MultipleOf(3)],
        ['multipleOf (fractional divisor)', Numbers.MultipleOf(0.25)],
    ];

    for (const [label, descriptor] of cases) {
        it(`${label} generates only accepted values`, () => {
            const result = arbitraryForConstraint(descriptor);
            expect(result.strategy).toBe('parametric');
            expect(result.arbitrary).not.toBeNull();
            assertAllAccepted(result.arbitrary!, descriptor.predicate);
        });
    }

    it('never emits NaN or ±Infinity, which the numeric predicates reject (Q-7, noNaN/noDefaultInfinity)', () => {
        const result = arbitraryForConstraint(Numbers.GreaterThanEqual(0));
        const values = fc.sample(result.arbitrary!, {numRuns: SAMPLES, seed: 1}) as number[];
        expect(values.some(v => Number.isNaN(v) || !Number.isFinite(v))).toBe(false);
    });
});

describe('parametric string generators are sound by construction', () => {
    const cases: Array<[string, ConstraintDescriptor]> = [
        ['minLength', Strings.MinLength(4)],
        ['maxLength', Strings.MaxLength(6)],
        ['notEmpty', Strings.NotEmpty()],
    ];

    for (const [label, descriptor] of cases) {
        it(`${label} generates only accepted values`, () => {
            const result = arbitraryForConstraint(descriptor);
            expect(result.strategy).toBe('parametric');
            assertAllAccepted(result.arbitrary!, descriptor.predicate);
        });
    }
});

describe('matches delegates to fc.stringMatching (foundation §4.4)', () => {
    it('delegates for an invertible regex and generates only matching strings', () => {
        const descriptor = Strings.Matches(/^[a-z]{3,5}$/);
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('delegation');
        expect(result.note).toMatch(/stringMatching/);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });

    it('falls back to generate-and-filter (not delegation) when a flag makes the regex non-invertible', () => {
        // fast-check refuses `i` for stringMatching; the caveat is inherited honestly as a filter.
        const descriptor = Strings.Matches(/^[a-z]+$/i);
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('filter');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });
});

describe('email and url are curated, honest-but-partial sample sets (foundation §4.2)', () => {
    it('email is a finite curated set, every member accepted by the predicate', () => {
        const descriptor = Strings.Email();
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('curated');
        expect(result.note).toMatch(/curated/);
        const values = fc.sample(result.arbitrary!, {numRuns: SAMPLES, seed: 3});
        expect(values.every(descriptor.predicate)).toBe(true);
        // "Curated" means finite by design — not a pretence of RFC 5322 generality.
        expect(new Set(values).size).toBeLessThanOrEqual(10);
    });

    it('url is curated from the descriptor’s own accepted protocols', () => {
        const descriptor = Strings.Url(['https']);
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('curated');
        const values = fc.sample(result.arbitrary!, {numRuns: SAMPLES, seed: 3}) as string[];
        expect(values.every(descriptor.predicate)).toBe(true);
        expect(values.every(v => v.startsWith('https://'))).toBe(true);
    });
});

describe('an unrecognised constraint identity declines (the Q-3 floor)', () => {
    it('generates nothing for a hand-authored constraint this bridge does not know', () => {
        // The analogue of a hand-written predicate: a real descriptor whose identity is not in the map.
        const custom = defineConstraint({
            kind: 'generic',
            constraint: 'addon-test-unknown-identity',
            derive: () => (v: unknown) => typeof v === 'number' && v > 3,
            describe: () => 'a custom thing',
        });
        const descriptor = custom({});
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('declined');
        expect(result.arbitrary).toBeNull();
    });
});

describe('composition — stacked constraints are a conjunction (foundation §4.3)', () => {
    it('a combinable stack (min ∧ max ∧ integer) is an exact parametric merge, no filter', () => {
        const constraints = [Numbers.GreaterThanEqual(1), Numbers.LessThanEqual(100), Numbers.Integer()];
        const plan = arbitraryForParameter(constraints, 0, 'n');
        expect(plan.strategy).toBe('parametric');
        expect(plan.filtered).toBe(false);
        const predicate = (v: unknown) => constraints.every(c => c.predicate(v));
        assertAllAccepted(plan.arbitrary!, predicate);
    });

    it('a residual stack (between ∧ multipleOf) generates by filter, still sound, rate reported', () => {
        const constraints = [Numbers.Between(0, 100), Numbers.MultipleOf(5)];
        const plan = arbitraryForParameter(constraints, 0, 'step');
        expect(plan.strategy).toBe('filter');
        expect(plan.filtered).toBe(true);
        expect(typeof plan.acceptanceRate).toBe('number');
        const predicate = (v: unknown) => constraints.every(c => c.predicate(v));
        assertAllAccepted(plan.arbitrary!, predicate);
    });

    it('a contradictory stack (number ∧ string) declines rather than pretending', () => {
        const constraints = [Numbers.GreaterThanEqual(0), Strings.NotEmpty()];
        const plan = arbitraryForParameter(constraints, 0);
        expect(plan.declined).toBe(true);
        expect(plan.arbitrary).toBeNull();
    });
});

describe('filter starvation is surfaced, not hidden (foundation §7.2)', () => {
    it('flags a near-empty intersection as starving or declined instead of hanging', () => {
        // Very few multiples of a large prime fall in a modest range — the accepted set is a tiny slice.
        const constraints = [Numbers.Between(0, 1_000_000), Numbers.MultipleOf(999_983)];
        const plan = arbitraryForParameter(constraints, 0);
        expect(plan.starved || plan.declined).toBe(true);
    });
});

describe('zero constraints is a gap-fill position, not a decline', () => {
    it('reports gap-fill with no own arbitrary (the method composer supplies a broad one)', () => {
        const plan = arbitraryForParameter([], 2, 'note');
        expect(plan.strategy).toBe('gap-fill');
        expect(plan.arbitrary).toBeNull();
        expect(plan.declined).toBe(false);
    });
});
