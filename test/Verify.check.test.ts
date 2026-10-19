/**
 * `Verify.check` — the non-throwing imperative entry point (DEC-053).
 *
 * The boundary answer to Q-6: an I/O handler needs a violation as a *value, in this call*, not as a
 * thrown exception. These tests pin the four things that make it useful and safe: it returns a
 * discriminated result, it never throws on a violation, its failure message is redacted by default and
 * byte-for-byte identical to what `Verify.that` throws (no drift — DEC-010/DEC-030), and its identity
 * fields are read from the descriptor rather than hard-coded.
 */

import {Verify, NumberContracts, StringContracts, setValueDisclosure, getValueDisclosure} from '../index';

// Narrow a result to its failure branch in a `try`-free helper (TS control-flow narrowing is widened
// across a `try` at the call site, so the guard lives here where the branch resolves cleanly).
type Failure = {ok: false; message: string; constraint: string; kind: string};
function asFailure<T>(r: {ok: true; value: T} | Failure): Failure {
    if (r.ok) throw new Error('expected a violation, got a passing result');
    return r as Failure; // runtime-guarded above; cast sidesteps CFA narrowing of the generic union
}

describe('Verify.check — non-throwing validation (DEC-053)', () => {
    it('returns {ok: true, value} for a value that satisfies the constraint', () => {
        const r = Verify.check(NumberContracts.Between(1, 7), 'days', 5);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected a passing result');
        expect(r.value).toBe(5);
    });

    it('returns {ok: false, ...} for a violation — and does NOT throw', () => {
        const call = () => Verify.check(NumberContracts.Between(1, 7), 'days', 99);
        expect(call).not.toThrow();

        const fail = asFailure(call());
        expect(typeof fail.message).toBe('string');
        expect(fail.message.length).toBeGreaterThan(0);
    });

    it('carries the descriptor `constraint` identity and `kind`, read from the descriptor', () => {
        const descriptor = NumberContracts.Between(1, 7);
        const fail = asFailure(Verify.check(descriptor, 'days', 99));
        // Read from the descriptor, not hard-coded — so a boundary can branch on them programmatically.
        expect(fail.constraint).toBe(descriptor.constraint);
        expect(fail.kind).toBe(descriptor.kind);
    });

    it('reports a string constraint as kind "string"', () => {
        const fail = asFailure(Verify.check(StringContracts.Uuid(), 'id', 'not-a-uuid'));
        expect(fail.kind).toBe('string');
    });

    it('redacts the received value by default AND matches what Verify.that throws (no drift)', () => {
        const descriptor = NumberContracts.Between(1, 7);

        let thrown = '';
        try {
            Verify.that(descriptor, 'days', 99);
        } catch (error) {
            thrown = (error as Error).message;
        }

        const fail = asFailure(Verify.check(descriptor, 'days', 99));
        // Redacted by default — the raw value must not appear in the returned message (DEC-030).
        expect(fail.message).toContain('[REDACTED]');
        expect(fail.message).not.toContain('99');
        // Byte-for-byte parity with the throwing path: same predicate, same message call.
        expect(fail.message).toBe(thrown);
    });

    it('discloses the raw value when the global switch is on, exactly like Verify.that', () => {
        const previous = getValueDisclosure();
        setValueDisclosure('all');
        let message: string;
        try {
            message = asFailure(Verify.check(NumberContracts.Between(1, 7), 'days', 99)).message;
        } finally {
            setValueDisclosure(previous);
        }
        expect(message).toContain('99');
    });

    it('does not include the received value on the result object (only the redacted message carries it)', () => {
        const fail = asFailure(Verify.check(NumberContracts.Between(1, 7), 'days', 99));
        // The failure shape is {ok, message, constraint, kind} — no `value` field to leak.
        expect(Object.keys(fail).sort()).toEqual(['constraint', 'kind', 'message', 'ok']);
    });
});
