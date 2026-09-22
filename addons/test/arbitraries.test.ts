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
import * as Enums from '../../src/Contracts/enum';
import * as Arrays from '../../src/Contracts/array';
import {Nullable} from '../../src/Contracts/nullable';
import {Dictionary, Fields, shapeConstraint} from '../../src/Contracts/object';
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

    it('a bare bound carries a float-domain note so an integer domain knows to stack Integer() (L21)', () => {
        // `Between(0, 1439)` (minutes) is a *float* contract: `fc.double` samples denormals and fractions,
        // sound but almost never the integers the author likely meant. The note is the honest signal — the
        // one thing that told the consumer nothing before. Integer() itself carries no such note.
        for (const bound of [Numbers.Between(0, 1439), Numbers.GreaterThanEqual(0), Numbers.LessThan(100)]) {
            expect(arbitraryForConstraint(bound).note).toMatch(/float domain/);
        }
        expect(arbitraryForConstraint(Numbers.Integer()).note).toBeUndefined();
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

describe('oneOf generates only members (DEC-031 ideal case — no filter, no starvation)', () => {
    it('is parametric via fc.constantFrom, and every generated value is an accepted member', () => {
        const descriptor = Enums.OneOf(['celsius', 'fahrenheit']);
        const result = arbitraryForConstraint(descriptor);

        expect(result.strategy).toBe('parametric');
        expect(result.note).toMatch(/constantFrom/);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });

    it('draws only from the exact member set, whatever the member types', () => {
        const descriptor = Enums.OneOf(['x', 2, true, null]);
        const values = fc.sample(arbitraryForConstraint(descriptor).arbitrary!, {numRuns: SAMPLES, seed: 5});

        // Every sample is one of the four declared members — nothing else is ever produced.
        expect(values.every(value => ['x', 2, true, null].some(member => member === value))).toBe(true);
    });
});

describe('arrayOf recurses through the item arbitrary (DEC-050 — sound by construction)', () => {
    it('an array of a generatable item generates only valid arrays', () => {
        const descriptor = Arrays.ArrayOf(Numbers.GreaterThanEqual(0), {minItems: 1, maxItems: 5});
        const result = arbitraryForConstraint(descriptor);

        expect(result.strategy).toBe('parametric');
        expect(result.note).toMatch(/fc\.array/);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });

    it('respects the length bounds it was given', () => {
        const descriptor = Arrays.ArrayOf(Strings.NotEmpty(), {minItems: 2, maxItems: 4});
        const values = fc.sample(arbitraryForConstraint(descriptor).arbitrary!, {
            numRuns: SAMPLES,
            seed: 9,
        }) as unknown[][];

        expect(values.every(a => Array.isArray(a) && a.length >= 2 && a.length <= 4)).toBe(true);
    });

    it('nests: an array of an array of an enum generates only valid nested arrays', () => {
        const descriptor = Arrays.ArrayOf(Arrays.ArrayOf(Enums.OneOf(['a', 'b'])));
        const result = arbitraryForConstraint(descriptor);

        expect(result.strategy).toBe('parametric');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });

    it('declines when the item declines and a non-empty array is required', () => {
        const declining = defineConstraint({
            kind: 'generic',
            constraint: 'addon-test-arrayof-declining-item',
            derive: () => (v: unknown) => typeof v === 'bigint',
            describe: () => 'a bigint',
        });
        const result = arbitraryForConstraint(Arrays.ArrayOf(declining({}), {minItems: 1}));

        expect(result.strategy).toBe('declined');
        expect(result.arbitrary).toBeNull();
    });

    it('offers only the empty array when the item declines but the empty array is admissible', () => {
        const declining = defineConstraint({
            kind: 'generic',
            constraint: 'addon-test-arrayof-declining-item-empty-ok',
            derive: () => (v: unknown) => typeof v === 'bigint',
            describe: () => 'a bigint',
        });
        const descriptor = Arrays.ArrayOf(declining({})); // no minItems ⇒ [] admissible
        const result = arbitraryForConstraint(descriptor);

        expect(result.strategy).toBe('parametric');
        expect(result.note).toMatch(/empty array/);
        const values = fc.sample(result.arbitrary!, {numRuns: 20, seed: 1});
        expect(values.every(v => Array.isArray(v) && (v as unknown[]).length === 0)).toBe(true);
        // Still sound: the descriptor's own predicate accepts every generated (empty) array.
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
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

describe('a stacked pattern filters from its own targeted base, not a broad one (voice-agent L20)', () => {
    // "HH:MM", 24-hour — anchored, so `fc.stringMatching` produces exactly a five-char time string.
    const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

    // Each case pairs a pattern with a second constraint the merged bounds base *could* express. Before
    // the fix, `mergedBase` built a broad `fc.string` base (the pattern demoted to a filter), the
    // conjunction accepted ~none of it, and the position starved into a decline. The targeted
    // `stringMatching(TIME)` base the pattern already carries is the right thing to filter from.
    const cases: Array<[string, ConstraintDescriptor[]]> = [
        ['NotEmpty ∧ Matches(TIME)', [Strings.NotEmpty(), Strings.Matches(TIME)]],
        ['Matches(TIME) ∧ NotEmpty  (order-independent)', [Strings.Matches(TIME), Strings.NotEmpty()]],
        ['MaxLength(5) ∧ Matches(TIME)', [Strings.MaxLength(5), Strings.Matches(TIME)]],
        ['Matches(TIME) ∧ Matches(/:/)  (narrower pattern wins)', [Strings.Matches(TIME), Strings.Matches(/:/)]],
    ];

    for (const [label, constraints] of cases) {
        it(`${label} generates times instead of declining`, () => {
            const plan = arbitraryForParameter(constraints, 0, 'at');
            expect(plan.declined).toBe(false);
            expect(plan.starved).toBe(false);
            expect(plan.arbitrary).not.toBeNull();

            const predicate = (v: unknown) => constraints.every(c => c.predicate(v));
            assertAllAccepted(plan.arbitrary!, predicate);

            // The values are real times, not merely "sound" — the base is the pattern, not a filter.
            const values = fc.sample(plan.arbitrary!, {numRuns: 50, seed: 3}) as string[];
            expect(values.every(v => TIME.test(v))).toBe(true);
        });
    }

    it('reports the pattern base honestly — delegation with no effective filter (acceptance 1)', () => {
        const plan = arbitraryForParameter([Strings.NotEmpty(), Strings.Matches(TIME)], 0);
        expect(plan.strategy).toBe('delegation');
        expect(plan.filtered).toBe(false);
    });

    it('a genuinely contradictory pattern stack still declines (soundness before coverage)', () => {
        // A four-digit string can never be at most two characters — no base can generate the intersection.
        const constraints = [Strings.Matches(/^\d{4}$/), Strings.MaxLength(2)];
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

// ---------------------------------------------------------------------------
// Object / composite generation — completing arbitraryForConstraint's `default`
// ---------------------------------------------------------------------------

/** A descriptor whose only accepted value is a bigint — nothing this bridge generates, so it declines. */
const bigintOnly = (id: string): ConstraintDescriptor =>
    defineConstraint({
        kind: 'generic',
        constraint: id,
        derive: () => (v: unknown) => typeof v === 'bigint',
        describe: () => 'a bigint',
    })({});

describe('const generates exactly the single literal (DEC-056)', () => {
    it('is parametric via fc.constant and produces only that value', () => {
        const descriptor = Enums.Const(42);
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('parametric');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 20, seed: 1});
        expect(values.every(v => v === 42)).toBe(true);
    });
});

describe('string-format delegations are sound (uuid, date-time, ipv4)', () => {
    const cases: Array<[string, ConstraintDescriptor]> = [
        ['uuid', Strings.Uuid()],
        ['date-time', Strings.DateTime()],
        ['ipv4', Strings.Ipv4()],
    ];
    for (const [label, descriptor] of cases) {
        it(`${label} delegates to fast-check and generates only accepted values`, () => {
            const result = arbitraryForConstraint(descriptor);
            expect(result.strategy).toBe('delegation');
            expect(result.arbitrary).not.toBeNull();
            assertAllAccepted(result.arbitrary!, descriptor.predicate);
        });
    }
});

describe('nullable widens the item generator to also emit null (DEC-056)', () => {
    it('generates both null and valid item values, all accepted', () => {
        const descriptor = Nullable(Numbers.GreaterThanEqual(0));
        const result = arbitraryForConstraint(descriptor);
        expect(result.arbitrary).not.toBeNull();
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: SAMPLES, seed: 4});
        expect(values.some(v => v === null)).toBe(true);
        expect(values.some(v => typeof v === 'number')).toBe(true);
    });

    it('falls back to only null when the item declines', () => {
        const descriptor = Nullable(bigintOnly('addon-test-og-nullable-item'));
        const result = arbitraryForConstraint(descriptor);
        expect(result.note).toMatch(/only null/);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 20, seed: 1});
        expect(values.every(v => v === null)).toBe(true);
    });
});

describe('dictionary recurses through the value generator (open Record<string, V>)', () => {
    it('generates only valid maps of the value constraint', () => {
        const descriptor = Dictionary(Strings.NotEmpty());
        const result = arbitraryForConstraint(descriptor);
        expect(result.arbitrary).not.toBeNull();
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });

    it('falls back to the empty map when the value declines', () => {
        const descriptor = Dictionary(bigintOnly('addon-test-og-dict-value'));
        const result = arbitraryForConstraint(descriptor);
        expect(result.note).toMatch(/empty map/);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
    });
});

describe('shape generates a closed object over its fields (DEC-055)', () => {
    it('generates objects with every contracted field present and valid', () => {
        const descriptor = shapeConstraint({
            fields: {
                name: [Strings.NotEmpty().toJSON()],
                age: [Numbers.GreaterThanEqual(0).toJSON(), Numbers.Integer().toJSON()],
            },
        });
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('parametric');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 50, seed: 2}) as Array<Record<string, unknown>>;
        expect(values.every(o => typeof o.name === 'string' && typeof o.age === 'number')).toBe(true);
    });

    it('routes a stacked field through the parameter composer — no DEC-082 starvation inside a shape', () => {
        const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
        const descriptor = shapeConstraint({
            fields: {at: [Strings.NotEmpty().toJSON(), Strings.Matches(TIME).toJSON()]},
        });
        const result = arbitraryForConstraint(descriptor);
        expect(result.arbitrary).not.toBeNull();
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 30, seed: 6}) as Array<{at: string}>;
        expect(values.every(o => TIME.test(o.at))).toBe(true);
    });

    it('declines the whole shape when a required field cannot be generated', () => {
        const descriptor = shapeConstraint({
            fields: {ok: [Strings.NotEmpty().toJSON()], bad: [bigintOnly('addon-test-og-shape-field').toJSON()]},
        });
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('declined');
        expect(result.arbitrary).toBeNull();
        expect(result.note).toMatch(/'bad'/);
    });
});

describe('fields generates an optional-aware object literal (DEC-065)', () => {
    it('always includes required fields, valid throughout', () => {
        const descriptor = Fields({id: Numbers.GreaterThanEqual(1), label: Strings.NotEmpty()});
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('parametric');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 50, seed: 2}) as Array<Record<string, unknown>>;
        expect(values.every(o => typeof o.id === 'number' && typeof o.label === 'string')).toBe(true);
    });

    it('sometimes omits an optional field; required fields are always present; all accepted', () => {
        const descriptor = Fields({
            id: Numbers.GreaterThanEqual(1),
            note: {descriptor: Strings.NotEmpty(), optional: true},
        });
        const result = arbitraryForConstraint(descriptor);
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: SAMPLES, seed: 8}) as Array<Record<string, unknown>>;
        expect(values.every(o => 'id' in o)).toBe(true);
        expect(values.some(o => !('note' in o))).toBe(true);
    });

    it('declines on an ungeneratable REQUIRED field, but drops an ungeneratable OPTIONAL one', () => {
        expect(arbitraryForConstraint(Fields({bad: bigintOnly('addon-test-og-fields-req')})).strategy).toBe('declined');

        const descriptor = Fields({
            ok: Strings.NotEmpty(),
            bad: {descriptor: bigintOnly('addon-test-og-fields-opt'), optional: true},
        });
        const result = arbitraryForConstraint(descriptor);
        expect(result.strategy).toBe('parametric');
        assertAllAccepted(result.arbitrary!, descriptor.predicate);
        const values = fc.sample(result.arbitrary!, {numRuns: 30, seed: 3}) as Array<Record<string, unknown>>;
        expect(values.every(o => !('bad' in o))).toBe(true);
    });
});

describe('composite nesting is bounded — deep nesting declines, never hangs', () => {
    it('a shape nested past the depth bound declines cleanly instead of recursing without end', () => {
        let d: ConstraintDescriptor = shapeConstraint({fields: {leaf: [Numbers.GreaterThanEqual(0).toJSON()]}});
        for (let i = 0; i < 10; i++) {
            d = shapeConstraint({fields: {nested: [d.toJSON()]}});
        }
        const result = arbitraryForConstraint(d);
        expect(result.strategy).toBe('declined');
        expect(result.arbitrary).toBeNull();
    });

    it('a shape within the depth bound still generates soundly', () => {
        const inner = shapeConstraint({fields: {v: [Numbers.Integer().toJSON()]}});
        const middle = shapeConstraint({fields: {inner: [inner.toJSON()]}});
        const outer = shapeConstraint({fields: {middle: [middle.toJSON()]}});
        const result = arbitraryForConstraint(outer);
        expect(result.arbitrary).not.toBeNull();
        assertAllAccepted(result.arbitrary!, outer.predicate);
    });
});
