/**
 * `@Returns` — the reified, projectable postcondition decorator (DEC-033), against the registry's
 * read API. The twin of `Ensures.test.ts`: it records a *descriptor* into the reserved `post` band and
 * installs nothing, so these pin recording, ordering, the bare-predicate rejection (the descriptor
 * band's defining rule), the non-method rejection, and the missing-`@Contract()` diagnostic.
 */

import {Returns} from './Returns';
import {getContract, getEffectiveReturnConstraints, resetRegistry} from '../Core/ContractRegistry';
import {GreaterThan, GreaterThanEqual, LessThanEqual} from '../Contracts/number';
import {
    flushContractDiagnostics,
    resetContractDiagnostics,
    setContractDiagnosticsSink,
} from '../Adapters/legacy/ContractDiagnostics';

beforeEach(() => {
    resetRegistry();
    resetContractDiagnostics();
});
afterEach(resetContractDiagnostics);

describe('@Returns — records a descriptor into the reserved `post` band, does not install', () => {
    it('records the descriptor into the return band, checkable by its own predicate', () => {
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(): number {
                return 0;
            }
        }
        void Ledger;

        const post = getContract(Ledger.prototype, 'balance')!.post;
        expect(post).toHaveLength(1);
        expect(post[0].constraint).toBe('min');
        expect(post[0].predicate(5)).toBe(true);
        expect(post[0].predicate(-1)).toBe(false);
    });

    it('lands multiple @Returns on one method in declaration order (prepend normalises __decorate)', () => {
        class C {
            @Returns(GreaterThanEqual(1))
            @Returns(LessThanEqual(100))
            m(): number {
                return 1;
            }
        }
        void C;

        expect(getContract(C.prototype, 'm')!.post.map(d => d.constraint)).toEqual(['min', 'max']);
    });

    it('conjoins a subclass @Returns with the base, base-most first (free via the post union)', () => {
        class Base {
            @Returns(GreaterThan(0))
            make(): number {
                return 1;
            }
        }
        class Sub extends Base {
            @Returns(LessThanEqual(100))
            make(): number {
                return 1;
            }
        }
        void Sub;

        expect(getEffectiveReturnConstraints(Sub.prototype, 'make').map(d => d.constraint)).toEqual([
            'greaterThan',
            'max',
        ]);
    });

    it('leaves the property descriptor untouched (recording only, no wrapper installed)', () => {
        const original = function m() {
            return 1;
        };
        const descriptor: PropertyDescriptor = {value: original, writable: true, configurable: true};
        const result = (Returns(GreaterThanEqual(0)) as any)({}, 'm', descriptor);
        expect(result.value).toBe(original);
    });

    it('fires the missing-@Contract() diagnostic (recorded-but-unenforced)', () => {
        const warnings: string[] = [];
        setContractDiagnosticsSink(m => warnings.push(m));

        class Forgotten {
            @Returns(GreaterThan(0))
            compute(): number {
                return -1;
            }
        }
        void Forgotten;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Forgotten');
    });

    it('rejects a bare predicate — the descriptor band accepts only ConstraintDescriptors', () => {
        // The rule that makes the reified band projectable: a closure has no identity or params.
        expect(() => Returns((() => true) as never)).toThrow(TypeError);
        expect(() => Returns(undefined as never)).toThrow(/ConstraintDescriptor/);
    });

    it('rejects a non-string description', () => {
        expect(() => Returns(GreaterThanEqual(0), 42 as never)).toThrow(/description/);
    });

    it('throws when applied to a non-method', () => {
        const accessor: PropertyDescriptor = {get: () => 1, configurable: true};
        expect(() => (Returns(GreaterThanEqual(0)) as any)({}, 'prop', accessor)).toThrow(
            /must be applied to a method/,
        );
    });
});
