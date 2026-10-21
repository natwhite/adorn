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
 * therefore the slot — persists across both. If the slot works, copy B sees copy A's writes.
 */
import {
    Contract,
    GreaterThanEqual,
    getContractsForClass,
    setObservationSink,
    getObservationSink,
    nextCallId,
} from '../index';

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

        // Copy B: a fresh, isolated load of adorn — different module instances, same globalThis slot.
        let adornB: typeof import('../index') | undefined;
        jest.isolateModules(() => {
            adornB = require('../index');
        });
        expect(adornB).toBeDefined();

        // It really is a different copy (a distinct function object)...
        expect(adornB!.getContractsForClass).not.toBe(getContractsForClass);
        // ...yet its registry read sees copy A's registration, because the backing store is shared.
        const viaB = adornB!.getContractsForClass(Thing);
        expect(viaB.length).toBe(viaA.length);
    });

    it('the observation sink is shared across copies', () => {
        let adornB: typeof import('../index') | undefined;
        jest.isolateModules(() => {
            adornB = require('../index');
        });

        const spy = {};
        setObservationSink(spy as never);
        // A sink installed through copy A is the one copy B reads.
        expect(adornB!.getObservationSink()).toBe(spy);
        setObservationSink(null);
        expect(adornB!.getObservationSink()).not.toBe(spy);
    });

    it('the call-id sequence is one monotonic counter across copies', () => {
        let adornB: typeof import('../index') | undefined;
        jest.isolateModules(() => {
            adornB = require('../index');
        });

        const a1 = nextCallId();
        const b1 = adornB!.nextCallId();
        const a2 = nextCallId();
        // Interleaving the two copies' calls still yields strictly increasing ids — one shared sequence,
        // not two that could collide (the DEC-077 guarantee, now holding across copies too).
        expect(b1).toBeGreaterThan(a1);
        expect(a2).toBeGreaterThan(b1);
    });
});
