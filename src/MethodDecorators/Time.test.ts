/**
 * P3.4 — `@Time`.
 *
 * The assertion that matters is the async one. A naive implementation times the *call*, which for
 * an `async` method measures how long it took to construct a promise — approximately zero, and worse
 * than no measurement because it looks like an answer. The `>= 50` checks below are what stop that
 * implementation from passing.
 *
 * The second thing under test is coldness: timing an Observable must not subscribe to it, or a cold
 * producer runs twice and its side effects double.
 *
 * ## Why the Observables below are hand-rolled
 *
 * adorn no longer depends on rxjs — it was removed outright along with `@Memoize`, so there is no
 * `rxjs` in `node_modules` to import here. `@Time` keeps its Observable branch as dormant interop
 * (it reaches rxjs only through a guarded lazy `require`), and that branch still needs covering, so
 * the suite supplies its own `Observable` through a **virtual** module mock.
 *
 * **The fidelity this trades, stated plainly.** These tests previously ran against real rxjs 6.5.3
 * and therefore verified genuine interop; they now verify only the contract `@Time` actually relies
 * on — `new Ctor(subscribeFn)`, a subscriber with `next`/`error`/`complete`, and a returned
 * teardown. That contract is small, and `MockObservable` implements it exactly, but a change in
 * rxjs's own behaviour would no longer be caught here. That is a real reduction and is the price of
 * having no rxjs to test against; it is recorded rather than papered over.
 *
 * The genuinely-absent case — no rxjs, no mock — is covered in `Time.rxjs-absent.test.ts`, which
 * cannot live in this file because `loadObservable()` caches its lookup for the module's lifetime.
 */

import {Time, setTimingSink, TimingRecord} from './Time';

/** The subscriber `@Time` is handed. Terminal events are once-only, as in any Observable. */
class MockSubscriber<T = any> {
    private closed = false;

    constructor(private readonly sink: any) {}

    next(value: T): void {
        if (!this.closed && this.sink.next) this.sink.next(value);
    }

    error(err: any): void {
        if (this.closed) return;
        this.closed = true;
        if (this.sink.error) this.sink.error(err);
    }

    complete(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.sink.complete) this.sink.complete();
    }
}

/**
 * The smallest thing satisfying what `@Time` asks of an Observable: cold (the subscribe function
 * runs per subscription, never at construction) and tearing down through the returned function.
 */
class MockObservable<T = any> {
    constructor(private readonly onSubscribe: (subscriber: MockSubscriber<T>) => (() => void) | void) {}

    subscribe(observerOrNext?: any): {unsubscribe: () => void} {
        const sink = typeof observerOrNext === 'function' ? {next: observerOrNext} : (observerOrNext || {});
        const teardown = this.onSubscribe(new MockSubscriber<T>(sink));
        return {
            unsubscribe: () => {
                if (typeof teardown === 'function') teardown();
            },
        };
    }
}

/** A hot, never-completing source with a `next` of its own — enough to stand in for a `Subject`. */
class MockSubject {
    private readonly sinks: any[] = [];

    subscribe(observerOrNext?: any): {unsubscribe: () => void} {
        const sink = typeof observerOrNext === 'function' ? {next: observerOrNext} : (observerOrNext || {});
        this.sinks.push(sink);
        return {
            unsubscribe: () => {
                const at = this.sinks.indexOf(sink);
                if (at >= 0) this.sinks.splice(at, 1);
            },
        };
    }

    next(value: any): void {
        this.sinks.slice().forEach(sink => sink.next && sink.next(value));
    }
}

// `virtual: true` is what makes this possible at all: it mocks a specifier that does not resolve.
// `@Time` reaches rxjs through `require('rxjs')` inside `loadObservable()`, so this is the module it
// finds. The factory is lazy — it runs on first require, long after the classes above initialise.
jest.mock('rxjs', () => ({Observable: MockObservable}), {virtual: true});

let records: TimingRecord[];

beforeEach(() => {
    records = [];
    setTimingSink(record => records.push(record));
});

afterEach(() => setTimingSink(null));

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The lower bound to assert for a method that slept for `ms`.
 *
 * `busyWait` below avoids cross-clock comparison by spinning on the clock `@Time` reads.
 * `sleep` **cannot**: `setTimeout` is scheduled on the platform timer, `@Time` measures with
 * `performance.now()`, and the two are only loosely coupled — so a 50ms sleep can be measured
 * as 49.87ms and fail `>= 50` for reasons that have nothing to do with the code under test.
 * Observed once as a full-suite-only failure at `durationMs >= 50`.
 *
 * The tolerance does not weaken what these tests check. Their purpose, stated in each, is to
 * separate a correct measurement from the naive "time the call" implementation, which reports
 * approximately **zero** for anything asynchronous. A floor of 80% discriminates between ~0 and
 * ~50 exactly as sharply as a floor of 100%, and does not depend on which clock won the race.
 */
function atLeastSlept(ms: number): number {
    return ms * 0.8;
}

/**
 * Spins on the **same clock `@Time` measures with**.
 *
 * Spinning on `Date.now()` while the decorator reads `performance.now()` compares two clocks that
 * are only loosely coupled, so a 50ms spin routinely measures as 49.6ms and the assertion fails for
 * reasons that have nothing to do with the code under test.
 */
function busyWait(ms: number): void {
    const clock = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now();
    const until = clock() + ms;
    while (clock() < until) { /* spin */ }
}

// ---------------------------------------------------------------------------
// Synchronous
// ---------------------------------------------------------------------------

describe('synchronous methods', () => {
    it('measures a method that blocks, and passes the value through', () => {
        class Task {
            @Time()
            work() {
                busyWait(50);
                return 'done';
            }
        }

        expect(new Task().work()).toBe('done');

        expect(records).toHaveLength(1);
        expect(records[0].durationMs).toBeGreaterThanOrEqual(50);
        expect(records[0].kind).toBe('sync');
        expect(records[0].outcome).toBe('returned');
        expect(records[0].settled).toBe(true);
    });

    it('labels the record with Owner.member by default', () => {
        class Task {
            @Time()
            work() { return 1; }
        }

        new Task().work();

        expect(records[0].owner).toBe('Task');
        expect(records[0].member).toBe('work');
        expect(records[0].label).toBe('Task.work');
    });

    it('honours an explicit label', () => {
        class Task {
            @Time({label: 'critical-path'})
            work() { return 1; }
        }

        new Task().work();
        expect(records[0].label).toBe('critical-path');
    });

    it('still reports when the method throws, and rethrows unchanged', () => {
        const boom = new Error('boom');

        class Task {
            @Time()
            work(): never { throw boom; }
        }

        expect(() => new Task().work()).toThrow(boom);
        expect(records).toHaveLength(1);
        expect(records[0].outcome).toBe('threw');
        expect(records[0].settled).toBe(true);
    });

    it('preserves `this`, arguments, and the method name', () => {
        class Task {
            base = 10;

            @Time()
            add(a: number, b: number) { return this.base + a + b; }
        }

        expect(new Task().add(1, 2)).toBe(13);
        expect(Task.prototype.add.name).toBe('add');
    });

    it('measures a static method', () => {
        class Task {
            @Time()
            static parse(input: string) { return input.trim(); }
        }

        expect(Task.parse('  x  ')).toBe('x');
        expect(records[0].owner).toBe('Task');
        expect(records[0].member).toBe('parse');
    });
});

// ---------------------------------------------------------------------------
// Promises — the case a naive implementation gets wrong
// ---------------------------------------------------------------------------

describe('promise-returning methods', () => {
    it('measures until the promise RESOLVES, not until it is created', async () => {
        class Task {
            @Time()
            async work() {
                await sleep(50);
                return 'done';
            }
        }

        expect(await new Task().work()).toBe('done');

        expect(records).toHaveLength(1);
        // The naive "time the call" implementation reports ~0 here.
        expect(records[0].durationMs).toBeGreaterThanOrEqual(atLeastSlept(50));
        expect(records[0].kind).toBe('promise');
        expect(records[0].outcome).toBe('returned');
    });

    it('reports nothing until the promise settles', async () => {
        class Task {
            @Time()
            async work() { await sleep(30); }
        }

        const pending = new Task().work();
        expect(records).toHaveLength(0);

        await pending;
        expect(records).toHaveLength(1);
    });

    it('measures a rejection and propagates the original reason', async () => {
        const boom = new Error('async boom');

        class Task {
            @Time()
            async work() {
                await sleep(20);
                throw boom;
            }
        }

        await expect(new Task().work()).rejects.toBe(boom);

        expect(records).toHaveLength(1);
        expect(records[0].outcome).toBe('threw');
        expect(records[0].durationMs).toBeGreaterThanOrEqual(atLeastSlept(20));
    });

    it('times a hand-rolled thenable, not just a real Promise', async () => {
        class Task {
            @Time()
            work() {
                // A legal thenable whose `then` returns undefined. Calling `.then()`
                // on it directly and returning the result would hand the caller
                // `undefined`; the wrapper assimilates it via `Promise.resolve`.
                return {then: (resolve: (v: string) => void) => { setTimeout(() => resolve('ok'), 30); }};
            }
        }

        await expect(new Task().work() as any).resolves.toBe('ok');
        expect(records).toHaveLength(1);
        expect(records[0].kind).toBe('promise');
        expect(records[0].durationMs).toBeGreaterThanOrEqual(atLeastSlept(30));
    });
});

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

describe('Observable-returning methods', () => {
    it('does NOT subscribe to a cold Observable just to time it', () => {
        let producerRuns = 0;

        class Task {
            @Time()
            work() {
                return new MockObservable<number>(subscriber => {
                    producerRuns++;
                    subscriber.next(1);
                    subscriber.complete();
                });
            }
        }

        const stream = new Task().work();

        // Eager subscription is the single most likely correctness bug in async
        // wrapping (plan risk 4): it duplicates side effects and breaks coldness.
        expect(producerRuns).toBe(0);
        expect(records).toHaveLength(0);

        stream.subscribe();
        expect(producerRuns).toBe(1);
    });

    it('measures until the stream COMPLETES', done => {
        class Task {
            @Time()
            work() {
                return new MockObservable<string>(subscriber => {
                    setTimeout(() => {
                        subscriber.next('value');
                        subscriber.complete();
                    }, 50);
                });
            }
        }

        const seen: string[] = [];
        new Task().work().subscribe({
            next: value => seen.push(value),
            complete: () => {
                expect(seen).toEqual(['value']);
                expect(records).toHaveLength(1);
                expect(records[0].kind).toBe('observable');
                expect(records[0].outcome).toBe('returned');
                expect(records[0].durationMs).toBeGreaterThanOrEqual(atLeastSlept(50));
                done();
            },
        });
    });

    it('measures until the stream ERRORS, and forwards the error', done => {
        const boom = new Error('stream boom');

        class Task {
            @Time()
            work() {
                return new MockObservable<never>(subscriber => {
                    setTimeout(() => subscriber.error(boom), 20);
                });
            }
        }

        new Task().work().subscribe({
            error: error => {
                expect(error).toBe(boom);
                expect(records).toHaveLength(1);
                expect(records[0].outcome).toBe('threw');
                expect(records[0].durationMs).toBeGreaterThanOrEqual(atLeastSlept(20));
                done();
            },
        });
    });

    it('times each subscription independently', done => {
        class Task {
            @Time()
            work() {
                return new MockObservable<number>(subscriber => {
                    subscriber.next(1);
                    subscriber.complete();
                });
            }
        }

        const stream = new Task().work();
        stream.subscribe();
        stream.subscribe();

        setTimeout(() => {
            expect(records).toHaveLength(2);
            done();
        }, 0);
    });

    it('reports nothing for a stream that never terminates', () => {
        const subject = new MockSubject();

        class Task {
            @Time()
            work() { return subject; }
        }

        // Note the wrapper is a plain Observable, so the *returned* value is not a
        // Subject any more — `next` has to be driven through the original. That is the
        // documented normalisation (SMELL-15); pinned here rather than only asserted in prose.
        const returned: any = new Task().work();
        expect(returned).not.toBe(subject);
        expect(typeof returned.next).toBe('undefined');

        returned.subscribe();
        subject.next(1);

        // Not finished, so there is no duration to report. Stated as a property
        // rather than left to be discovered.
        expect(records).toHaveLength(0);
    });

    it('reports nothing when a subscription is abandoned', () => {
        class Task {
            @Time()
            work() {
                return new MockObservable<number>(subscriber => {
                    const handle = setTimeout(() => subscriber.complete(), 1000);
                    return () => clearTimeout(handle);
                });
            }
        }

        new Task().work().subscribe().unsubscribe();
        expect(records).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

describe('sinks', () => {
    it('prefers a per-decorator sink over the global one', () => {
        const local: TimingRecord[] = [];

        class Task {
            @Time({sink: record => local.push(record)})
            work() { return 1; }
        }

        new Task().work();

        expect(local).toHaveLength(1);
        expect(records).toHaveLength(0);
    });

    it('never lets a broken sink become the method\'s failure', () => {
        setTimingSink(() => { throw new Error('sink exploded'); });

        class Task {
            @Time()
            work() { return 'fine'; }
        }

        expect(new Task().work()).toBe('fine');
    });

    it('rejects application to something that is not a method', () => {
        expect(() => {
            class Task {
                // @ts-expect-error — a field is not a valid @Time target
                @Time()
                value = 1;
            }
            void Task;
        }).toThrow(/not a method/);
    });
});
