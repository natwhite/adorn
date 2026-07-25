/**
 * O1a — the shared settling classifier (`settle`), the corrected `Settlement<T>` arity (Q-24/R1).
 *
 * `settle` is the single classifier `@Time`, a future `@Observe`, and the `@adorn/otel` span adapter
 * all ride, so these pin the value-XOR-error mapping the adapter binds to: exactly one `onSettle`, a
 * settled `value` on success and the thrown `error` on failure, the `sync`/`promise`/`observable` kinds,
 * and the rxjs-absent `settled: false` honest refusal. `@Time`'s own suites (`Time.test.ts`,
 * `Time.rxjs-absent.test.ts`) prove the extraction preserved every observable behaviour.
 */

import {settle, Settlement} from './settle';

/** Spins on the same clock `settle` measures with, so the duration assertions are not cross-clock. */
function busyWait(ms: number): void {
    const clock =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? () => performance.now()
            : () => Date.now();
    const until = clock() + ms;
    while (clock() < until) {
        /* spin */
    }
}

describe('settle — synchronous', () => {
    it('hands back the value and reports a returned/sync settlement', () => {
        const seen: Settlement<number>[] = [];
        const out = settle(() => 42, s => seen.push(s));

        expect(out).toBe(42);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({outcome: 'returned', value: 42, kind: 'sync', settled: true});
        expect(seen[0].outcome === 'returned' && seen[0].value).toBe(42);
        expect(typeof seen[0].durationMs).toBe('number');
    });

    it('measures the operation itself, not ~0 (the thunk runs inside settle)', () => {
        const seen: Settlement<string>[] = [];
        settle(() => {
            busyWait(30);
            return 'done';
        }, s => seen.push(s));

        // A result-taking classifier would see the value after the 30ms already elapsed and report ~0.
        expect(seen[0].durationMs).toBeGreaterThanOrEqual(30 * 0.8);
    });

    it('hands over a synchronous throw before re-throwing it', () => {
        const boom = new Error('sync boom');
        const seen: Settlement<never>[] = [];

        expect(() =>
            settle<never>(() => {
                throw boom;
            }, s => seen.push(s)),
        ).toThrow(boom);

        expect(seen).toHaveLength(1);
        expect(seen[0].outcome).toBe('threw');
        expect(seen[0].outcome === 'threw' && seen[0].error).toBe(boom);
        expect(seen[0].kind).toBe('sync');
        expect(seen[0].settled).toBe(true);
    });

    it('invokes onSettle exactly once', () => {
        let calls = 0;
        settle(() => 1, () => calls++);
        expect(calls).toBe(1);
    });
});

describe('settle — promises', () => {
    it('reports on resolve, after the promise settles, and returns a real Promise', async () => {
        // T is the operation's return (a Promise), so the value slot is typed Promise<T> — the same
        // detail @Time lives with by ignoring the value. `any` keeps the runtime assertions honest.
        const seen: Settlement<any>[] = [];
        const returned = settle(() => Promise.resolve('ok'), s => seen.push(s));

        expect(typeof (returned as Promise<string>).then).toBe('function');
        expect(seen).toHaveLength(0); // nothing until it settles

        await returned;
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({outcome: 'returned', value: 'ok', kind: 'promise', settled: true});
    });

    it('reports on rejection and propagates the original reason', async () => {
        const boom = new Error('async boom');
        const seen: Settlement<any>[] = [];

        await expect(
            settle<Promise<never>>(() => Promise.reject(boom), s => seen.push(s)),
        ).rejects.toBe(boom);

        expect(seen[0].outcome).toBe('threw');
        expect(seen[0].outcome === 'threw' && seen[0].error).toBe(boom);
        expect(seen[0].kind).toBe('promise');
    });

    it('assimilates a hand-rolled thenable into a real Promise (SMELL-15)', async () => {
        const seen: Settlement<any>[] = [];
        const returned = settle(
            () => ({then: (resolve: (v: string) => void) => resolve('assimilated')}),
            s => seen.push(s),
        );

        await expect(returned as any).resolves.toBe('assimilated');
        expect(seen[0].kind).toBe('promise');
    });
});

describe('settle — observables with rxjs absent (SMELL-16)', () => {
    it('passes the source through by identity, unsubscribed, flagged settled:false', () => {
        let subscribed = 0;
        const source = {
            subscribe() {
                subscribed++;
                return {unsubscribe() {}};
            },
        };

        const seen: Settlement<any>[] = [];
        const returned = settle(() => source, s => seen.push(s));

        // No rxjs to wrap with → the caller's own object is returned, never subscribed.
        expect(returned).toBe(source);
        expect(subscribed).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            outcome: 'returned',
            kind: 'observable',
            settled: false,
            durationMs: 0,
        });
    });
});
