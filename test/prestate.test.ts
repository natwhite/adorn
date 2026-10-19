/**
 * Postcondition pre-state capture (axiform feedback 2026-10-18 §9) — the `old()` mechanism.
 *
 * The hole: a postcondition reads `(result, ...args)` against the POST-call argument state, so a body that
 * mutates an argument can mask its own violation. The fix: a `capture` run at ENTRY whose deep-cloned, frozen
 * result is handed to the predicate as `old`. These tests pin the hazard, the fix across all three paths
 * (contract.checked, contract(), @Ensures), the clone-at-entry soundness, the frozen snapshot, and the
 * loud-failure on a non-cloneable capture.
 */

import {contract, Contract, Ensures} from '../index';
import type {ContractVerdict} from '../index';

// A clamp that ALSO mutates its input to the clamped value — the masking body from axiform's example.
const clampMutating = (box: {raw: number}): number => {
    const clamped = Math.max(0, Math.min(10, box.raw));
    box.raw = clamped; // the mutation that masks a postcondition reading box.raw
    return clamped;
};

function sync<R>(v: ContractVerdict<R> | Promise<ContractVerdict<R>>): ContractVerdict<R> {
    if (v instanceof Promise) throw new Error('expected a synchronous verdict');
    return v;
}

describe('the hazard (§9): without capture, an arg-mutating body masks its own violation', () => {
    it('a postcondition reading the live arg wrongly PASSES because the body overwrote it', () => {
        const checked = contract.checked(
            {ensures: [(result: number, box: {raw: number}) => result === box.raw]},
            clampMutating,
        );
        const v = sync(checked({raw: -1})); // body returns 0 and sets box.raw = 0 → 0 === 0 masks it
        expect(v.ok).toBe(true); // the false-pass the fix exists to prevent
    });
});

describe('the fix (§9): a capture snapshots entry-state, so the violation is caught', () => {
    const spec = {
        ensures: [
            {
                capture: (box: {raw: number}) => ({raw: box.raw}),
                predicate: (result: number, old: {raw: number}) => result === old.raw,
                description: 'result equals the original raw',
                id: 'identity',
            },
        ],
    };

    it('contract.checked: the ensures failure is reported against pre-mutation state', () => {
        const v = sync(contract.checked(spec, clampMutating)({raw: -1}));
        expect(v.ok).toBe(false);
        if (!v.ok && v.band !== 'body') {
            expect(v.band).toBe('ensures');
            expect(v.id).toBe('identity');
            expect(v.value).toBe(0);
        }
    });

    it('contract.checked: a genuinely in-range call still passes', () => {
        const v = sync(contract.checked(spec, clampMutating)({raw: 5}));
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.value).toBe(5);
    });

    it('contract() enforce: the masked violation now THROWS (default policy)', () => {
        const enforced = contract(spec, clampMutating);
        expect(() => enforced({raw: -1})).toThrow();
        expect(enforced({raw: 7})).toBe(7); // in-range passes
    });
});

describe('capture is sound even when it aliases the whole argument (clone-at-entry)', () => {
    it('capture: box => box still snapshots entry-state deeply', () => {
        const checked = contract.checked(
            {
                ensures: [
                    {
                        capture: (box: {raw: number}) => box, // alias — made sound by the deep clone
                        predicate: (result: number, old: {raw: number}) => result === old.raw,
                    },
                ],
            },
            clampMutating,
        );
        const v = sync(checked({raw: -1}));
        expect(v.ok).toBe(false); // old.raw is the pre-mutation -1, not the mutated 0
    });
});

describe('the snapshot is deep-frozen', () => {
    it('old is frozen inside the predicate', () => {
        let frozen: boolean | undefined;
        const checked = contract.checked(
            {
                ensures: [
                    {
                        capture: (box: {raw: number; tags: string[]}) => ({raw: box.raw, tags: box.tags}),
                        predicate: (_result: unknown, old: {tags: string[]}) => {
                            frozen = Object.isFrozen(old) && Object.isFrozen(old.tags);
                            return true;
                        },
                    },
                ],
            },
            (box: {raw: number; tags: string[]}) => box.raw,
        );
        sync(checked({raw: 1, tags: ['a']}));
        expect(frozen).toBe(true);
    });
});

describe('a non-cloneable capture fails loudly at entry', () => {
    it('contract.checked throws a TypeError when capture returns a function', () => {
        const checked = contract.checked(
            {ensures: [{capture: () => () => 0, predicate: () => true}]},
            (n: number) => n,
        );
        expect(() => checked(1)).toThrow(TypeError);
        expect(() => checked(1)).toThrow(/cloneable/i);
    });
});

describe('@Ensures capturing form (decorator path)', () => {
    @Contract()
    class Clamp {
        @Ensures({
            capture: (box: {raw: number}) => ({raw: box.raw}),
            predicate: (result: number, old: {raw: number}) => result === old.raw,
            description: 'result equals the original raw',
        })
        clamp(box: {raw: number}): number {
            return clampMutating(box);
        }
    }

    it('catches the masked violation a live-arg postcondition would miss', () => {
        expect(() => new Clamp().clamp({raw: -1})).toThrow();
    });

    it('passes for an in-range input', () => {
        expect(new Clamp().clamp({raw: 5})).toBe(5);
    });

    it('still accepts the legacy (predicate, description) form', () => {
        @Contract()
        class Plain {
            @Ensures((result: number) => result >= 0, 'non-negative')
            abs(n: number): number {
                return Math.abs(n);
            }
        }
        expect(new Plain().abs(-4)).toBe(4);
    });
});
