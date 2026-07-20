import {defer, Observable, of, Subject} from 'rxjs';
import {Memoize} from './Memoize';

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

    it('replays a cached error rather than re-running the producer', () => {
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

        // Failures are cached alongside successes. Worth pinning: it is a consequence of
        // caching the Observable rather than the outcome, and it is what makes @Memoize
        // unsuitable for a call the caller expects to be able to retry.
        expect(errors).toEqual(['upstream failed', 'upstream failed']);
        expect(instance.producerRuns).toBe(1);
    });

    /**
     * Characterization, not endorsement. `publishReplay() + refCount()` tears its connection
     * down when the subscriber count reaches zero, and rxjs 6's `ConnectableObservable`
     * rebuilds a stopped subject on the next subscribe — so a source that has NOT completed
     * is re-executed while the old buffer is still replayed. Completing sources (the usual
     * HTTP case, covered above) are unaffected.
     *
     * Pinned so that swapping in `shareReplay({refCount: false})` is a deliberate, visible
     * decision rather than a silent behaviour change under a refactor.
     */
    it('re-runs a non-completing source if the refcount drops to zero (known wart)', () => {
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

        expect(producerRuns).toBe(2);
        expect(replayed).toEqual(['x']);
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
