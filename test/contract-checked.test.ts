/**
 * `contract.checked` — the non-throwing, structured per-call VERDICT (axiform feedback 2026-10-18 §1/§2/§5/§6).
 *
 * The verdict is the product: `{ok, value}` on success; `{ok:false, band, index, id?, facts, value?, message}`
 * for a contract failure; `{ok:false, band:'body', error}` for a thrown body. It consults NO global state —
 * no violation policy, no observation sink — and carries the settled value (§2), the clause `id` (§5), the
 * localized `path` on its facts (§4), and (with `{evaluate:'all'}`) every failure (§6). Its facts are built by
 * the SAME builders the enforcing `contract()` uses, so the two cannot drift.
 */

import {
    contract,
    setObservationSink,
    getObservationSink,
    ObjectContracts,
    NumberContracts,
    StringContracts,
    RETURN_INDEX,
} from '../index';
import type {ContractVerdict, ObservationSink, ObservationEvent} from '../index';

// Narrow a (possibly async) verdict to the sync arm for assertions.
function sync<R>(v: ContractVerdict<R> | Promise<ContractVerdict<R>>): ContractVerdict<R> {
    if (v instanceof Promise) throw new Error('expected a synchronous verdict');
    return v;
}

describe('contract.checked — success', () => {
    it('returns {ok:true, value, durationMs} and runs the body exactly once', () => {
        let calls = 0;
        const add = contract.checked(
            {params: [NumberContracts.Finite(), NumberContracts.Finite()], returns: NumberContracts.Finite()},
            (a: number, b: number) => {
                calls++;
                return a + b;
            },
        );
        const v = sync(add(2, 3));
        expect(v.ok).toBe(true);
        if (v.ok) {
            expect(v.value).toBe(5);
            expect(typeof v.durationMs).toBe('number');
            expect(v.durationMs).toBeGreaterThanOrEqual(0);
        }
        expect(calls).toBe(1);
    });
});

describe('contract.checked — pre-call failures short-circuit the body', () => {
    it('a params failure: band "params", index, facts, NO value, body NOT run', () => {
        let calls = 0;
        const f = contract.checked({params: [NumberContracts.Finite()]}, (n: number) => {
            calls++;
            return n;
        });
        const v = sync(f('nope' as unknown as number));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('params');
            expect(v.index).toBe(0);
            expect(typeof v.message).toBe('string');
            expect(v.facts.blame).toBe('caller');
            expect('value' in v).toBe(false); // body did not run
        }
        expect(calls).toBe(0);
    });

    it('a requires failure carries the clause index and its declared id (§5)', () => {
        const f = contract.checked(
            {
                requires: [{predicate: (a: number, b: number) => a < b, description: 'a < b', id: 'ordered'}],
            },
            (a: number, b: number) => a + b,
        );
        const v = sync(f(5, 1));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('requires');
            expect(v.index).toBe(0);
            expect(v.id).toBe('ordered');
            expect(v.facts.blame).toBe('caller');
        }
    });

    it('forwards the localized path of a compositional params failure (§4)', () => {
        const f = contract.checked(
            {params: [ObjectContracts.Fields({name: StringContracts.NotEmpty(), age: NumberContracts.Between(0, 120)})]},
            (_rec: {name: string; age: number}) => 'ok',
        );
        const v = sync(f({name: 'ok', age: 999}));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('params');
            expect(v.facts.path).toBeDefined();
            expect(v.facts.path && v.facts.path.length).toBeGreaterThan(0);
        }
    });
});

describe('contract.checked — post-call failures carry the settled value (§2)', () => {
    it('a returns-descriptor failure: band "returns", RETURN_INDEX, value present', () => {
        const f = contract.checked({returns: NumberContracts.Between(0, 10)}, (n: number) => n);
        const v = sync(f(42));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('returns');
            expect(v.index).toBe(RETURN_INDEX);
            expect(v.value).toBe(42); // the contract-violating return is recoverable
            expect(v.facts.blame).toBe('callee');
        }
    });

    it('an ensures failure: band "ensures", id, value present', () => {
        const f = contract.checked(
            {ensures: [{predicate: (r: number) => r >= 0, description: 'non-negative', id: 'nonneg'}]},
            (n: number) => n,
        );
        const v = sync(f(-7));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('ensures');
            expect(v.id).toBe('nonneg');
            expect(v.value).toBe(-7);
        }
    });

    it('the reified returns band is checked BEFORE the ensures closure (DEC-033)', () => {
        const f = contract.checked(
            {returns: NumberContracts.Between(0, 10), ensures: [{predicate: (r: number) => r < 100}]},
            (n: number) => n,
        );
        const v = sync(f(500)); // violates both; returns must win
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') expect(v.band).toBe('returns');
    });
});

describe('contract.checked — a thrown body is captured, never swallowed or re-thrown', () => {
    it('band "body" carries the error and skips the post bands', () => {
        const boom = new Error('kaboom');
        const f = contract.checked({ensures: [{predicate: () => true}]}, () => {
            throw boom;
        });
        const v = sync(f());
        expect(v.ok).toBe(false);
        if (!v.ok && v.band === 'body') {
            expect(v.error).toBe(boom);
            expect(typeof v.durationMs).toBe('number');
        } else {
            throw new Error('expected a body verdict');
        }
    });
});

describe('contract.checked — {evaluate:"all"} reports every failure (§6)', () => {
    it('collects all failing ensures clauses; failures[0] equals the top-level', () => {
        const f = contract.checked(
            {
                ensures: [
                    {predicate: (r: number) => r > 0, id: 'positive'},
                    {predicate: (r: number) => r % 2 === 0, id: 'even'},
                    {predicate: (r: number) => r < 1000, id: 'small'},
                ],
            },
            (n: number) => n,
            {evaluate: 'all'},
        );
        const v = sync(f(-3)); // fails 'positive' and 'even', passes 'small'
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.failures).toBeDefined();
            expect(v.failures!.map(x => x.id)).toEqual(['positive', 'even']);
            // the top-level failure is the first
            expect(v.id).toBe(v.failures![0].id);
            expect(v.band).toBe(v.failures![0].band);
            expect(v.value).toBe(-3);
        }
    });

    it('default (first) mode reports only the first failure, with no failures[] list', () => {
        const f = contract.checked(
            {ensures: [{predicate: (r: number) => r > 0, id: 'positive'}, {predicate: (r: number) => r % 2 === 0, id: 'even'}]},
            (n: number) => n,
        );
        const v = sync(f(-3));
        if (!v.ok && v.band !== 'body') {
            expect(v.id).toBe('positive');
            expect(v.failures).toBeUndefined();
        }
    });
});

describe('contract.checked — async returns a promise of the same verdict', () => {
    it('resolves to {ok:true} for a satisfied async contract', async () => {
        const f = contract.checked(
            {returns: NumberContracts.Finite()},
            async (n: number) => n * 2,
        );
        const v = await f(21);
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.value).toBe(42);
    });

    it('resolves to an ensures failure (never rejects) for a violated async postcondition', async () => {
        const f = contract.checked(
            {ensures: [{predicate: (r: number) => r >= 0}]},
            async (n: number) => n,
        );
        const v = await f(-1);
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('ensures');
            expect(v.value).toBe(-1);
        }
    });

    it('captures an async rejection as a body verdict, never a rejected promise', async () => {
        const boom = new Error('async-boom');
        const f = contract.checked({}, async () => {
            throw boom;
        });
        const v = await f();
        expect(v.ok).toBe(false);
        if (!v.ok && v.band === 'body') expect(v.error).toBe(boom);
        else throw new Error('expected a body verdict');
    });
});

describe('contract.checked — no global state (§1)', () => {
    let previous: ObservationSink | undefined;
    let events: ObservationEvent[];

    beforeEach(() => {
        previous = getObservationSink();
        events = [];
        setObservationSink({record: e => events.push(e)});
    });
    afterEach(() => {
        setObservationSink(previous ?? null);
    });

    it('never emits to the observation sink, even when the spec sets observe, and never throws under the default policy', () => {
        const f = contract.checked(
            {params: [NumberContracts.Finite()], observe: {name: 'svc.do'}},
            (n: number) => n,
        );
        // The default policy throws for the enforcing path; checked must simply return a verdict.
        const v = sync(f('bad' as unknown as number));
        expect(v.ok).toBe(false);
        expect(events).toHaveLength(0); // the sink saw nothing
    });
});

describe('contract.checked — no drift vs the enforcing path', () => {
    it('the verdict facts equal the facts the enforcing contract emits for the same failure', () => {
        const spec = {
            params: [NumberContracts.Between(1, 10)],
            observe: {name: 'svc.op'},
        } as const;

        // Enforcing path: capture the emitted violation facts under a 'warn'-style recording sink.
        const emitted: ObservationEvent[] = [];
        const previous = getObservationSink();
        setObservationSink({record: e => emitted.push(e)});
        try {
            const enforced = contract(spec, (n: number) => n);
            try {
                enforced(99); // out of range → emits then throws (default policy)
            } catch {
                /* expected */
            }
        } finally {
            setObservationSink(previous ?? null);
        }
        const emittedViolation = emitted.find(e => e.kind === 'violation');
        expect(emittedViolation).toBeDefined();

        // Checked path: the same failure as a verdict.
        const v = sync(contract.checked(spec, (n: number) => n)(99));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body' && emittedViolation && emittedViolation.kind === 'violation') {
            expect(v.facts).toEqual(emittedViolation.violation);
        }
    });
});
