import {constraintFromJSON, ConstraintDescriptor} from '../Core/Descriptor';
import {GreaterThanEqual, LessThanEqual, Positive} from './number';
import {MinLength, StringMinLength} from './string';

/**
 * Parity fixtures: the exact strings the closures in `src/ParameterDecorators/Constraints.ts`
 * throw today. If a port changed a message, these fail — which is the point. Message rework is
 * P3.1's job, not a side effect of reifying the constraints.
 */
const SIGNATURE = "Task.test(message, count) parameter 'count'";

const legacy = {
    positive: (value: number) =>
        `Value Error: ${SIGNATURE} expected a positive number but received ${value} instead`,
    lessThanEqual: (constraint: number, value: number) =>
        `Value Error: ${SIGNATURE} expected a number less than or equal to ${constraint} but received ${value} instead`,
    greaterThanEqual: (constraint: number, value: number) =>
        `Value Error: ${SIGNATURE} expected a number greater than or equal to ${constraint} but received ${value} instead`,
    stringMinLength: (constraint: number, value: string) =>
        `Value Error: ${SIGNATURE} expected a string of length greater than ${constraint} but received '${value}' instead`,
};

const messageFor = (descriptor: ConstraintDescriptor, value: unknown) =>
    descriptor.message({value, signature: SIGNATURE});

describe('Positive', () => {
    const descriptor = Positive();

    it('is reified as an inclusive lower bound of zero', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('positive');
        expect(descriptor.params).toEqual({min: 0});
    });

    it('rejects only values below zero', () => {
        expect(descriptor.predicate(-1)).toBe(false);
        expect(descriptor.predicate(-0.0001)).toBe(false);
        expect(descriptor.predicate(1)).toBe(true);
        expect(descriptor.predicate(1e9)).toBe(true);
    });

    it('accepts 0 — semantics preserved verbatim, ISSUES.md Q-1', () => {
        // "Positive" strictly means > 0, but the original rejects only `value < 0`. Settling this
        // is a behavioural break that must land across Positive, Verify.positive, and a future
        // Negative together. Pinned here so the change is deliberate and visible.
        expect(descriptor.predicate(0)).toBe(true);
        expect(descriptor.predicate(-0)).toBe(true);
    });

    it('accepts NaN — also preserved verbatim, and also wrong', () => {
        // Every comparison with NaN is false, so `if (value < 0) throw` never fires for NaN. The
        // derivation is written `!(value < min)` rather than `value >= min` precisely so this is
        // not silently changed under cover of a refactor. The type guards in P3.3 should settle it.
        expect(descriptor.predicate(NaN)).toBe(true);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(descriptor, -5)).toBe(legacy.positive(-5));
    });

    it('describes itself for documentation without a value in hand', () => {
        expect(descriptor.describe()).toBe('a positive number');
    });
});

describe('GreaterThanEqual', () => {
    it('is reified as an inclusive minimum', () => {
        const descriptor = GreaterThanEqual(5);

        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('min');
        expect(descriptor.params).toEqual({min: 5});
    });

    it('is inclusive at the boundary', () => {
        const descriptor = GreaterThanEqual(5);

        expect(descriptor.predicate(4)).toBe(false);
        expect(descriptor.predicate(5)).toBe(true);
        expect(descriptor.predicate(6)).toBe(true);
    });

    it('handles negative and fractional bounds', () => {
        expect(GreaterThanEqual(-10).predicate(-11)).toBe(false);
        expect(GreaterThanEqual(-10).predicate(-10)).toBe(true);
        expect(GreaterThanEqual(0.5).predicate(0.4)).toBe(false);
        expect(GreaterThanEqual(0.5).predicate(0.5)).toBe(true);
    });

    it('accepts NaN — preserved verbatim', () => {
        expect(GreaterThanEqual(5).predicate(NaN)).toBe(true);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(GreaterThanEqual(5), 2)).toBe(legacy.greaterThanEqual(5, 2));
    });

    it('agrees with Positive at min 0 — one derivation, two identities', () => {
        const asMin = GreaterThanEqual(0);
        const asPositive = Positive();

        [-2, -1, -0, 0, 1, 2].forEach(value => {
            expect(asMin.predicate(value)).toBe(asPositive.predicate(value));
        });
        expect(asMin.params).toEqual(asPositive.params);
    });
});

describe('LessThanEqual', () => {
    it('is reified as an inclusive maximum', () => {
        const descriptor = LessThanEqual(5);

        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('max');
        expect(descriptor.params).toEqual({max: 5});
    });

    it('is inclusive at the boundary', () => {
        const descriptor = LessThanEqual(5);

        expect(descriptor.predicate(6)).toBe(false);
        expect(descriptor.predicate(5)).toBe(true);
        expect(descriptor.predicate(4)).toBe(true);
    });

    it('accepts NaN — preserved verbatim', () => {
        expect(LessThanEqual(5).predicate(NaN)).toBe(true);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(LessThanEqual(5), 9)).toBe(legacy.lessThanEqual(5, 9));
    });
});

describe('MinLength (ports StringMinLength)', () => {
    it('is exported under the legacy name too', () => {
        expect(StringMinLength).toBe(MinLength);
    });

    it('is reified as an inclusive minimum length', () => {
        const descriptor = MinLength(3);

        expect(descriptor.kind).toBe('string');
        expect(descriptor.constraint).toBe('minLength');
        expect(descriptor.params).toEqual({minLength: 3});
    });

    it('is inclusive at the boundary', () => {
        const descriptor = MinLength(3);

        expect(descriptor.predicate('ab')).toBe(false);
        expect(descriptor.predicate('abc')).toBe(true);
        expect(descriptor.predicate('abcd')).toBe(true);
    });

    it('accepts any string when minLength is 0', () => {
        expect(MinLength(0).predicate('')).toBe(true);
    });

    it('throws a TypeError on null — preserved verbatim, ISSUES.md BUG-4', () => {
        // The original dereferences `params.value.length` with no guard, so a null argument
        // produces a bare TypeError rather than a contract violation. P3.3 adds null/type guards
        // uniformly across the whole set; until then a predicate is not total, which matters for
        // any projection that evaluates it.
        const descriptor = MinLength(3);

        expect(() => descriptor.predicate(null)).toThrow(TypeError);
        expect(() => descriptor.predicate(undefined)).toThrow(TypeError);
    });

    it('reproduces the original message exactly, quoting the received value', () => {
        expect(messageFor(MinLength(3), 'ab')).toBe(legacy.stringMinLength(3, 'ab'));
    });
});

describe('projection readiness', () => {
    const all: ConstraintDescriptor[] = [
        Positive(),
        GreaterThanEqual(5),
        LessThanEqual(10),
        MinLength(3),
    ];

    it('exposes identity and params as plain JSON for every built-in', () => {
        all.forEach(descriptor => {
            expect(JSON.parse(JSON.stringify(descriptor))).toEqual({
                kind: descriptor.kind,
                constraint: descriptor.constraint,
                params: descriptor.params,
            });
        });
    });

    it('rehydrates every built-in into an identically-enforcing descriptor', () => {
        const probes = [-10, -1, 0, 1, 3, 5, 9, 10, 11];

        all.forEach(descriptor => {
            const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

            expect(revived.describe()).toBe(descriptor.describe());
            probes.forEach(probe => {
                const value: unknown = descriptor.kind === 'string' ? 'x'.repeat(Math.max(probe, 0)) : probe;
                expect(revived.predicate(value)).toBe(descriptor.predicate(value));
            });
        });
    });

    it('supplies no arbitrary yet — the shape exists, generators do not', () => {
        // P1.0 designs the hook; it does not implement generators. `arbitrary` is absent rather
        // than undefined so `'arbitrary' in descriptor` is an honest answer to "can this be fuzzed?".
        all.forEach(descriptor => {
            expect('arbitrary' in descriptor).toBe(false);
            expect('schema' in descriptor).toBe(false);
        });
    });

    it('is enough on its own to render a documentation line', () => {
        const lines = all.map(descriptor => `${descriptor.constraint}: expects ${descriptor.describe()}`);

        expect(lines).toEqual([
            'positive: expects a positive number',
            'min: expects a number greater than or equal to 5',
            'max: expects a number less than or equal to 10',
            'minLength: expects a string of length greater than 3',
        ]);
    });
});

describe('no drift between params and predicate (ISSUES.md Q-4)', () => {
    it('makes the enforced boundary follow params for every numeric built-in', () => {
        for (let bound = -5; bound <= 5; bound++) {
            const atLeast = GreaterThanEqual(bound);
            expect(atLeast.params.min).toBe(bound);
            expect(atLeast.predicate(bound)).toBe(true);
            expect(atLeast.predicate(bound - 1)).toBe(false);

            const atMost = LessThanEqual(bound);
            expect(atMost.params.max).toBe(bound);
            expect(atMost.predicate(bound)).toBe(true);
            expect(atMost.predicate(bound + 1)).toBe(false);
        }
    });

    it('makes the enforced length follow params', () => {
        for (let bound = 0; bound <= 5; bound++) {
            const descriptor = MinLength(bound);
            expect(descriptor.params.minLength).toBe(bound);
            expect(descriptor.predicate('x'.repeat(bound))).toBe(true);
            if (bound > 0) expect(descriptor.predicate('x'.repeat(bound - 1))).toBe(false);
        }
    });
});
