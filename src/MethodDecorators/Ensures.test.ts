import {Ensures} from './Ensures';
import {getPostconditions, resetRegistry} from '../Core/ContractRegistry';
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

describe('@Ensures — records, does not install', () => {
    it('records the closure and its description into the postcondition band', () => {
        class Wallet {
            @Ensures((balance, amount) => (balance as number) >= (amount as number), 'balance covers it')
            withdraw(amount: number): number {
                return amount;
            }
        }
        void Wallet;

        const posts = getPostconditions(Wallet.prototype, 'withdraw');
        expect(posts).toHaveLength(1);
        expect(posts[0].description).toBe('balance covers it');
        expect(posts[0].predicate(10, 5)).toBe(true);
        expect(posts[0].predicate(3, 5)).toBe(false);
    });

    it('lands multiple @Ensures on one method in declaration order', () => {
        class C {
            @Ensures(() => true, 'first')
            @Ensures(() => true, 'second')
            m(): void {}
        }
        void C;

        expect(getPostconditions(C.prototype, 'm').map(p => p.description)).toEqual(['first', 'second']);
    });

    it('leaves the descriptor untouched (recording only, no wrapper)', () => {
        const original = function m() {
            return 1;
        };
        const descriptor: PropertyDescriptor = {value: original, writable: true, configurable: true};
        const result = (Ensures(() => true) as any)({}, 'm', descriptor);
        expect(result.value).toBe(original);
    });

    it('fires the missing-@Contract() diagnostic (recorded-but-unenforced)', () => {
        const warnings: string[] = [];
        setContractDiagnosticsSink(m => warnings.push(m));

        class Forgotten {
            @Ensures(r => (r as number) > 0, 'positive')
            compute(): number {
                return -1;
            }
        }
        void Forgotten;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Forgotten');
    });

    it('throws when the predicate is not a function', () => {
        expect(() => Ensures(undefined as never)).toThrow(TypeError);
    });

    it('throws when applied to a non-method', () => {
        const accessor: PropertyDescriptor = {get: () => 1, configurable: true};
        expect(() => (Ensures(() => true) as any)({}, 'prop', accessor)).toThrow(
            /must be applied to a method/,
        );
    });
});
