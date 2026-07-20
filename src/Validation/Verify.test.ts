/**
 * `Verify` — the imperative assertion surface (SMELL-8).
 *
 * The tests that matter here are the *parity* ones. `Verify` used to hand-write the same boundaries
 * `src/Contracts/` defines, which is the descriptor/predicate drift Q-4 calls the worst failure mode
 * the "contracts as the single source of truth" goal introduces. Now every check delegates to the
 * descriptor its decorator counterpart uses, and the parity suite is what holds it there: if someone
 * reintroduces a comparison in `Verify.ts`, these fail.
 */

import {Verify} from './Verify';
import {
    Between,
    GreaterThanEqual,
    LessThanEqual,
    NonNegative,
    Positive,
} from '../Contracts/number';
import {Email, NotEmpty} from '../Contracts/string';

describe('Verify.that — the general form', () => {
    it('returns the value when the constraint is satisfied', () => {
        expect(Verify.that(Between(1, 10), 'retries', 5)).toBe(5);
        expect(Verify.that(NotEmpty(), 'name', 'ada')).toBe('ada');
    });

    it('throws with the descriptor message when it is not', () => {
        expect(() => Verify.that(Between(1, 10), 'retries', 42))
            .toThrow('Value Error: retries expected a number between 1 and 10 (inclusive) but received 42 instead');
    });

    it('works for any descriptor, so Verify never needs a method per constraint', () => {
        expect(() => Verify.that(Email(), 'contact', 'nope')).toThrow(/expected an email address/i);
        expect(Verify.that(Email(), 'contact', 'a@b.co')).toBe('a@b.co');
    });

    it('accepts a symbol key', () => {
        const key = Symbol('count');
        expect(() => Verify.that(Positive(), key, -1)).toThrow(/Symbol\(count\)/);
    });

    it('points the stack at the caller, not at adorn internals', () => {
        let error: Error | undefined;
        try {
            Verify.that(Positive(), 'count', -1);
        } catch (caught) {
            error = caught as Error;
        }

        expect(error).toBeDefined();
        // V8 only; elsewhere the stack is left untouched, which is still correct, just noisier.
        if (typeof (Error as any).captureStackTrace === 'function') {
            expect(error!.stack!.split('\n')[1]).toContain('Verify.test.ts');
        }
    });
});

describe('the named helpers', () => {
    it('positive returns the value and rejects zero and below', () => {
        expect(Verify.positive('count', 3)).toBe(3);
        // P3.3 made `positive` strict. Verify inherits the break because it shares the descriptor —
        // which is the mechanism working, not a regression.
        expect(() => Verify.positive('count', 0)).toThrow(/expected a positive number/);
        expect(() => Verify.positive('count', -1)).toThrow(/expected a positive number/);
    });

    it('lessThanEqual takes (keyName, value, max) — normalised argument order', () => {
        expect(Verify.lessThanEqual('n', 10, 10)).toBe(10);
        expect(() => Verify.lessThanEqual('n', 11, 10))
            .toThrow('Value Error: n expected a number less than or equal to 10 but received 11 instead');
    });

    it('greaterThanEqual takes (keyName, value, min) — normalised argument order', () => {
        expect(Verify.greaterThanEqual('n', 10, 10)).toBe(10);
        expect(() => Verify.greaterThanEqual('n', 9, 10))
            .toThrow('Value Error: n expected a number greater than or equal to 10 but received 9 instead');
    });

    it('is total — null, undefined and NaN are violations, not TypeErrors', () => {
        expect(() => Verify.positive('count', null)).toThrow(/expected a positive number/);
        expect(() => Verify.positive('count', undefined)).toThrow(/expected a positive number/);
        expect(() => Verify.positive('count', NaN)).toThrow(/expected a positive number/);
        expect(() => Verify.positive('count', '5' as any)).toThrow(/expected a positive number/);
    });
});

describe('parity with the descriptors — there is no second implementation', () => {
    const cases: Array<[string, (value: unknown) => unknown, (value: unknown) => boolean]> = [
        ['positive', v => Verify.positive('k', v), Positive().predicate],
        ['lessThanEqual', v => Verify.lessThanEqual('k', v, 10), LessThanEqual(10).predicate],
        ['greaterThanEqual', v => Verify.greaterThanEqual('k', v, 10), GreaterThanEqual(10).predicate],
        ['nonNegative', v => Verify.that(NonNegative(), 'k', v), NonNegative().predicate],
    ];

    const values: unknown[] = [
        -1, 0, 1, 9, 10, 11, 0.5, -0.5, NaN, Infinity, -Infinity,
        null, undefined, '10', {}, [], true,
    ];

    cases.forEach(([name, verify, predicate]) => {
        it(`${name} agrees with its descriptor on every boundary case`, () => {
            values.forEach(value => {
                let threw = false;
                try {
                    verify(value);
                } catch {
                    threw = true;
                }
                expect([String(value), threw]).toEqual([String(value), !predicate(value)]);
            });
        });
    });
});
