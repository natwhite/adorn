/**
 * Dual-copy singleton safety (DEC-095).
 *
 * adorn's mutable process state (the contract registry, the observation sink, the call-id sequence, …) lives
 * in a `globalThis`-keyed slot so that two LOADED COPIES of adorn — an app that `import`s the ESM build while
 * a dependency `require`s the CJS build, or two physical installs — share one backing store. Without that, each
 * copy gets its own empty registry: a `@Contract` recorded through one copy is invisible to the evaluator
 * reached through the other, and enforcement silently no-ops.
 *
 * We simulate "two copies" with `jest.isolateModules`: each block gets a FRESH module registry (fresh
 * module-level bindings, so the exported functions are different instances), while the real `globalThis` — and
 * therefore the slot — persists across both. If the slot works, copy B sees copy A's writes. Copy B loads a
 * subpath entry (`adorn/introspection`, `adorn/observe`) because the reads moved there in the DEC-097 curation;
 * every adorn module shares the same slot regardless of entry point.
 */
import {Contract, GreaterThanEqual, setObservationSink} from '../index';
import {getContractsForClass} from '../introspection';
import {getObservationSink, nextCallId} from '../observe';

describe('dual-copy singleton sharing (DEC-095)', () => {
    it('a contract recorded through one copy is visible to a second, isolated copy', () => {
        @Contract()
        class Thing {
            m(@GreaterThanEqual(1) n: number): number {
                return n;
            }
        }

        // Copy A (the normal import) recorded the contract at class-definition time.
        const viaA = getContractsForClass(Thing);
        expect(viaA.length).toBeGreaterThan(0);

        // Copy B: a fresh, isolated load of the introspection entry — different module instances, same slot.
        let introspectionB: typeof import('../introspection') | undefined;
        jest.isolateModules(() => {
            introspectionB = require('../introspection');
        });
        expect(introspectionB).toBeDefined();

        // It really is a different copy (a distinct function object)...
        expect(introspectionB!.getContractsForClass).not.toBe(getContractsForClass);
        // ...yet its registry read sees copy A's registration, because the backing store is shared.
        const viaB = introspectionB!.getContractsForClass(Thing);
        expect(viaB.length).toBe(viaA.length);
    });

    it('the observation sink is shared across copies', () => {
        let observeB: typeof import('../observe') | undefined;
        jest.isolateModules(() => {
            observeB = require('../observe');
        });

        const spy = {};
        setObservationSink(spy as never);
        // A sink installed through copy A (root) is the one copy B (observe entry) reads.
        expect(observeB!.getObservationSink()).toBe(spy);
        setObservationSink(null);
        expect(observeB!.getObservationSink()).not.toBe(spy);
    });

    it('the call-id sequence is one monotonic counter across copies', () => {
        let observeB: typeof import('../observe') | undefined;
        jest.isolateModules(() => {
            observeB = require('../observe');
        });

        const a1 = nextCallId();
        const b1 = observeB!.nextCallId();
        const a2 = nextCallId();
        // Interleaving the two copies' calls still yields strictly increasing ids — one shared sequence,
        // not two that could collide (the DEC-077 guarantee, now holding across copies too).
        expect(b1).toBeGreaterThan(a1);
        expect(a2).toBeGreaterThan(b1);
    });
});
