import {evaluatePostconditions, postconditionMessage} from './Postconditions';
import {Postcondition} from './ContractRegistry';
import {resetValueDisclosure, setValueDisclosure} from './redaction';

const post = (predicate: Postcondition['predicate'], description?: string): Postcondition => ({
    predicate,
    description,
});

afterEach(resetValueDisclosure);

describe('evaluatePostconditions', () => {
    it('returns {ok: true} when every postcondition holds', () => {
        const posts = [post(r => (r as number) > 0), post((r, a) => (r as number) >= (a as number))];
        expect(evaluatePostconditions(posts, 5, [3])).toEqual({ok: true});
    });

    it('reports the first failure, base-most first', () => {
        const first = post(() => false, 'first');
        const second = post(() => false, 'second');
        const verdict = evaluatePostconditions([first, second], 1, []);
        expect(verdict.ok).toBe(false);
        expect(verdict.failed).toBe(first);
    });

    it('passes the result first, then the arguments the method received', () => {
        const seen: unknown[] = [];
        const p = post((r, a, b) => {
            seen.push(r, a, b);
            return true;
        });
        evaluatePostconditions([p], 'result', ['x', 'y']);
        expect(seen).toEqual(['result', 'x', 'y']);
    });

    it('treats a throwing predicate as a failure and carries the thrown value on `error`', () => {
        const boom = new Error('predicate blew up');
        const p = post(() => {
            throw boom;
        }, 'throws');
        const verdict = evaluatePostconditions([p], 1, []);
        expect(verdict.ok).toBe(false);
        expect(verdict.failed).toBe(p);
        expect(verdict.error).toBe(boom);
    });

    it('is empty-safe', () => {
        expect(evaluatePostconditions([], 1, [])).toEqual({ok: true});
    });
});

describe('postconditionMessage — DEC-030 redaction, callee blame', () => {
    const failed = post(() => false, 'the id is positive');

    it('redacts the returned value by default', () => {
        const message = postconditionMessage('Wallet', 'withdraw', failed, -1);
        expect(message).toContain('Wallet.withdraw');
        expect(message).toContain('the postcondition "the id is positive"');
        expect(message).toContain('[REDACTED]');
        expect(message).not.toContain('-1');
    });

    it('discloses the raw value only under setValueDisclosure("all")', () => {
        setValueDisclosure('all');
        const message = postconditionMessage('Wallet', 'withdraw', failed, -1);
        expect(message).toContain('-1');
        expect(message).not.toContain('[REDACTED]');
    });

    it('falls back to a generic clause when no description is given', () => {
        const anon = post(() => false);
        expect(postconditionMessage('A', 'm', anon, 0)).toContain('its postcondition');
    });
});
