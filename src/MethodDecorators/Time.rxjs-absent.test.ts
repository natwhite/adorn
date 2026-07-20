/**
 * `@Time` with rxjs genuinely absent.
 *
 * This is the case that now matters most: adorn depends on rxjs **not at all**, so for the great
 * majority of consumers `require('rxjs')` inside `loadObservable()` will throw `MODULE_NOT_FOUND`
 * and the Observable branch has to degrade rather than fail. `Time.test.ts` cannot cover this — it
 * installs a virtual `rxjs` mock, and `loadObservable()` caches its lookup for the lifetime of the
 * module, so the two states cannot coexist in one file.
 *
 * Nothing here is simulated. There is no `rxjs` in `node_modules`, so the `require` fails for real.
 * These tests would start passing vacuously if rxjs were ever reinstated as a dependency, so the
 * first one asserts the precondition outright instead of assuming it.
 */

import {Time, setTimingSink, TimingRecord} from './Time';

let records: TimingRecord[];

beforeEach(() => {
    records = [];
    setTimingSink(record => records.push(record));
});

afterEach(() => setTimingSink(null));

/** A duck-typed observable. `@Time` never checks for anything more than `subscribe`. */
function makeSource(onSubscribe: (sink: any) => void) {
    return {
        subscribe(sink: any) {
            onSubscribe(sink);
            return {
                unsubscribe() {
                    /* nothing to tear down */
                },
            };
        },
    };
}

describe('rxjs is genuinely absent', () => {
    it('cannot resolve rxjs at all — the precondition every test below depends on', () => {
        // Without this, a reinstated rxjs would make the whole file pass for the wrong reason.
        expect(() => require.resolve('rxjs')).toThrow(/Cannot find module/);
    });

    it("hands back the caller's own object, unwrapped", () => {
        const source = makeSource(() => {
            /* not subscribed by the decorator */
        });

        class Task {
            @Time()
            work() {
                return source;
            }
        }

        // With no Observable constructor there is nothing to wrap with, so the source must pass
        // through by identity. Substituting some invented stand-in would be worse than not timing.
        expect(new Task().work()).toBe(source);
    });

    it('does not subscribe to the source', () => {
        let subscribed = 0;
        const source = makeSource(() => {
            subscribed++;
        });

        class Task {
            @Time()
            work() {
                return source;
            }
        }

        new Task().work();

        // Coldness is preserved for the same reason it is when rxjs *is* present: subscribing to
        // measure would run the producer an extra time and double its side effects.
        expect(subscribed).toBe(0);
    });

    it('flags the measurement as unsettled rather than reporting a plausible-looking zero', () => {
        class Task {
            @Time()
            work() {
                return makeSource(() => undefined);
            }
        }

        new Task().work();

        expect(records).toHaveLength(1);
        expect(records[0].kind).toBe('observable');
        // `settled: false` is the whole point: a sink must be able to tell "I did not measure this"
        // apart from "this took no time", which a bare 0 cannot express.
        expect(records[0].settled).toBe(false);
        expect(records[0].durationMs).toBe(0);
    });

    it('still measures synchronous and promise-returning methods normally', async () => {
        class Task {
            @Time()
            sync() {
                return 'done';
            }

            @Time()
            async later() {
                await new Promise(resolve => setTimeout(resolve, 20));
                return 'ok';
            }
        }

        const task = new Task();
        expect(task.sync()).toBe('done');
        expect(await task.later()).toBe('ok');

        // The absence of rxjs must not degrade the paths that never needed it — this is what makes
        // `@Time` usable by a consumer who has never heard of Observables.
        expect(records.map(record => record.kind)).toEqual(['sync', 'promise']);
        expect(records.every(record => record.settled)).toBe(true);
    });
});
