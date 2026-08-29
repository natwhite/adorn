/**
 * `contract()` — the functional twin of the contract/observation decorators (voice-agent L9, DEC-074).
 * Pins the enforcement (params / requires / returns / ensures), async settling, and the observe emission
 * (completed + violation events, and their order), plus `this` preservation.
 */

import {
    contract,
    setObservationSink,
    setViolationPolicy,
    NumberContracts,
    StringContracts,
} from '../index';
import type {ObservationEvent} from '../index';
import {resetConfiguration, setConfigurationSink} from '../src/Core/Configuration';

type ViolationEvent = Extract<ObservationEvent, {kind: 'violation'}>;

describe('contract() — per-parameter descriptors', () => {
    it('rejects a bad argument and accepts a good one (same predicate as Verify.check)', () => {
        const f = contract({params: [NumberContracts.Between(1, 7)]}, (n: number) => n * 2);
        expect(() => f(99)).toThrow(/between 1 and 7/i);
        expect(f(3)).toBe(6);
    });

    it('skips a null hole (an unconstrained argument)', () => {
        const f = contract({params: [null, StringContracts.NotEmpty()]}, (_a: unknown, b: string) => b);
        expect(f({anything: true}, 'ok')).toBe('ok');
        expect(() => f({}, '')).toThrow();
    });
});

describe('contract() — requires (preconditions), same oracle as @Requires', () => {
    it('throws before the body runs when a precondition fails', () => {
        let ran = false;
        const f = contract({requires: [(a: number, b: number) => a < b]}, (a: number, b: number) => {
            ran = true;
            return a + b;
        });
        expect(() => f(5, 1)).toThrow(/precondition/i);
        expect(ran).toBe(false);
        expect(f(1, 5)).toBe(6);
        expect(ran).toBe(true);
    });

    it('carries a description into the message', () => {
        const f = contract(
            {requires: [{predicate: (a: number) => a > 0, description: 'a must be positive'}]},
            (a: number) => a,
        );
        expect(() => f(-1)).toThrow(/a must be positive/);
    });
});

describe('contract() — returns + ensures (postconditions)', () => {
    it('rejects a return that fails the return descriptor', () => {
        const f = contract({returns: NumberContracts.GreaterThanEqual(0)}, (n: number) => n);
        expect(() => f(-1)).toThrow();
        expect(f(5)).toBe(5);
    });

    it('throws AFTER the body when an ensures fails (the body ran)', () => {
        let ran = false;
        const f = contract({ensures: [(result: number) => result > 0]}, (n: number) => {
            ran = true;
            return n;
        });
        expect(() => f(-1)).toThrow(/postcondition/i);
        expect(ran).toBe(true);
    });
});

describe('contract() — async (settles before the return/postcondition band)', () => {
    it('resolves a valid async return and rejects on a postcondition failure', async () => {
        const good = contract({returns: NumberContracts.GreaterThanEqual(0)}, async (n: number) => n);
        await expect(good(5)).resolves.toBe(5);

        const bad = contract({ensures: [(r: number) => r > 0]}, async (n: number) => n);
        await expect(bad(-1)).rejects.toThrow(/postcondition/i);
    });

    it('a body that rejects skips the postconditions and propagates its own error', async () => {
        let checked = false;
        const f = contract(
            {ensures: [() => ((checked = true), true)]},
            async () => {
                throw new Error('boom');
            },
        );
        await expect(f()).rejects.toThrow('boom');
        expect(checked).toBe(false);
    });
});

describe('contract() — observe emits into the installed ObservationSink', () => {
    let events: ObservationEvent[] = [];
    beforeEach(() => {
        events = [];
        setObservationSink({record: e => events.push(e)});
    });
    afterEach(() => setObservationSink(null));

    it('emits one completed event carrying the declared span kind and name, on success', () => {
        const f = contract({observe: {kind: 'client', name: 'svc.do'}}, (n: number) => n);
        expect(f(3)).toBe(3);
        const completed = events.filter(e => e.kind === 'completed');
        expect(completed).toHaveLength(1);
        expect(completed[0].observation.name).toBe('svc.do');
        expect(completed[0].observation.kind).toBe('client');
    });

    it('emits a violation and NO completed when a precondition fails (body never ran)', () => {
        const f = contract({requires: [(n: number) => n > 0], observe: {name: 'svc.do'}}, (n: number) => n);
        expect(() => f(-1)).toThrow();
        expect(events.filter(e => e.kind === 'violation')).toHaveLength(1);
        expect(events.filter(e => e.kind === 'completed')).toHaveLength(0);
    });

    it('emits completed THEN violation when a postcondition fails (the method returned, then was refused)', () => {
        const f = contract({ensures: [(r: number) => r > 0], observe: {name: 'svc.do'}}, (n: number) => n);
        expect(() => f(-1)).toThrow();
        expect(events.map(e => e.kind)).toEqual(['completed', 'violation']);
    });

    it('a descriptor param failure emits value-free ViolationFacts (via violationFromCheck)', () => {
        const f = contract({params: [NumberContracts.Between(1, 7)], observe: {name: 'svc.do'}}, (n: number) => n);
        expect(() => f(99)).toThrow();
        const v = events.find(e => e.kind === 'violation') as ViolationEvent | undefined;
        expect(v).toBeDefined();
        expect(v?.violation.constraint).toBeTruthy();
        expect(v?.violation.blame).toBe('caller');
    });
});

describe('contract() — this binding and empty spec', () => {
    it('preserves this and is a no-op wrapper when the spec is empty', () => {
        const obj = {
            factor: 3,
            run: contract({}, function (this: {factor: number}, n: number): number {
                return n * this.factor;
            }),
        };
        expect(obj.run(2)).toBe(6);
    });
});

describe('contract() honours the violation policy (DEC-080)', () => {
    afterEach(resetConfiguration);

    it("under 'warn', a failing precondition proceeds into the body and returns the value", () => {
        setConfigurationSink(() => {}); // swallow the warn line
        setViolationPolicy('warn');
        let ran = false;
        const f = contract({requires: [(a: number, b: number) => a < b]}, (a: number, b: number) => {
            ran = true;
            return a + b;
        });
        expect(f(5, 1)).toBe(6); // a<b fails, but warn proceeds into the body
        expect(ran).toBe(true);
    });

    it("under 'warn', a failing per-parameter check proceeds with the offending argument", () => {
        setConfigurationSink(() => {});
        setViolationPolicy('warn');
        const f = contract({params: [NumberContracts.Between(1, 7)]}, (n: number) => n * 2);
        expect(f(99)).toBe(198); // 99 is out of range, but warn proceeds with it
    });

    it("under 'warn', a failing postcondition returns the (violating) value", () => {
        setConfigurationSink(() => {});
        setViolationPolicy('warn');
        const f = contract({ensures: [(r: number) => r >= 0]}, (n: number) => n);
        expect(f(-5)).toBe(-5); // r>=0 fails, but warn returns the settled value
    });

    it("under 'warn', a failing return descriptor returns the value", () => {
        setConfigurationSink(() => {});
        setViolationPolicy('warn');
        const f = contract({returns: NumberContracts.GreaterThanEqual(0)}, (n: number) => n);
        expect(f(-5)).toBe(-5);
    });

    it('routes to a handler with the site blame (caller for a precondition, callee for a postcondition)', () => {
        const seen: Array<{blame: string; member: string}> = [];
        setViolationPolicy((_violation, site) => seen.push({blame: site.blame, member: site.member}));
        const pre = contract({requires: [(a: number) => a > 0]}, function precheck(a: number) {
            return a;
        });
        const post = contract({ensures: [(r: number) => r > 0]}, function postcheck(n: number) {
            return n;
        });
        pre(-1); // handler returns (suppresses) -> no throw
        post(-1);
        expect(seen).toEqual([
            {blame: 'caller', member: 'precheck'},
            {blame: 'callee', member: 'postcheck'},
        ]);
    });

    it("keeps throwing under the default 'throw' policy (regression)", () => {
        const f = contract({requires: [(a: number, b: number) => a < b]}, (a: number, b: number) => a + b);
        expect(() => f(5, 1)).toThrow(/precondition/i);
    });
});
