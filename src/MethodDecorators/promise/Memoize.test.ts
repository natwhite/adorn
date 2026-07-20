import {defer, Observable, of, Subject} from 'rxjs';
import {Log, Memoize} from './Memoize';

/**
 * Tests for `Memoize` — BUG-3 (prototype-level cache, shared across instances, ignoring
 * arguments) and BUG-5 (the commented-out return-type check).
 *
 * Two counters run throughout, and the distinction between them is the point:
 *
 *  - `bodyRuns` counts entries into the decorated method body, i.e. **cache misses**.
 *  - `producerRuns` counts executions of the cold producer inside the returned Observable,
 *    i.e. **subscriptions**.
 *
 * Keeping them apart is what lets these tests assert that caching happens without eager
 * subscription: a call that misses the cache increments the first and not the second.
 */
class Service {
    bodyRuns = 0;
    producerRuns = 0;
    readonly seenArgs: any[][] = [];

    constructor(readonly label: string = 'svc') {
    }

    @Memoize()
    fetch(...args: any[]): Observable<string> {
        this.bodyRuns++;
        this.seenArgs.push(args);
        const forCall = this.bodyRuns;
        return defer(() => {
            this.producerRuns++;
            return of(`${this.label}:${forCall}`);
        });
    }
}

/** Subscribes and returns the synchronously-delivered values. */
function collect<T>(source: Observable<T>): T[] {
    const values: T[] = [];
    source.subscribe(value => values.push(value));
    return values;
}

describe('Memoize — argument keying (BUG-3)', () => {
    it('caches per argument list rather than returning one value for everything', () => {
        const service = new Service();

        const a = service.fetch('a');
        const b = service.fetch('b');

        // The original ignored `args` entirely and would hand back the same Observable here.
        expect(a).not.toBe(b);
        expect(service.bodyRuns).toBe(2);
        expect(collect(a)).toEqual(['svc:1']);
        expect(collect(b)).toEqual(['svc:2']);
    });

    it('returns the identical Observable for a repeated argument list', () => {
        const service = new Service();

        const first = service.fetch('a');
        const second = service.fetch('a');

        expect(second).toBe(first);
        expect(service.bodyRuns).toBe(1);
    });

    it('keys on every argument, not just the first', () => {
        const service = new Service();

        service.fetch('a', 1);
        service.fetch('a', 2);
        expect(service.bodyRuns).toBe(2);

        service.fetch('a', 1);
        expect(service.bodyRuns).toBe(2);
    });

    it('distinguishes arity: no arguments is not the same as one undefined argument', () => {
        const service = new Service();

        service.fetch();
        service.fetch(undefined);

        expect(service.bodyRuns).toBe(2);
    });

    it('keeps values apart that would collide under naive stringification', () => {
        const service = new Service();

        service.fetch(1);
        service.fetch('1');
        service.fetch(null);
        service.fetch(undefined);
        service.fetch(true);
        service.fetch('true');

        expect(service.bodyRuns).toBe(6);
    });

    it('separates 0 from -0, and treats NaN as equal to itself', () => {
        const service = new Service();

        service.fetch(0);
        service.fetch(-0);
        expect(service.bodyRuns).toBe(2);

        // SameValueZero would merge 0/-0; a cache wants them distinct because the producer
        // can observe the difference. NaN, by contrast, must hit its own entry rather than
        // missing forever, which `===` keying would do.
        service.fetch(NaN);
        service.fetch(NaN);
        expect(service.bodyRuns).toBe(3);
    });

    it('keys objects structurally, independent of property order', () => {
        const service = new Service();

        service.fetch({id: 1, name: 'x'});
        service.fetch({name: 'x', id: 1});

        // Two distinct object literals. Identity keying (lodash's default) would miss here,
        // which is the behaviour callers most often report as a memoize bug.
        expect(service.bodyRuns).toBe(1);
    });

    it('distinguishes objects that differ in a nested value', () => {
        const service = new Service();

        service.fetch({page: {size: 10}});
        service.fetch({page: {size: 20}});

        expect(service.bodyRuns).toBe(2);
    });

    it('distinguishes instances of different classes with identical fields', () => {
        class Cat {
            constructor(readonly name: string) {
            }
        }

        class Dog {
            constructor(readonly name: string) {
            }
        }

        const service = new Service();
        service.fetch(new Cat('rex'));
        service.fetch(new Dog('rex'));

        expect(service.bodyRuns).toBe(2);
    });

    it('keys arrays by contents and does not confuse them with their elements', () => {
        const service = new Service();

        service.fetch(['a', 'b']);
        service.fetch(['a', 'b']);
        expect(service.bodyRuns).toBe(1);

        service.fetch('a', 'b');
        expect(service.bodyRuns).toBe(2);
    });

    it('handles a self-referential argument without recursing forever', () => {
        const service = new Service();
        const cyclic: any = {id: 1};
        cyclic.self = cyclic;

        expect(() => service.fetch(cyclic)).not.toThrow();
        service.fetch(cyclic);

        expect(service.bodyRuns).toBe(1);
    });

    it('keys a value shared between two siblings structurally, not as a cycle', () => {
        const service = new Service();
        const shared = {v: 1};

        // A DAG is not a cycle: `left` and `right` must key the same as two equal literals,
        // so the cycle guard has to unwind as it returns rather than accumulate.
        service.fetch({left: shared, right: shared});
        service.fetch({left: {v: 1}, right: {v: 1}});

        expect(service.bodyRuns).toBe(1);
    });

    it('keys a Map by its entries rather than as structurally empty (BUG-11)', () => {
        const service = new Service();

        // The defect: `Map` keeps its entries in internal slots, so `Object.keys` reports
        // nothing and every Map keyed as `obj:Map{}`. These two calls returned the SAME
        // cached Observable — a wrong answer, not a missing one.
        service.fetch(new Map([[1, 'a']]));
        service.fetch(new Map());
        expect(service.bodyRuns).toBe(2);

        service.fetch(new Map([[1, 'b']]));
        expect(service.bodyRuns).toBe(3);

        // Equal contents still hit, and insertion order does not split the entry.
        service.fetch(new Map([[1, 'a']]));
        expect(service.bodyRuns).toBe(3);

        service.fetch(new Map<any, any>([['x', 1], ['y', 2]]));
        service.fetch(new Map<any, any>([['y', 2], ['x', 1]]));
        expect(service.bodyRuns).toBe(4);
    });

    it('keys a Set by its members rather than as structurally empty (BUG-11)', () => {
        const service = new Service();

        service.fetch(new Set([1, 2]));
        service.fetch(new Set());
        expect(service.bodyRuns).toBe(2);

        service.fetch(new Set([1, 2, 3]));
        expect(service.bodyRuns).toBe(3);

        service.fetch(new Set([2, 1]));
        expect(service.bodyRuns).toBe(3);
    });

    it('does not confuse a Map with a Set or a plain object of the same shape', () => {
        const service = new Service();

        service.fetch(new Map([['a', 1]]));
        service.fetch(new Set(['a']));
        service.fetch({a: 1});

        expect(service.bodyRuns).toBe(3);
    });

    it('keys typed arrays by their contents and element type (BUG-11)', () => {
        const service = new Service();

        service.fetch(new Uint8Array([1, 2, 3]));
        service.fetch(new Uint8Array([1, 2, 4]));
        expect(service.bodyRuns).toBe(2);

        service.fetch(new Uint8Array([1, 2, 3]));
        expect(service.bodyRuns).toBe(2);

        // Same bytes, different element type: not interchangeable arguments.
        service.fetch(new Int8Array([1, 2, 3]));
        expect(service.bodyRuns).toBe(3);

        service.fetch(new Uint8Array([]));
        expect(service.bodyRuns).toBe(4);
    });

    it('keys an ArrayBuffer, and a DataView by its own window', () => {
        const service = new Service();

        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);

        service.fetch(buffer);
        service.fetch(new ArrayBuffer(4));
        expect(service.bodyRuns).toBe(2);

        // Two views onto different regions of one buffer must not collide.
        service.fetch(new DataView(buffer, 0, 2));
        service.fetch(new DataView(buffer, 2, 2));
        expect(service.bodyRuns).toBe(4);
    });

    it('falls back to identity for an exotic built-in rather than keying it as empty (BUG-11)', () => {
        const service = new Service();

        // A `Promise` has no own enumerable keys either, so the generic branch keyed every
        // one of them alike. Identity means two distinct promises miss — which is a cost, not
        // a correctness failure, and is the right side of that trade.
        const first = Promise.resolve(1);
        const second = Promise.resolve(2);

        service.fetch(first);
        service.fetch(second);
        expect(service.bodyRuns).toBe(2);

        service.fetch(first);
        expect(service.bodyRuns).toBe(2);

        // Same for errors: `message` and `stack` are own but non-enumerable.
        service.fetch(new Error('a'));
        service.fetch(new Error('b'));
        expect(service.bodyRuns).toBe(4);
    });

    it('still keys ordinary class instances structurally', () => {
        class Point {
            constructor(readonly x: number, readonly y: number) {
            }
        }

        const service = new Service();

        // The identity fallback is scoped to native exotic objects; a user class is
        // `[object Object]` and must keep hitting the cache on equal fields.
        service.fetch(new Point(1, 2));
        service.fetch(new Point(1, 2));
        expect(service.bodyRuns).toBe(1);

        service.fetch(new Point(1, 3));
        expect(service.bodyRuns).toBe(2);
    });

    it('does not retain the arguments it keyed on', () => {
        const service = new Service();
        const big = {payload: 'x'};

        service.fetch(big);

        // Only the derived string key is stored, so a large argument is not pinned by the
        // cache. Reachability is not directly observable, so this asserts the proxy for it:
        // mutating the argument afterwards cannot disturb the entry it already produced.
        (big as any).payload = 'mutated';
        service.fetch({payload: 'x'});

        expect(service.bodyRuns).toBe(1);
    });
});

describe('Memoize — per-instance storage (BUG-3)', () => {
    it('does not share a cache between two instances', () => {
        const first = new Service('first');
        const second = new Service('second');

        const a = first.fetch('k');
        const b = second.fetch('k');

        // The original stored on `target`, the prototype, so `b` was `a` and `second`'s body
        // never ran at all.
        expect(a).not.toBe(b);
        expect(first.bodyRuns).toBe(1);
        expect(second.bodyRuns).toBe(1);
        expect(collect(a)).toEqual(['first:1']);
        expect(collect(b)).toEqual(['second:1']);
    });

    it('leaves no cache state on the instance or the prototype', () => {
        const service = new Service();
        service.fetch('k');

        expect(Object.keys(service)).not.toContain('fetchCacheMember');
        expect(Object.getOwnPropertyNames(service)).toEqual(
            expect.not.arrayContaining(['fetchCacheMember']),
        );
        expect(Object.getOwnPropertyNames(Service.prototype)).toEqual(
            expect.not.arrayContaining(['fetchCacheMember']),
        );
    });

    it('gives a subclass instance its own cache', () => {
        class Extended extends Service {
        }

        const base = new Service('base');
        const derived = new Extended('derived');

        expect(base.fetch('k')).not.toBe(derived.fetch('k'));
        expect(base.bodyRuns).toBe(1);
        expect(derived.bodyRuns).toBe(1);
    });

    it('keeps separate caches for two decorated methods on one instance', () => {
        class TwoMethods {
            aRuns = 0;
            bRuns = 0;

            @Memoize()
            alpha(key: string): Observable<string> {
                this.aRuns++;
                return of('alpha:' + key);
            }

            @Memoize()
            beta(key: string): Observable<string> {
                this.bRuns++;
                return of('beta:' + key);
            }
        }

        const instance = new TwoMethods();

        // Same argument, different methods: one must not satisfy the other.
        expect(collect(instance.alpha('k'))).toEqual(['alpha:k']);
        expect(collect(instance.beta('k'))).toEqual(['beta:k']);
        expect(instance.aRuns).toBe(1);
        expect(instance.bRuns).toBe(1);
    });

    it('caches per constructor for a static method', () => {
        class Statics {
            static runs = 0;

            @Memoize()
            static load(key: string): Observable<string> {
                Statics.runs++;
                return of(key);
            }
        }

        const first = Statics.load('k');
        expect(Statics.load('k')).toBe(first);
        expect(Statics.load('other')).not.toBe(first);
        expect(Statics.runs).toBe(2);
    });
});

describe('Memoize — coldness and Observable semantics', () => {
    it('does not subscribe when the method is called', () => {
        const service = new Service();

        service.fetch('k');

        // The whole hazard: caching a *value* would need an eager subscription here, firing
        // the producer's side effects before the caller asked for them.
        expect(service.bodyRuns).toBe(1);
        expect(service.producerRuns).toBe(0);
    });

    it('does not subscribe when a cached entry is read back', () => {
        const service = new Service();

        service.fetch('k');
        service.fetch('k');
        service.fetch('k');

        expect(service.producerRuns).toBe(0);
    });

    it('runs the producer once and replays to later subscribers', () => {
        const service = new Service();
        const source = service.fetch('k');

        expect(collect(source)).toEqual(['svc:1']);
        expect(service.producerRuns).toBe(1);

        expect(collect(source)).toEqual(['svc:1']);
        expect(collect(service.fetch('k'))).toEqual(['svc:1']);
        expect(service.producerRuns).toBe(1);
    });

    it('runs each distinct argument list its own single time', () => {
        const service = new Service();

        collect(service.fetch('a'));
        collect(service.fetch('b'));
        collect(service.fetch('a'));

        expect(service.producerRuns).toBe(2);
    });

    it('returns a real Observable, not a resolved value', () => {
        const service = new Service();
        const source = service.fetch('k');

        expect(source).toBeInstanceOf(Observable);
        expect(typeof source.subscribe).toBe('function');
    });

    it('passes the arguments through to the method body unchanged', () => {
        const service = new Service();
        const arg = {id: 1};

        service.fetch('a', 2, arg);

        expect(service.seenArgs).toEqual([['a', 2, arg]]);
        expect(service.seenArgs[0][2]).toBe(arg);
    });

    it('preserves `this` inside the decorated method', () => {
        const service = new Service('bound');

        expect(collect(service.fetch('k'))).toEqual(['bound:1']);
    });

    it('caches nothing when the method body throws', () => {
        class Failing {
            attempts = 0;

            @Memoize()
            load(): Observable<string> {
                this.attempts++;
                if (this.attempts === 1) throw new Error('transient');
                return of('ok');
            }
        }

        const instance = new Failing();

        expect(() => instance.load()).toThrow('transient');
        expect(collect(instance.load())).toEqual(['ok']);
        expect(instance.attempts).toBe(2);
    });

    /**
     * BUG-10, changed by the BUG-9 swap rather than by a separate decision.
     *
     * This test previously asserted `producerRuns === 1` — a failure was memoized permanently
     * and every later subscriber replayed it, with no way for the caller to retry.
     * `shareReplay` discards its subject when the source errors, so the next subscribe re-runs
     * the producer. Each subscriber still sees the error while the source keeps failing; the
     * difference is that the entry is no longer poisoned for the lifetime of the instance.
     */
    it('re-runs the producer for a subscriber that arrives after an error (BUG-10)', () => {
        class Erroring {
            producerRuns = 0;

            @Memoize()
            load(): Observable<string> {
                return defer(() => {
                    this.producerRuns++;
                    throw new Error('upstream failed');
                });
            }
        }

        const instance = new Erroring();
        const source = instance.load();

        const errors: string[] = [];
        source.subscribe({error: (e: Error) => errors.push(e.message)});
        source.subscribe({error: (e: Error) => errors.push(e.message)});

        expect(errors).toEqual(['upstream failed', 'upstream failed']);
        expect(instance.producerRuns).toBe(2);
    });

    it('caches the recovery once a retried producer succeeds (BUG-10)', () => {
        class Flaky {
            producerRuns = 0;

            @Memoize()
            load(): Observable<string> {
                return defer(() => {
                    this.producerRuns++;
                    if (this.producerRuns === 1) throw new Error('transient');
                    return of('recovered');
                });
            }
        }

        const instance = new Flaky();
        const source = instance.load();

        const errors: string[] = [];
        const values: string[] = [];
        const observer = {
            next: (v: string) => values.push(v),
            error: (e: Error) => errors.push(e.message),
        };

        source.subscribe(observer);
        source.subscribe(observer);
        source.subscribe(observer);

        // One failure, one retry, then the success is replayed like any other cached value —
        // the producer is not re-run a third time.
        expect(errors).toEqual(['transient']);
        expect(values).toEqual(['recovered', 'recovered']);
        expect(instance.producerRuns).toBe(2);
    });

    /**
     * BUG-9, fixed. This test previously pinned the opposite result — `producerRuns` of 2 —
     * as a characterization of `publishReplay() + refCount()`, which tears its connection down
     * at a refcount of zero and lets rxjs 6's `ConnectableObservable` rebuild its stopped
     * subject on the next subscribe. The source was re-executed *and* the stale buffer was
     * still replayed, so the caller got old values plus a second run of the producer's side
     * effects, from a decorator whose only job is to run something once.
     *
     * The inversion is deliberate: it is the visible half of the swap to
     * `shareReplay({bufferSize: Infinity, refCount: false})`.
     */
    it('does not re-run a non-completing source when the refcount drops to zero (BUG-9)', () => {
        let producerRuns = 0;
        let subject: Subject<string>;

        class LiveFeed {
            @Memoize()
            watch(): Observable<string> {
                return defer(() => {
                    producerRuns++;
                    subject = new Subject<string>();
                    return subject;
                });
            }
        }

        const feed = new LiveFeed();
        const source = feed.watch();

        const first = source.subscribe();
        expect(producerRuns).toBe(1);
        subject.next('x');
        first.unsubscribe();

        const replayed: string[] = [];
        source.subscribe(value => replayed.push(value));

        // The producer ran once, and the buffer replayed is the one that producer filled.
        expect(producerRuns).toBe(1);
        expect(replayed).toEqual(['x']);

        // Still live: the resubscribe is attached to the *original* subject, not to a second
        // one built by a re-execution. This is what the old behaviour could not offer.
        subject.next('y');
        expect(replayed).toEqual(['x', 'y']);
    });

    /**
     * The stated cost of `refCount: false`. The source subscription is established on the first
     * subscribe and is never torn down for a source that does not complete, even once every
     * subscriber has gone. Pinned because it is the thing given up in exchange for BUG-9, and a
     * caller memoizing an endless stream needs to know the producer keeps running.
     */
    it('holds the source subscription open after the last unsubscribe (cost of refCount: false)', () => {
        let torndown = 0;

        class Endless {
            @Memoize()
            watch(): Observable<string> {
                return new Observable<string>(() => () => {
                    torndown++;
                });
            }
        }

        const source = new Endless().watch();
        source.subscribe().unsubscribe();

        // `publishReplay() + refCount()` would report 1 here — and that teardown is exactly
        // what made the next subscribe re-execute the source.
        expect(torndown).toBe(0);
    });
});

describe('Memoize — misuse reporting (BUG-5)', () => {
    class Wrong {
        @Memoize()
        aNumber(): any {
            return 42;
        }

        @Memoize()
        nothing(): any {
            return undefined;
        }

        @Memoize()
        aPromise(): any {
            return Promise.resolve('value');
        }

        @Memoize()
        anObject(): any {
            return {value: 'not observable'};
        }
    }

    it('throws at the point of misuse, naming the method and what it returned', () => {
        const instance = new Wrong();

        expect(() => instance.aNumber()).toThrow(TypeError);
        expect(() => instance.aNumber()).toThrow(/must return an Observable/);
        expect(() => instance.aNumber()).toThrow(/'aNumber'/);
        expect(() => instance.aNumber()).toThrow(/number \(42\)/);
    });

    it('reports a missing return value', () => {
        expect(() => new Wrong().nothing()).toThrow(/returned undefined/);
    });

    it('rejects a Promise, which is the likeliest wrong answer', () => {
        // The decorator lives under `MethodDecorators/promise/`, so this mistake is invited.
        expect(() => new Wrong().aPromise()).toThrow(/object \(Promise\)/);
    });

    it('rejects a plain object', () => {
        expect(() => new Wrong().anObject()).toThrow(/object \(Object\)/);
    });

    it('does not cache a rejected return, so a later correct call still works', () => {
        class Flaky {
            calls = 0;

            @Memoize()
            load(): any {
                this.calls++;
                return this.calls === 1 ? 'not an observable' : of('recovered');
            }
        }

        const instance = new Flaky();

        expect(() => instance.load()).toThrow(TypeError);
        expect(collect(instance.load())).toEqual(['recovered']);
    });

    it('accepts a duck-typed observable from a second copy of rxjs', () => {
        // `instanceof` fails across duplicate rxjs installs, so the check duck-types as well.
        const foreign = {
            subscribe: (observer: any) => {
                observer.next('foreign');
                observer.complete();
            },
            pipe: () => of('piped'),
        };

        class Interop {
            @Memoize()
            load(): any {
                return foreign;
            }
        }

        expect(() => new Interop().load()).not.toThrow();
    });

    it('rejects an object with subscribe but no pipe', () => {
        // `pipe` is required because the decorator calls it; accepting this would only move
        // the failure one line later, which is the defect being fixed.
        const halfObservable = {subscribe: () => undefined};

        class HalfInterop {
            @Memoize()
            load(): any {
                return halfObservable;
            }
        }

        expect(() => new HalfInterop().load()).toThrow(/must return an Observable/);
    });

    it('refuses to decorate anything that is not a method', () => {
        expect(() =>
            Memoize()({}, 'notAMethod', {value: undefined} as PropertyDescriptor),
        ).toThrow(/only on services methods/);

        expect(() =>
            Memoize()({}, 'getter', {get: () => 1} as PropertyDescriptor),
        ).toThrow(/only on services methods/);

        // Previously only falsy `value` was rejected, so a non-callable truthy value slipped
        // through and failed obscurely at the first call.
        expect(() =>
            Memoize()({}, 'aString', {value: 'not callable'} as PropertyDescriptor),
        ).toThrow(/only on services methods/);
    });
});

// ---------------------------------------------------------------------------
// Identity — BUG-13, the same class of defect BUG-7 fixed for the contract path
// ---------------------------------------------------------------------------

describe('Memoize and Log — wrapper identity (BUG-13)', () => {
    class Identified {
        @Memoize()
        loadThing(key: string, other: number): Observable<string> {
            return of(key + other);
        }

        @Log()
        computeThing(a: number, b: number): number {
            return a + b;
        }
    }

    it('keeps the method name on a memoized wrapper', () => {
        // Both decorators used to hand-roll `descriptor.value = function (...args)`, which
        // does NOT get named by inference — assignment to a member expression is not named
        // evaluation. The wrapper reported `''`.
        expect(Identified.prototype.loadThing.name).toBe('loadThing');
    });

    it('keeps the method name on a logged wrapper', () => {
        expect(Identified.prototype.computeThing.name).toBe('computeThing');
    });

    it('reports the original source from toString, which parameter-name recovery reads', () => {
        // SMELL-1 recovers parameter names by parsing `Function.prototype.toString`. A wrapper
        // reporting its own source degrades every later message to the wrapper's signature.
        expect(Identified.prototype.loadThing.toString()).toContain('loadThing');
        expect(Identified.prototype.computeThing.toString()).toContain('computeThing');
    });

    it('still reports arity 0, which belongs to the factory (P1.6), not to these decorators', () => {
        // Pinned rather than endorsed. Moving onto MethodDecoratorFactory buys `.name` and
        // `toString`; `length` is deliberately not restored there yet, so it is unchanged here.
        expect(Identified.prototype.loadThing.length).toBe(0);
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
        expect(() =>
            (Log() as any)({}, 'notAMethod', {value: undefined} as PropertyDescriptor),
        ).toThrow(TypeError);
    });
});
