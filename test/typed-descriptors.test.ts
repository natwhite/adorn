/**
 * Type-level tests for the phantom output type (DEC-059 / IDEA-28).
 *
 * `Verify.check`/`that` now bind their type parameter to the constraint's OUTPUT, so a boundary
 * `unknown` narrows to what the constraint proves — discharging the casts a consumer used to carry.
 * The assertions here are COMPILE-TIME: `expectType` fails to compile if a value is wider than claimed,
 * and each `// @ts-expect-error` is verified by `tsc -p tsconfig.test.json` (the repo has no tsd harness).
 * The runtime `it`s confirm behaviour is unchanged — the narrowing is phantom, never observed at runtime.
 */

import {
    Verify,
    ObjectContracts,
    ArrayContracts,
    NullableContracts,
    StringContracts,
    NumberContracts,
} from '../index';
import type {ConstraintDescriptor} from '../index';

/** Compiles only if `value` is assignable to `T` — i.e. the narrowing is at least as specific as `T`. */
const expectType = <T>(_value: T): void => {};

describe('typed descriptors — Verify.check narrows `unknown` to the constraint output (DEC-059)', () => {
    const body: unknown = {a: 'x'};

    it('narrows a Dictionary / ArrayOf / Nullable / primitive at compile time', () => {
        const dict = Verify.check(ObjectContracts.Dictionary(StringContracts.NotEmpty()), 'x', body);
        if (dict.ok) expectType<Record<string, string>>(dict.value);

        const list = Verify.check(ArrayContracts.ArrayOf(StringContracts.NotEmpty()), 'x', body);
        if (list.ok) expectType<string[]>(list.value);

        const nul = Verify.check(NullableContracts.Nullable(StringContracts.NotEmpty()), 'x', body);
        if (nul.ok) expectType<string | null>(nul.value);

        const num = Verify.check(NumberContracts.Between(1, 7), 'x', body);
        if (num.ok) expectType<number>(num.value);

        const str = Verify.check(StringContracts.NotEmpty(), 'x', body);
        if (str.ok) expectType<string>(str.value);

        expect(true).toBe(true); // the real assertions above are compile-time
    });

    it('narrows a Fields literal to the exact object type, optional keys OPTIONAL (round-4 §2.1)', () => {
        const spec = ObjectContracts.Fields({
            seq: NumberContracts.Integer(),
            note: {descriptor: StringContracts.NotEmpty(), optional: true},
        });
        const r = Verify.check(spec, 'body', body);
        if (r.ok) {
            expectType<{seq: number; note?: string}>(r.value);
            expectType<number>(r.value.seq);
            // Compiles ONLY if `note` is optional — a missing `note` must be a valid value of the output type.
            const minimal: typeof r.value = {seq: 1};
            void minimal;
        }
        expect(true).toBe(true);
    });

    it('a typed descriptor still flows where a BARE ConstraintDescriptor is wanted (widening holds)', () => {
        // <MinParams, number> is assignable to <ConstraintParams, unknown> — the phantom is covariant.
        const bare: ConstraintDescriptor = NumberContracts.Between(1, 7);
        expect(bare.predicate(5)).toBe(true);
    });

    it('runtime is unchanged — narrowing is phantom', () => {
        const d = ObjectContracts.Dictionary(StringContracts.NotEmpty());
        expect(Verify.check(d, 'x', {k: 'v'}).ok).toBe(true);
        expect(Verify.check(d, 'x', {k: ''}).ok).toBe(false);
        expect(Verify.check(d, 'x', 'nope').ok).toBe(false);
    });
});

// Negative assertions — compile-time only, never executed (each `@ts-expect-error` MUST catch a real error).
function _negativeTypeAssertions(): void {
    const dict = Verify.check(ObjectContracts.Dictionary(StringContracts.NotEmpty()), 'x', null as unknown);
    if (dict.ok) {
        // @ts-expect-error — value is Record<string, string>, not number
        const wrong: number = dict.value;
        void wrong;
    }
    const num = Verify.check(NumberContracts.Between(1, 7), 'x', null as unknown);
    if (num.ok) {
        // @ts-expect-error — value is number, not string
        const wrong: string = num.value;
        void wrong;
    }
    const fields = Verify.check(
        ObjectContracts.Fields({seq: NumberContracts.Integer()}),
        'x',
        null as unknown,
    );
    if (fields.ok) {
        // @ts-expect-error — the required field `seq` is a number, not a string
        const wrong: string = fields.value.seq;
        void wrong;
    }
}
void _negativeTypeAssertions;
