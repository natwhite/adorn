import {constraintFromJSON, ConstraintDescriptor} from '../Core/Descriptor';
import {
    Between,
    GreaterThan,
    GreaterThanEqual,
    Integer,
    LessThan,
    LessThanEqual,
    MultipleOf,
    Negative,
    NonNegative,
    NonPositive,
    Positive,
} from './number';
import {Email, Matches, MaxLength, MinLength, NotEmpty, StringMinLength, Url} from './string';

/**
 * Parity fixtures: the exact strings the closures in `src/ParameterDecorators/Constraints.ts` threw
 * before the P1.0 port. Message rework is P3.1's job, so P3.3 must not move them — a constraint may
 * change *which* values it rejects (Q-1, Q-7, BUG-4 all do) without changing how it words a
 * rejection.
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

/** Everything a predicate must survive without throwing, and reject. */
const HOSTILE: unknown[] = [
    null,
    undefined,
    NaN,
    '',
    'abc',
    {},
    [],
    () => 0,
    true,
    false,
    Symbol('s'),
];

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

describe('Positive', () => {
    const descriptor = Positive();

    it('is reified as an exclusive lower bound of zero', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('positive');
        expect(descriptor.params).toEqual({exclusiveMin: 0});
    });

    it('rejects values at or below zero', () => {
        expect(descriptor.predicate(-1)).toBe(false);
        expect(descriptor.predicate(-0.0001)).toBe(false);
        expect(descriptor.predicate(1)).toBe(true);
        expect(descriptor.predicate(Number.MIN_VALUE)).toBe(true);
        expect(descriptor.predicate(1e9)).toBe(true);
    });

    it('CHANGED BY P3.3 (Q-1): rejects 0 — "positive" now means > 0', () => {
        // Previously pinned as a known defect: the original rejected only `value < 0`, so 0 passed
        // despite the name. Settled strictly because `Negative` lands in the same release, and under
        // the lax reading 0 would satisfy `positive` AND `nonPositive`, with `Positive`/`Negative`
        // sharing a boundary no reader would predict. `NonNegative()` is the old behaviour.
        expect(descriptor.predicate(0)).toBe(false);
        expect(descriptor.predicate(-0)).toBe(false);
        expect(NonNegative().predicate(0)).toBe(true);
    });

    it('CHANGED BY P3.3 (Q-7): rejects NaN', () => {
        // Previously pinned: `!(NaN < 0)` is `true`, so NaN satisfied every numeric constraint.
        expect(descriptor.predicate(NaN)).toBe(false);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(descriptor, -5)).toBe(legacy.positive(-5));
    });

    it('describes itself for documentation without a value in hand', () => {
        expect(descriptor.describe()).toBe('a positive number');
    });

    it('agrees with GreaterThan(0) — one derivation, two identities', () => {
        const asExclusiveMin = GreaterThan(0);

        [-2, -1, -0, 0, 0.5, 1, 2].forEach(value => {
            expect(asExclusiveMin.predicate(value)).toBe(descriptor.predicate(value));
        });
        expect(asExclusiveMin.params).toEqual(descriptor.params);
        expect(asExclusiveMin.describe()).not.toBe(descriptor.describe());
    });
});

describe('Negative', () => {
    const descriptor = Negative();

    it('is reified as an exclusive upper bound of zero', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('negative');
        expect(descriptor.params).toEqual({exclusiveMax: 0});
    });

    it('rejects values at or above zero', () => {
        expect(descriptor.predicate(-1)).toBe(true);
        expect(descriptor.predicate(-Number.MIN_VALUE)).toBe(true);
        expect(descriptor.predicate(0)).toBe(false);
        expect(descriptor.predicate(-0)).toBe(false);
        expect(descriptor.predicate(1)).toBe(false);
    });

    it('is the exact mirror of Positive — nothing satisfies both, zero satisfies neither', () => {
        const positive = Positive();

        [-2, -1, -0.5, -0, 0, 0.5, 1, 2, NaN, Infinity, -Infinity].forEach(value => {
            expect(positive.predicate(value) && descriptor.predicate(value)).toBe(false);
        });
        expect(positive.predicate(0)).toBe(false);
        expect(descriptor.predicate(0)).toBe(false);
    });

    it('describes itself', () => {
        expect(descriptor.describe()).toBe('a negative number');
    });
});

describe('NonNegative / NonPositive', () => {
    it('are reified as inclusive bounds at zero', () => {
        expect(NonNegative().constraint).toBe('nonNegative');
        expect(NonNegative().params).toEqual({min: 0});
        expect(NonPositive().constraint).toBe('nonPositive');
        expect(NonPositive().params).toEqual({max: 0});
    });

    it('include zero, and only zero satisfies both', () => {
        expect(NonNegative().predicate(0)).toBe(true);
        expect(NonPositive().predicate(0)).toBe(true);
        expect(NonNegative().predicate(-1)).toBe(false);
        expect(NonPositive().predicate(1)).toBe(false);
    });

    it('share derivations with min and max — one source, distinct identities', () => {
        [-2, -1, 0, 1, 2].forEach(value => {
            expect(NonNegative().predicate(value)).toBe(GreaterThanEqual(0).predicate(value));
            expect(NonPositive().predicate(value)).toBe(LessThanEqual(0).predicate(value));
        });
        expect(NonNegative().describe()).toBe('a non-negative number');
        expect(NonPositive().describe()).toBe('a non-positive number');
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

    it('CHANGED BY P3.3 (Q-7): rejects NaN', () => {
        expect(GreaterThanEqual(5).predicate(NaN)).toBe(false);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(GreaterThanEqual(5), 2)).toBe(legacy.greaterThanEqual(5, 2));
    });

    it('rejects a non-numeric bound at authoring time', () => {
        expect(() => GreaterThanEqual('5' as any)).toThrow(/finite number/);
        expect(() => GreaterThanEqual(NaN)).toThrow(/finite number/);
        expect(() => GreaterThanEqual(Infinity)).toThrow(/finite number/);
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

    it('CHANGED BY P3.3 (Q-7): rejects NaN', () => {
        expect(LessThanEqual(5).predicate(NaN)).toBe(false);
    });

    it('reproduces the original message exactly', () => {
        expect(messageFor(LessThanEqual(5), 9)).toBe(legacy.lessThanEqual(5, 9));
    });
});

describe('GreaterThan / LessThan', () => {
    it('are reified as exclusive bounds', () => {
        expect(GreaterThan(5).constraint).toBe('greaterThan');
        expect(GreaterThan(5).params).toEqual({exclusiveMin: 5});
        expect(LessThan(5).constraint).toBe('lessThan');
        expect(LessThan(5).params).toEqual({exclusiveMax: 5});
    });

    it('exclude the boundary, unlike their inclusive siblings', () => {
        expect(GreaterThan(5).predicate(5)).toBe(false);
        expect(GreaterThanEqual(5).predicate(5)).toBe(true);
        expect(GreaterThan(5).predicate(5.0000001)).toBe(true);

        expect(LessThan(5).predicate(5)).toBe(false);
        expect(LessThanEqual(5).predicate(5)).toBe(true);
        expect(LessThan(5).predicate(4.9999999)).toBe(true);
    });

    it('describe the exclusivity in words', () => {
        expect(GreaterThan(5).describe()).toBe('a number greater than 5');
        expect(LessThan(5).describe()).toBe('a number less than 5');
    });
});

describe('Between', () => {
    const descriptor = Between(1, 10);

    it('is reified as an inclusive range', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('between');
        expect(descriptor.params).toEqual({min: 1, max: 10});
        expect(descriptor.describe()).toBe('a number between 1 and 10 (inclusive)');
    });

    it('includes both boundaries and excludes just outside them', () => {
        expect(descriptor.predicate(0.9999)).toBe(false);
        expect(descriptor.predicate(1)).toBe(true);
        expect(descriptor.predicate(5)).toBe(true);
        expect(descriptor.predicate(10)).toBe(true);
        expect(descriptor.predicate(10.0001)).toBe(false);
    });

    it('is exactly the conjunction of its two bounds — composed, not re-implemented', () => {
        const lower = GreaterThanEqual(1);
        const upper = LessThanEqual(10);

        for (let value = -3; value <= 14; value += 0.5) {
            expect(descriptor.predicate(value)).toBe(lower.predicate(value) && upper.predicate(value));
        }
    });

    it('allows a degenerate range that pins one value', () => {
        const pinned = Between(3, 3);

        expect(pinned.predicate(3)).toBe(true);
        expect(pinned.predicate(2)).toBe(false);
        expect(pinned.predicate(4)).toBe(false);
    });

    it('rejects an unsatisfiable range at authoring time', () => {
        expect(() => Between(10, 1)).toThrow(RangeError);
        expect(() => Between(10, 1)).toThrow(/must not exceed/);
    });

    it('rejects non-numeric bounds at authoring time', () => {
        expect(() => Between(null as any, 10)).toThrow(/finite number/);
        expect(() => Between(1, undefined as any)).toThrow(/finite number/);
    });
});

describe('Integer', () => {
    const descriptor = Integer();

    it('is reified with no params — the rule is fully determined by its identity', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('integer');
        expect(descriptor.params).toEqual({});
        expect(descriptor.describe()).toBe('an integer');
    });

    it('accepts whole numbers of either sign, including zero', () => {
        [-3, -1, 0, -0, 1, 42, 1e15].forEach(value => expect(descriptor.predicate(value)).toBe(true));
    });

    it('rejects fractions and non-finite values', () => {
        [1.5, -0.1, 1e-7, Infinity, -Infinity, NaN].forEach(value =>
            expect(descriptor.predicate(value)).toBe(false));
    });

    it('treats 1.0 as an integer — JavaScript has one number type and the constraint follows it', () => {
        expect(descriptor.predicate(1.0)).toBe(true);
    });
});

describe('MultipleOf', () => {
    it('is reified with the divisor as data', () => {
        const descriptor = MultipleOf(5);

        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe('multipleOf');
        expect(descriptor.params).toEqual({multipleOf: 5});
        expect(descriptor.describe()).toBe('a multiple of 5');
    });

    it('is exact for integer operands, in both signs', () => {
        const descriptor = MultipleOf(3);

        [-9, -3, 0, 3, 9, 300].forEach(value => expect(descriptor.predicate(value)).toBe(true));
        [-8, -1, 1, 2, 4, 301].forEach(value => expect(descriptor.predicate(value)).toBe(false));
    });

    it('treats zero as a multiple of everything', () => {
        expect(MultipleOf(7).predicate(0)).toBe(true);
        expect(MultipleOf(0.1).predicate(0)).toBe(true);
    });

    it('tolerates binary floating point for fractional divisors', () => {
        // `0.3 % 0.1` is 0.09999999999999998, not 0. A naive `%` would report 0.3 as not a multiple
        // of 0.1, which is an artefact of the representation rather than an answer about the value.
        const descriptor = MultipleOf(0.1);

        expect(descriptor.predicate(0.3)).toBe(true);
        expect(descriptor.predicate(0.7)).toBe(true);
        expect(descriptor.predicate(1.2)).toBe(true);
        expect(descriptor.predicate(0.35)).toBe(false);
        expect(descriptor.predicate(0.05)).toBe(false);
    });

    it('rejects non-finite values — infinity is not a multiple of anything', () => {
        expect(MultipleOf(2).predicate(Infinity)).toBe(false);
        expect(MultipleOf(2).predicate(-Infinity)).toBe(false);
        expect(MultipleOf(2).predicate(NaN)).toBe(false);
    });

    it('rejects a non-positive divisor at authoring time', () => {
        expect(() => MultipleOf(0)).toThrow(RangeError);
        expect(() => MultipleOf(-2)).toThrow(/greater than zero/);
        expect(() => MultipleOf('2' as any)).toThrow(/finite number/);
    });
});

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

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

    it('CHANGED BY P3.3 (BUG-4): returns false for null instead of throwing', () => {
        // The original dereferenced `params.value.length` with no guard, so a null argument produced
        // a bare TypeError from inside adorn rather than a contract violation. Beyond the message,
        // a predicate that can throw is not total, and any projection that evaluates it — a fuzzer
        // first — has to defend itself against a constraint it is only supposed to ask.
        const descriptor = MinLength(3);

        expect(descriptor.predicate(null)).toBe(false);
        expect(descriptor.predicate(undefined)).toBe(false);
    });

    it('CHANGED BY P3.3: rejects non-strings that happen to have a length', () => {
        // `.length` exists on arrays and functions, so the unguarded version accepted [1, 2, 3] for
        // a string constraint. A string constraint now means a string.
        expect(MinLength(3).predicate([1, 2, 3])).toBe(false);
        expect(MinLength(0).predicate([])).toBe(false);
        expect(MinLength(0).predicate(12345)).toBe(false);
    });

    it('reproduces the original message exactly, quoting the received value', () => {
        expect(messageFor(MinLength(3), 'ab')).toBe(legacy.stringMinLength(3, 'ab'));
    });

    it('rejects a nonsensical length at authoring time', () => {
        expect(() => MinLength(-1)).toThrow(/non-negative integer/);
        expect(() => MinLength(1.5)).toThrow(/non-negative integer/);
        expect(() => MinLength('3' as any)).toThrow(/non-negative integer/);
    });
});

describe('MaxLength', () => {
    const descriptor = MaxLength(5);

    it('is reified as an inclusive maximum length', () => {
        expect(descriptor.kind).toBe('string');
        expect(descriptor.constraint).toBe('maxLength');
        expect(descriptor.params).toEqual({maxLength: 5});
        expect(descriptor.describe()).toBe('a string of length less than or equal to 5');
    });

    it('is inclusive at the boundary', () => {
        expect(descriptor.predicate('abcd')).toBe(true);
        expect(descriptor.predicate('abcde')).toBe(true);
        expect(descriptor.predicate('abcdef')).toBe(false);
    });

    it('accepts the empty string — length is a ceiling, not a range', () => {
        expect(descriptor.predicate('')).toBe(true);
    });

    it('allows a degenerate ceiling of zero', () => {
        expect(MaxLength(0).predicate('')).toBe(true);
        expect(MaxLength(0).predicate('a')).toBe(false);
    });

    it('composes with MinLength to bound a string on both sides', () => {
        const atLeast = MinLength(2);
        const atMost = MaxLength(4);

        ['', 'a', 'ab', 'abc', 'abcd', 'abcde'].forEach(value => {
            const bounded = atLeast.predicate(value) && atMost.predicate(value);
            expect(bounded).toBe(value.length >= 2 && value.length <= 4);
        });
    });
});

describe('NotEmpty', () => {
    const descriptor = NotEmpty();

    it('is a distinct identity over a shared derivation', () => {
        expect(descriptor.constraint).toBe('notEmpty');
        expect(descriptor.params).toEqual({minLength: 1});
        expect(descriptor.describe()).toBe('a non-empty string');
        // documentation names it differently; enforcement is the same single source
        expect(descriptor.describe()).not.toBe(MinLength(1).describe());
    });

    it('agrees with MinLength(1) on every input', () => {
        const equivalent = MinLength(1);

        ['', 'a', 'ab', ' '].concat(HOSTILE as any[]).forEach(value => {
            expect(descriptor.predicate(value)).toBe(equivalent.predicate(value));
        });
    });

    it('rejects only the empty string among strings', () => {
        expect(descriptor.predicate('')).toBe(false);
        expect(descriptor.predicate('a')).toBe(true);
    });

    it('accepts whitespace — it is length-based, not blank-based', () => {
        // Trimming would make params ({minLength: 1}) describe something other than what is
        // enforced. "Not blank" is a different rule and would need its own identity.
        expect(descriptor.predicate('   ')).toBe(true);
        expect(descriptor.predicate('\t\n')).toBe(true);
    });
});

describe('Matches', () => {
    it('carries the pattern as serialisable data, never a live RegExp', () => {
        const descriptor = Matches(/^a+$/);

        expect(descriptor.kind).toBe('string');
        expect(descriptor.constraint).toBe('matches');
        expect(descriptor.params).toEqual({pattern: {source: '^a+$', flags: ''}});
        expect(descriptor.describe()).toBe('a string matching /^a+$/');
    });

    it('enforces the pattern', () => {
        const descriptor = Matches(/^a+$/);

        expect(descriptor.predicate('a')).toBe(true);
        expect(descriptor.predicate('aaa')).toBe(true);
        expect(descriptor.predicate('b')).toBe(false);
        expect(descriptor.predicate('aab')).toBe(false);
        expect(descriptor.predicate('')).toBe(false);
    });

    it('accepts a source string plus flags', () => {
        const descriptor = Matches('^a+$', 'i');

        expect(descriptor.params).toEqual({pattern: {source: '^a+$', flags: 'i'}});
        expect(descriptor.predicate('AAA')).toBe(true);
        expect(descriptor.predicate('bbb')).toBe(false);
    });

    it('leaves anchoring to the author', () => {
        expect(Matches(/a/).predicate('xxaxx')).toBe(true);
        expect(Matches(/^a$/).predicate('xxaxx')).toBe(false);
    });

    it('is stateless across calls — the g flag is refused rather than silently stripped', () => {
        // `RegExp.test` advances `lastIndex` under `g`, so a shared expression would answer
        // differently for the same input on successive calls. Stripping the flag instead would
        // leave params printing /a/g while enforcement ran /a/ — Q-4 drift introduced by a
        // convenience.
        expect(() => Matches(/a/g)).toThrow(/'g' and 'y' flags are not supported/);
        expect(() => Matches(/a/y)).toThrow(/'g' and 'y' flags are not supported/);

        const descriptor = Matches(/a/);
        expect(descriptor.predicate('a')).toBe(true);
        expect(descriptor.predicate('a')).toBe(true);
        expect(descriptor.predicate('a')).toBe(true);
    });

    it('rejects an invalid pattern at authoring time, not on first call', () => {
        expect(() => Matches('[')).toThrow(/invalid regular expression/);
        expect(() => Matches(123 as any)).toThrow(/expected a RegExp or a pattern string/);
        expect(() => Matches(/a/, 'i')).toThrow(/not both/);
    });

    it('round-trips through JSON and enforces identically', () => {
        const descriptor = Matches('^[a-z]+$', 'i');
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

        ['abc', 'ABC', 'a1', ''].forEach(value => {
            expect(revived.predicate(value)).toBe(descriptor.predicate(value));
        });
    });
});

describe('Email', () => {
    const descriptor = Email();

    it('exposes the pattern it actually enforces rather than hiding it behind a name', () => {
        expect(descriptor.constraint).toBe('email');
        expect(descriptor.describe()).toBe('an email address');
        expect(typeof (descriptor.params as any).pattern.source).toBe('string');
    });

    it('accepts ordinary addresses', () => {
        [
            'a@b.co',
            'user@example.com',
            'first.last@example.co.uk',
            'user+tag@example.com',
            'USER@EXAMPLE.COM',
            "o'brien@example.com",
        ].forEach(value => expect(descriptor.predicate(value)).toBe(true));
    });

    it('rejects the obvious non-addresses', () => {
        [
            '',
            'plainstring',
            'no-at-sign.com',
            '@example.com',
            'user@',
            'user@example',        // no dot in the domain
            'user @example.com',   // whitespace
            'user@exa mple.com',
            'a@b@c.com',
        ].forEach(value => expect(descriptor.predicate(value)).toBe(false));
    });

    it('is documented as approximate, and behaves that way', () => {
        // Deliberately permissive: P3.3 prefers an approximate pattern over a baroque one that
        // rejects valid addresses. This asserts the limit rather than pretending it is absent —
        // the only way to know an address is deliverable is to send to it.
        expect(descriptor.predicate('not really@an.address')).toBe(false); // whitespace still fails
        expect(descriptor.predicate('a@b.c')).toBe(true);                  // no TLD check
        expect(descriptor.predicate('..@..x')).toBe(true);                 // no structural check
    });

    it('shares its derivation with Matches', () => {
        const equivalent = Matches((descriptor.params as any).pattern.source);

        ['user@example.com', 'bad', '', 'a@b.c'].forEach(value => {
            expect(descriptor.predicate(value)).toBe(equivalent.predicate(value));
        });
    });
});

describe('Url', () => {
    const descriptor = Url();

    it('defaults to http and https, normalised with the trailing colon', () => {
        expect(descriptor.constraint).toBe('url');
        expect(descriptor.params).toEqual({protocols: ['http:', 'https:']});
        expect(descriptor.describe()).toBe('a URL using http or https');
    });

    it('accepts absolute web URLs', () => {
        [
            'http://example.com',
            'https://example.com',
            'https://example.com/path?query=1#hash',
            'https://user:pw@example.com:8443/x',
            'HTTPS://EXAMPLE.COM',
        ].forEach(value => expect(descriptor.predicate(value)).toBe(true));
    });

    it('rejects relative, malformed, and disallowed-protocol values', () => {
        [
            '',
            '/path/only',
            'example.com',
            'http://',
            'not a url',
            'ftp://example.com',
            'javascript:alert(1)',
            'data:text/html,<h1>x</h1>',
        ].forEach(value => expect(descriptor.predicate(value)).toBe(false));
    });

    it('does not let a parse failure escape as a thrown error', () => {
        // `new URL` signals failure by throwing. A predicate that propagated that would be
        // non-total in exactly the way BUG-4 describes.
        expect(() => descriptor.predicate('http://[')).not.toThrow();
        expect(descriptor.predicate('http://[')).toBe(false);
    });

    it('widens on request, accepting either spelling of a protocol', () => {
        const withFtp = Url(['http', 'https', 'ftp:']);

        expect(withFtp.params).toEqual({protocols: ['http:', 'https:', 'ftp:']});
        expect(withFtp.predicate('ftp://example.com')).toBe(true);
        expect(withFtp.predicate('javascript:alert(1)')).toBe(false);
    });

    it('rejects a nonsensical protocol list at authoring time', () => {
        expect(() => Url([])).toThrow(/non-empty array/);
        expect(() => Url('http' as any)).toThrow(/non-empty array/);
        expect(() => Url([''] as any)).toThrow(/non-empty string/);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

/** Every built-in descriptor, exercised uniformly. */
const ALL: ConstraintDescriptor[] = [
    Positive(),
    Negative(),
    NonNegative(),
    NonPositive(),
    GreaterThanEqual(5),
    LessThanEqual(10),
    GreaterThan(5),
    LessThan(10),
    Between(1, 10),
    Integer(),
    MultipleOf(3),
    MinLength(3),
    MaxLength(8),
    NotEmpty(),
    Matches(/^a+$/),
    Email(),
    Url(),
];

describe('predicates are total (ISSUES.md BUG-4)', () => {
    it('never throws, for any hostile input, on any constraint', () => {
        ALL.forEach(descriptor => {
            HOSTILE.forEach(value => {
                expect(() => descriptor.predicate(value)).not.toThrow();
            });
        });
    });

    it('always answers with a boolean', () => {
        ALL.forEach(descriptor => {
            HOSTILE.forEach(value => {
                expect(typeof descriptor.predicate(value)).toBe('boolean');
            });
        });
    });

    it('rejects null and undefined everywhere', () => {
        ALL.forEach(descriptor => {
            expect(descriptor.predicate(null)).toBe(false);
            expect(descriptor.predicate(undefined)).toBe(false);
        });
    });

    it('rejects values of the wrong domain', () => {
        ALL.forEach(descriptor => {
            const wrongDomain: unknown = descriptor.kind === 'string' ? 42 : 'forty-two';
            expect(descriptor.predicate(wrongDomain)).toBe(false);
            expect(descriptor.predicate({})).toBe(false);
            expect(descriptor.predicate([])).toBe(false);
            expect(descriptor.predicate(true)).toBe(false);
        });
    });
});

describe('NaN violates every numeric constraint (ISSUES.md Q-7, settled in P3.3)', () => {
    const numeric = ALL.filter(descriptor => descriptor.kind === 'number');

    it('covers the whole numeric vocabulary, not just the ones that were pinned', () => {
        expect(numeric.length).toBeGreaterThanOrEqual(11);
        numeric.forEach(descriptor => expect(descriptor.predicate(NaN)).toBe(false));
    });

    it('closes the same hole for undefined, which also satisfied everything', () => {
        // `!(undefined < 5)` is `true`, because `undefined` coerces to NaN. The old form let it
        // through for exactly the reason NaN got through.
        numeric.forEach(descriptor => expect(descriptor.predicate(undefined)).toBe(false));
    });

    it('leaves Infinity alone, because its ordering is coherent', () => {
        // NaN is excluded for having no ordering at all, not for being exotic. Infinity genuinely
        // is greater than 5, so a lower bound should accept it.
        expect(GreaterThanEqual(5).predicate(Infinity)).toBe(true);
        expect(GreaterThan(5).predicate(Infinity)).toBe(true);
        expect(LessThanEqual(5).predicate(Infinity)).toBe(false);
        expect(Positive().predicate(Infinity)).toBe(true);
        expect(Negative().predicate(-Infinity)).toBe(true);
        // ...but a range and a multiple still exclude it, which is also the ordering answer
        expect(Between(1, 10).predicate(Infinity)).toBe(false);
        expect(Integer().predicate(Infinity)).toBe(false);
    });
});

describe('projection readiness', () => {
    it('exposes identity and params as plain JSON for every built-in', () => {
        ALL.forEach(descriptor => {
            expect(JSON.parse(JSON.stringify(descriptor))).toEqual({
                kind: descriptor.kind,
                constraint: descriptor.constraint,
                params: descriptor.params,
            });
        });
    });

    it('gives every built-in a unique identity', () => {
        const identities = ALL.map(descriptor => descriptor.constraint);

        expect(new Set(identities).size).toBe(identities.length);
    });

    it('rehydrates every built-in into an identically-enforcing descriptor', () => {
        const probes: unknown[] = [
            -10, -1, -0, 0, 0.5, 1, 3, 5, 9, 10, 11, Infinity, NaN,
            '', 'a', 'aaa', 'aaaaaaaaaaaa', 'user@example.com', 'https://example.com',
            null, undefined, {}, [],
        ];

        ALL.forEach(descriptor => {
            const revived = constraintFromJSON(JSON.parse(JSON.stringify(descriptor)));

            expect(revived.describe()).toBe(descriptor.describe());
            probes.forEach(probe => {
                expect(revived.predicate(probe)).toBe(descriptor.predicate(probe));
            });
        });
    });

    it('CHANGED BY P3.3: every built-in now carries a JSON Schema fragment', () => {
        // P1.0 shipped the hook unused, and a test asserted `'schema' in descriptor` was false.
        // Populating it was cheap for this vocabulary, so the assertion is inverted rather than
        // deleted — the hook being *present* is now the invariant worth pinning.
        ALL.forEach(descriptor => {
            expect('schema' in descriptor).toBe(true);
            expect(typeof descriptor.schema!()).toBe('object');
        });
    });

    it('supplies no arbitrary — the shape exists, generators do not', () => {
        // `fast-check` is not a dependency (IDEA-3), so `arbitrary` is absent rather than
        // undefined: `'arbitrary' in descriptor` stays an honest answer to "can this be fuzzed?".
        ALL.forEach(descriptor => expect('arbitrary' in descriptor).toBe(false));
    });

    it('declares a schema type consistent with its own kind', () => {
        ALL.forEach(descriptor => {
            const fragment = descriptor.schema!();
            const expected = descriptor.kind === 'string'
                ? 'string'
                : descriptor.constraint === 'integer' ? 'integer' : 'number';

            expect(fragment.type).toBe(expected);
        });
    });

    it('never over-claims: a schema fragment accepts everything the predicate accepts', () => {
        // The rule stated in both Contracts modules. A fragment may under-claim (JSON Schema cannot
        // express a protocol allowlist), but a fragment that *rejects* a value enforcement accepts
        // would make a generated client refuse valid input — silently.
        const cases: Array<[ConstraintDescriptor, string[]]> = [
            [Matches('^a+$'), ['a', 'aaa']],
            [Email(), ['user@example.com', "o'brien@example.com"]],
            [MinLength(3), ['abc', 'abcdef']],
            [MaxLength(3), ['', 'abc']],
            [NotEmpty(), ['a', '   ']],
        ];

        cases.forEach(([descriptor, accepted]) => {
            const pattern = descriptor.schema!().pattern;
            accepted.forEach(value => {
                expect(descriptor.predicate(value)).toBe(true);
                if (typeof pattern === 'string') {
                    expect(new RegExp(pattern).test(value)).toBe(true);
                }
            });
        });
    });

    it('degrades a flagged pattern rather than emitting one that would over-claim', () => {
        // /foo/i has no faithful JSON Schema `pattern`; emitting the bare source would produce a
        // case-sensitive fragment rejecting values the constraint accepts.
        expect(Matches('^a+$', 'i').schema!()).toEqual({type: 'string'});
        expect(Matches('^a+$').schema!()).toEqual({type: 'string', pattern: '^a+$'});
    });

    it('is enough on its own to render a documentation line', () => {
        const lines = ALL.map(descriptor => `${descriptor.constraint}: expects ${descriptor.describe()}`);

        expect(lines).toEqual([
            'positive: expects a positive number',
            'negative: expects a negative number',
            'nonNegative: expects a non-negative number',
            'nonPositive: expects a non-positive number',
            'min: expects a number greater than or equal to 5',
            'max: expects a number less than or equal to 10',
            'greaterThan: expects a number greater than 5',
            'lessThan: expects a number less than 10',
            'between: expects a number between 1 and 10 (inclusive)',
            'integer: expects an integer',
            'multipleOf: expects a multiple of 3',
            'minLength: expects a string of length greater than 3',
            'maxLength: expects a string of length less than or equal to 8',
            'notEmpty: expects a non-empty string',
            'matches: expects a string matching /^a+$/',
            'email: expects an email address',
            'url: expects a URL using http or https',
        ]);
    });
});

describe('no drift between params and predicate (ISSUES.md Q-4)', () => {
    it('makes the enforced boundary follow params for every bounded numeric built-in', () => {
        for (let bound = -5; bound <= 5; bound++) {
            const atLeast = GreaterThanEqual(bound);
            expect(atLeast.params.min).toBe(bound);
            expect(atLeast.predicate(bound)).toBe(true);
            expect(atLeast.predicate(bound - 1)).toBe(false);

            const atMost = LessThanEqual(bound);
            expect(atMost.params.max).toBe(bound);
            expect(atMost.predicate(bound)).toBe(true);
            expect(atMost.predicate(bound + 1)).toBe(false);

            const above = GreaterThan(bound);
            expect(above.params.exclusiveMin).toBe(bound);
            expect(above.predicate(bound)).toBe(false);
            expect(above.predicate(bound + 1)).toBe(true);

            const below = LessThan(bound);
            expect(below.params.exclusiveMax).toBe(bound);
            expect(below.predicate(bound)).toBe(false);
            expect(below.predicate(bound - 1)).toBe(true);
        }
    });

    it('makes the enforced range follow params', () => {
        for (let low = -3; low <= 3; low++) {
            const descriptor = Between(low, low + 4);
            expect(descriptor.params.min).toBe(low);
            expect(descriptor.params.max).toBe(low + 4);
            expect(descriptor.predicate(low)).toBe(true);
            expect(descriptor.predicate(low + 4)).toBe(true);
            expect(descriptor.predicate(low - 1)).toBe(false);
            expect(descriptor.predicate(low + 5)).toBe(false);
        }
    });

    it('makes the enforced divisor follow params', () => {
        for (let divisor = 1; divisor <= 6; divisor++) {
            const descriptor = MultipleOf(divisor);
            expect(descriptor.params.multipleOf).toBe(divisor);
            expect(descriptor.predicate(divisor * 4)).toBe(true);
            if (divisor > 1) expect(descriptor.predicate(divisor * 4 + 1)).toBe(false);
        }
    });

    it('makes the enforced length follow params', () => {
        for (let bound = 0; bound <= 5; bound++) {
            const atLeast = MinLength(bound);
            expect(atLeast.params.minLength).toBe(bound);
            expect(atLeast.predicate('x'.repeat(bound))).toBe(true);
            if (bound > 0) expect(atLeast.predicate('x'.repeat(bound - 1))).toBe(false);

            const atMost = MaxLength(bound);
            expect(atMost.params.maxLength).toBe(bound);
            expect(atMost.predicate('x'.repeat(bound))).toBe(true);
            expect(atMost.predicate('x'.repeat(bound + 1))).toBe(false);
        }
    });

    it('makes the enforced pattern follow params', () => {
        ['^a+$', '\\d{3}', '[a-z]'].forEach(source => {
            const descriptor = Matches(source);
            expect((descriptor.params as any).pattern.source).toBe(source);
            expect(descriptor.describe()).toContain(source);
        });
    });

    it('makes the accepted protocols follow params', () => {
        const descriptor = Url(['ws', 'wss']);

        expect(descriptor.params.protocols).toEqual(['ws:', 'wss:']);
        expect(descriptor.predicate('ws://example.com')).toBe(true);
        expect(descriptor.predicate('wss://example.com')).toBe(true);
        expect(descriptor.predicate('https://example.com')).toBe(false);
        expect(descriptor.describe()).toBe('a URL using ws or wss');
    });
});
