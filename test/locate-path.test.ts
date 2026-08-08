/**
 * `Verify.check` failure localization — the `path` to the first failing key/index (DEC-060 / round-3 §1).
 *
 * A compositional descriptor (`@Dictionary`/`@Shape`/`@ArrayOf`/`@Nullable`) supplies a `locate` hook that
 * re-walks a REJECTED value in the same order as its predicate's `every`, so `Verify.check` reports the
 * first failing sub-location — enabling a per-field 400 instead of one message for every failure. `path` is
 * absent for a primitive constraint and for a container-gate / length-bound failure (the message stands).
 */

import {
    Verify,
    ObjectContracts,
    ArrayContracts,
    EnumContracts,
    NullableContracts,
    StringContracts,
    NumberContracts,
    Enforce,
} from '../index';

type Fail = {
    ok: false;
    message: string;
    constraint: string;
    kind: string;
    path?: ReadonlyArray<string | number>;
    expected?: string;
};
function asFail<T>(r: {ok: true; value: T} | Fail): Fail {
    if (r.ok) throw new Error('expected a violation');
    return r as Fail;
}

// A contracted field class, so `@Shape` has fields to read (decorated before it is shaped — DEC-007).
class Point {
    @Enforce.greaterThanEqual(0) x!: number;
    @Enforce.greaterThanEqual(0) y!: number;
}

describe('Verify.check localization — the failing key/index path (DEC-060)', () => {
    it('a @Dictionary names the first failing KEY', () => {
        const dict = ObjectContracts.Dictionary(StringContracts.NotEmpty());
        expect(asFail(Verify.check(dict, 'slots', {a: 'x', b: '', c: 'y'})).path).toEqual(['b']);
    });

    it('an @ArrayOf names the first failing INDEX (parity with the predicate every)', () => {
        const list = ArrayContracts.ArrayOf(StringContracts.NotEmpty());
        // First failure is at index 1 (''), matching where `isArrayOf`'s `every` first returns false.
        expect(asFail(Verify.check(list, 'tags', ['a', '', 'c'])).path).toEqual([1]);
    });

    it('a @Dictionary of @Shape yields a DEEP path (["<key>", "<field>"])', () => {
        const grid = ObjectContracts.Dictionary(ObjectContracts.Shape(Point));
        const bad = {a: {x: 1, y: 2}, b: {x: 1, y: -5}}; // b.y = -5 fails y >= 0
        expect(asFail(Verify.check(grid, 'grid', bad)).path).toEqual(['b', 'y']);
    });

    it('a @Shape names the first failing FIELD', () => {
        const shape = ObjectContracts.Shape(Point);
        expect(asFail(Verify.check(shape, 'p', {x: -1, y: 2})).path).toEqual(['x']);
    });

    it('a @Nullable is TRANSPARENT — it adds no segment and points straight inside', () => {
        const nul = NullableContracts.Nullable(ObjectContracts.Dictionary(StringContracts.NotEmpty()));
        expect(asFail(Verify.check(nul, 'opt', {a: ''})).path).toEqual(['a']);
    });

    it('omits `path` for a container-gate failure (the whole value is the wrong shape)', () => {
        const dict = ObjectContracts.Dictionary(StringContracts.NotEmpty());
        const fail = asFail(Verify.check(dict, 'slots', 'nope'));
        expect(fail.path).toBeUndefined();
    });

    it('omits `path` for a length-bound failure (the array itself is too short)', () => {
        const list = ArrayContracts.ArrayOf(StringContracts.NotEmpty(), {minItems: 3});
        const fail = asFail(Verify.check(list, 'tags', ['a']));
        expect(fail.path).toBeUndefined();
    });

    it('omits `path` for a primitive constraint (no `locate` hook)', () => {
        const fail = asFail(Verify.check(NumberContracts.Between(1, 7), 'n', 99));
        expect(fail.path).toBeUndefined();
        expect('locate' in NumberContracts.Between(1, 7)).toBe(false);
    });
});

describe('Verify.check `expected` — the INNERMOST failing describe (round-4 §2.2)', () => {
    it('an @ArrayOf(@OneOf) carries the inner enum describe, NOT the container ("array") phrasing', () => {
        const list = ArrayContracts.ArrayOf(EnumContracts.OneOf(['alice', 'bob']));
        const fail = asFail(Verify.check(list, 'subjects', ['alice', 'zzz', 'bob']));
        expect(fail.path).toEqual([1]);
        // The whole point: `expected` describes what index 1 should be (a member), not "an array of …".
        expect(fail.expected).toBe(EnumContracts.OneOf(['alice', 'bob']).describe());
        expect(fail.expected).not.toContain('array');
    });

    it('a @Shape carries the failing field constraint describe at its path', () => {
        const shape = ObjectContracts.Shape(Point);
        const fail = asFail(Verify.check(shape, 'p', {x: -1, y: 2}));
        expect(fail.path).toEqual(['x']);
        expect(fail.expected).toBe(NumberContracts.GreaterThanEqual(0).describe());
    });

    it('a @Dictionary of @Shape carries the DEEP innermost describe', () => {
        const grid = ObjectContracts.Dictionary(ObjectContracts.Shape(Point));
        const fail = asFail(Verify.check(grid, 'grid', {a: {x: 1, y: 2}, b: {x: 1, y: -5}}));
        expect(fail.path).toEqual(['b', 'y']);
        expect(fail.expected).toBe(NumberContracts.GreaterThanEqual(0).describe());
    });

    it('a @Nullable forwards the inner `expected` transparently', () => {
        const nul = NullableContracts.Nullable(ObjectContracts.Dictionary(StringContracts.NotEmpty()));
        const fail = asFail(Verify.check(nul, 'opt', {a: ''}));
        expect(fail.path).toEqual(['a']);
        expect(fail.expected).toBe(StringContracts.NotEmpty().describe());
    });

    it('omits `expected` for a primitive / container-gate failure (no path to align to)', () => {
        expect(asFail(Verify.check(NumberContracts.Between(1, 7), 'n', 99)).expected).toBeUndefined();
        const dict = ObjectContracts.Dictionary(StringContracts.NotEmpty());
        expect(asFail(Verify.check(dict, 'slots', 'nope')).expected).toBeUndefined();
    });

    it('never leaks the received value — `expected` is a pure function of params (DEC-030)', () => {
        const list = ArrayContracts.ArrayOf(EnumContracts.OneOf(['alice', 'bob']));
        const fail = asFail(Verify.check(list, 'subjects', ['alice', 'secret-value-xyz']));
        expect(fail.expected).not.toContain('secret-value-xyz');
    });
});
