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
 */

import {Observable, Subject} from 'rxjs';
import {Time, setTimingSink, TimingRecord} from './Time';

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
        expect(records[0].durationMs).toBeGreaterThanOrEqual(50);
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
        expect(records[0].durationMs).toBeGreaterThanOrEqual(20);
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
        expect(records[0].durationMs).toBeGreaterThanOrEqual(30);
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
                return new Observable<number>(subscriber => {
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
                return new Observable<string>(subscriber => {
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
                expect(records[0].durationMs).toBeGreaterThanOrEqual(50);
                done();
            },
        });
    });

    it('measures until the stream ERRORS, and forwards the error', done => {
        const boom = new Error('stream boom');

        class Task {
            @Time()
            work() {
                return new Observable<never>(subscriber => {
                    setTimeout(() => subscriber.error(boom), 20);
                });
            }
        }

        new Task().work().subscribe({
            error: error => {
                expect(error).toBe(boom);
                expect(records).toHaveLength(1);
                expect(records[0].outcome).toBe('threw');
                expect(records[0].durationMs).toBeGreaterThanOrEqual(20);
                done();
            },
        });
    });

    it('times each subscription independently', done => {
        class Task {
            @Time()
            work() {
                return new Observable<number>(subscriber => {
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
        const subject = new Subject<number>();

        class Task {
            @Time()
            work() { return subject; }
        }

        // Note the wrapper is a plain Observable, so the *returned* value is not a
        // Subject any more — `next` has to be driven through the original.
        new Task().work().subscribe();
        subject.next(1);

        // Not finished, so there is no duration to report. Stated as a property
        // rather than left to be discovered.
        expect(records).toHaveLength(0);
    });

    it('reports nothing when a subscription is abandoned', () => {
        class Task {
            @Time()
            work() {
                return new Observable<number>(subscriber => {
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
