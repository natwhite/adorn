import {Log} from './Log';

/**
 * Tests for `@Log` — BUG-13.
 *
 * Moved from `promise/Memoize.test.ts` when `@Memoize` was removed with the `rxjs` dependency.
 * Every assertion below is carried over unchanged; only the `@Memoize` halves of the shared
 * identity block were dropped, since that decorator no longer exists.
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

    afterEach(() => spy.mockRestore());

    it('returns a circular value intact instead of throwing out of the logger', () => {
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

    it('logs the call and its return value', () => {
        class Store {
            @Log()
            add(a: number, b: number): number {
                return a + b;
            }
        }

        expect(new Store().add(2, 3)).toBe(5);
        expect(lines).toEqual(['Call: add(2,3) => 5']);
    });

    it('reports an undefined argument rather than swallowing it', () => {
        class Store {
            @Log()
            take(_a: any, _b: any): string {
                return 'x';
            }
        }

        new Store().take(undefined, 1);

        // `[undefined, 1].map(JSON.stringify).join()` renders as ',1' — the argument silently
        // vanished from the line.
        expect(lines[0]).toBe('Call: take(undefined,1) => "x"');
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
