import {Log} from './Log';
import {setValueDisclosure, resetValueDisclosure} from '../Core/redaction';
import {Sensitive} from '../Sensitive/Sensitive';
import {resetRegistry} from '../Core/ContractRegistry';

/**
 * Tests for `@Log` — BUG-13 (totality/identity) and BUG-18 (safe-by-default emission).
 *
 * Moved from `promise/Memoize.test.ts` when `@Memoize` was removed with the `rxjs` dependency.
 * The BUG-13 identity/totality assertions are carried over; the value-rendering assertions changed
 * with BUG-18 — `@Log` no longer emits raw values by default — and the cases that exercise
 * `safeStringify`'s cycle/BigInt handling now do so under `setValueDisclosure('all')`, which is the
 * only path on which a raw value is rendered at all.
 */

// ---------------------------------------------------------------------------
// Identity — BUG-13, the same class of defect BUG-7 fixed for the contract path
// ---------------------------------------------------------------------------

describe('Log — wrapper identity (BUG-13)', () => {
    class Identified {
        @Log()
        computeThing(a: number, b: number): number {
            return a + b;
        }
    }

    it('keeps the method name on a logged wrapper', () => {
        // Both `@Log` and the since-removed `@Memoize` used to hand-roll
        // `descriptor.value = function (...args)`, which does NOT get named by inference —
        // assignment to a member expression is not named evaluation. The wrapper reported `''`.
        expect(Identified.prototype.computeThing.name).toBe('computeThing');
    });

    it('reports the original source from toString, which parameter-name recovery reads', () => {
        // SMELL-1 recovers parameter names by parsing `Function.prototype.toString`. A wrapper
        // reporting its own source degrades every later message to the wrapper's signature.
        expect(Identified.prototype.computeThing.toString()).toContain('computeThing');
    });

    it('still reports arity 0, which belongs to the factory (P1.6), not to this decorator', () => {
        // Pinned rather than endorsed. Moving onto MethodDecoratorFactory buys `.name` and
        // `toString`; `length` is deliberately not restored there yet, so it is unchanged here.
        expect(Identified.prototype.computeThing.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// @Log — BUG-13
// ---------------------------------------------------------------------------

describe('Log', () => {
    let lines: string[];
    let spy: jest.SpyInstance;

    beforeEach(() => {
        lines = [];
        spy = jest.spyOn(console, 'log').mockImplementation((line: any) => {
            lines.push(String(line));
        });
    });

    afterEach(() => {
        spy.mockRestore();
        resetValueDisclosure();
    });

    it('returns a circular value intact instead of throwing out of the logger', () => {
        // The circular-safety of `safeStringify` (BUG-13) is exercised on the only path that renders
        // a raw value — disclosure on. The method-does-not-break guarantee holds on every path.
        setValueDisclosure('all');

        class Store {
            @Log()
            build(): any {
                const node: any = {id: 1};
                node.self = node;
                return node;
            }
        }

        // The defect: `JSON.stringify(result)` raised `TypeError: Converting circular
        // structure to JSON` from inside the logger and destroyed the method's return. A
        // logging decorator must never decide whether a method succeeds.
        const result = new Store().build();

        expect(result.id).toBe(1);
        expect(result.self).toBe(result);
        expect(lines[0]).toContain('[Circular]');
    });

    it('calls the method at all when an ARGUMENT is circular', () => {
        let ran = false;

        class Store {
            @Log()
            accept(_value: any): string {
                ran = true;
                return 'ok';
            }
        }

        const cyclic: any = {};
        cyclic.self = cyclic;

        // Worse than the recorded symptom: the argument line was built BEFORE the call, so a
        // circular argument meant the method never ran.
        expect(new Store().accept(cyclic)).toBe('ok');
        expect(ran).toBe(true);
    });

    it('does not mislabel a value shared by two siblings as circular', () => {
        setValueDisclosure('all');

        class Store {
            @Log()
            build(): any {
                const shared = {v: 1};
                return {left: shared, right: shared};
            }
        }

        new Store().build();

        // A DAG is not a cycle. The flat "already seen" version of this guard gets it wrong.
        expect(lines[0]).not.toContain('[Circular]');
        expect(lines[0]).toContain('"left":{"v":1}');
        expect(lines[0]).toContain('"right":{"v":1}');
    });

    it('survives a BigInt, which JSON.stringify also refuses', () => {
        setValueDisclosure('all');

        // Reached through `globalThis` because the project targets es2019, whose lib has no
        // `BigInt` declaration; the runtime has had it since Node 10.
        const makeBigInt: (v: string) => any = (globalThis as any).BigInt;

        class Store {
            @Log()
            big(): any {
                return {amount: makeBigInt('9007199254740993')};
            }
        }

        expect(() => new Store().big()).not.toThrow();
        expect(lines[0]).toContain('9007199254740993n');
    });

    it('logs the call as structure with values redacted by default (BUG-18)', () => {
        class Store {
            @Log()
            add(a: number, b: number): number {
                return a + b;
            }
        }

        // The method still returns normally; the log carries the parameter *names* and a redacted
        // placeholder for every value — no raw argument or return leaves the process by default.
        expect(new Store().add(2, 3)).toBe(5);
        expect(lines).toEqual(['Call: add(a=[REDACTED], b=[REDACTED]) => [REDACTED]']);
    });

    it('discloses argument and return values under setValueDisclosure(all)', () => {
        setValueDisclosure('all');

        class Store {
            @Log()
            add(a: number, b: number): number {
                return a + b;
            }
        }

        expect(new Store().add(2, 3)).toBe(5);
        expect(lines).toEqual(['Call: add(a=2, b=3) => 5']);
    });

    it('reports every parameter position by name, so an undefined argument cannot vanish', () => {
        setValueDisclosure('all');

        class Store {
            @Log()
            take(_a: any, _b: any): string {
                return 'x';
            }
        }

        new Store().take(undefined, 1);

        // The old failure: `[undefined, 1].map(JSON.stringify).join()` rendered ',1' and the first
        // argument silently vanished. Naming every position makes that impossible.
        expect(lines[0]).toBe('Call: take(_a=undefined, _b=1) => "x"');
    });

    it('logs a throw and re-throws it unchanged', () => {
        const boom = new Error('nope');

        class Store {
            @Log()
            fail(): never {
                throw boom;
            }
        }

        // The original logged only on the success path, so a failing call left no trace —
        // the case a reader of the log is most likely looking for.
        expect(() => new Store().fail()).toThrow(boom);
        expect(lines[0]).toBe('Call: fail() threw Error: nope');
    });

    it('does not fail the method when the console sink itself throws', () => {
        spy.mockImplementation(() => {
            throw new Error('sink is broken');
        });

        class Store {
            @Log()
            work(): string {
                return 'done';
            }
        }

        expect(new Store().work()).toBe('done');
    });

    it('preserves `this` and passes arguments through unchanged', () => {
        class Store {
            label = 'store';
            seen: any[] = [];

            @Log()
            take(...args: any[]): string {
                this.seen.push(args);
                return this.label;
            }
        }

        const store = new Store();
        const arg = {id: 1};

        expect(store.take('a', arg)).toBe('store');
        expect(store.seen).toEqual([['a', arg]]);
        expect(store.seen[0][1]).toBe(arg);
    });

    it('refuses to decorate anything that is not a method', () => {
        expect(() => (Log() as any)({}, 'notAMethod', {value: undefined} as PropertyDescriptor)).toThrow(
            TypeError,
        );
    });
});

// ---------------------------------------------------------------------------
// @Log — safe-by-default emission (BUG-18, DEC-025 / DEC-PII-1)
// ---------------------------------------------------------------------------

describe('Log — redaction (BUG-18, DEC-PII-1)', () => {
    let lines: string[];
    let spy: jest.SpyInstance;

    beforeEach(() => {
        lines = [];
        spy = jest.spyOn(console, 'log').mockImplementation((line: any) => {
            lines.push(String(line));
        });
    });

    afterEach(() => {
        spy.mockRestore();
        resetValueDisclosure();
        resetRegistry();
    });

    it('is safe by default with NO @Sensitive anywhere — the annotation is not load-bearing (DEC-025)', () => {
        // The load-bearing test. This class marks nothing. Its argument values still never appear in
        // the log by default — safety does not depend on anyone remembering `@Sensitive`.
        class Accounts {
            @Log()
            transfer(amount: number, accountId: string, ssn: string): string {
                return `${accountId}:${ssn}`;
            }
        }

        new Accounts().transfer(500, 'ACC-1', '123-45-6789');

        expect(lines[0]).not.toContain('123-45-6789');
        expect(lines[0]).not.toContain('ACC-1');
        expect(lines[0]).not.toContain('500');
        expect(lines[0]).toBe(
            'Call: transfer(amount=[REDACTED], accountId=[REDACTED], ssn=[REDACTED]) => [REDACTED]',
        );
    });

    it('keeps a @Sensitive parameter redacted even with disclosure ON — @Sensitive vetoes disclosure', () => {
        setValueDisclosure('all');

        class Accounts {
            @Log()
            transfer(amount: number, @Sensitive() ssn: string): string {
                return `ok`;
            }
        }

        new Accounts().transfer(500, '123-45-6789');

        // Non-sensitive value is disclosed; the @Sensitive one stays redacted despite disclosure.
        expect(lines[0]).toContain('amount=500');
        expect(lines[0]).toContain('ssn=[REDACTED]');
        expect(lines[0]).not.toContain('123-45-6789');
    });

    it('keeps every value of a @Sensitive class redacted with disclosure ON', () => {
        setValueDisclosure('all');

        @Sensitive()
        class PaymentInstrument {
            @Log()
            charge(pan: string, amount: number): string {
                return 'charged';
            }
        }

        new PaymentInstrument().charge('4111111111111111', 42);

        expect(lines[0]).toContain('pan=[REDACTED]');
        expect(lines[0]).toContain('amount=[REDACTED]');
        expect(lines[0]).toContain('=> [REDACTED]');
        expect(lines[0]).not.toContain('4111111111111111');
    });
});
