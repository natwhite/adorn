/**
 * BUG-14, type half — `design:paramtypes` reaching the registry from the real decorator path.
 *
 * Separate from `ParameterDecoratorFactory.test.ts` because `reflect-metadata` patches the realm's
 * `Reflect` and so flips every decorated class in the process onto `__decorate`'s `Reflect.decorate`
 * branch. Jest gives each test file its own registry and realm, so the sibling file genuinely runs
 * without it — which is the only way to tell "the type is absent because the toolchain supplied none"
 * apart from "the type is absent because nothing reads it".
 *
 * Both branches matter for a second reason (DEC-005): the metadata emit and the parameter decorators
 * travel in the *same* `__decorate` decorator array, applied back-to-front. If the ordering were the
 * other way round, `design:paramtypes` would not yet be set when a parameter decorator ran. The
 * signature capture sidesteps that question entirely by reading at install time, and the assertions
 * below pin that it does.
 */

import 'reflect-metadata';

import {GreaterThanEqual, StringMinLength} from '../ParameterDecorators/Constraints';
import {Contract} from './ContractInstaller';
import {getContract} from './ContractRegistry';
import {documentClass} from '../Projections/docs';
import {Enforce} from '../FieldDeocrators/Enforce';
import {getFieldContractsForClass} from './ContractRegistry';

describe('preconditions of this file', () => {
    it('runs on the Reflect.decorate branch with metadata available', () => {
        expect(typeof (Reflect as any).decorate).toBe('function');
        expect(typeof (Reflect as any).getMetadata).toBe('function');
    });
});

describe('parameter types reach the registry and the document', () => {
    @Contract()
    class Order {
        place(@StringMinLength(3) sku: string, @GreaterThanEqual(1) quantity: number) {
            return `${sku}x${quantity}`;
        }
    }

    it('records design:paramtypes against the decorated positions', () => {
        const contract = getContract(Order.prototype, 'place')!;

        expect(contract.params.map(p => p.type)).toEqual([String, Number]);
    });

    it('fills the document Type column that was previously always empty', () => {
        const [method] = documentClass(Order).methods;

        expect(method.parameters.map(p => p.typeName)).toEqual(['String', 'Number']);
    });

    it('carries names and types together, from one install pass', () => {
        const [method] = documentClass(Order).methods;

        expect(method.signature).toBe('Order.place(sku, quantity)');
        expect(method.parameters[0]).toEqual(
            expect.objectContaining({
                index: 0,
                name: 'sku',
                nameRecovered: true,
                typeName: 'String',
            }),
        );
    });

    it('types an UNDECORATED position it named (Q-10)', () => {
        @Contract()
        class Report {
            render(format: string, @GreaterThanEqual(1) pageSize: number) {
                return `${format}${pageSize}`;
            }
        }

        const contract = getContract(Report.prototype, 'render')!;

        // `design:paramtypes` covers the whole signature, not only decorated slots, so a position
        // recovered for arity gets its type for free.
        expect(contract.params.map(p => p.type)).toEqual([String, Number]);
        expect(documentClass(Report).methods[0].parameters[0].typeName).toBe('String');
    });

    it('records the erased Object for a type the emitter cannot represent', () => {
        interface Options {
            verbose: boolean;
        }

        @Contract()
        class Runner {
            run(@GreaterThanEqual(0) attempts: number, options: Options) {
                return attempts + (options ? 1 : 0);
            }
        }

        // NOT a defect and NOT hidden: the emitter erases interfaces, unions, and generics to
        // `Object`. Recording it verbatim is the honest move — the alternative is dropping it, which
        // would make "no type emitted" and "type erased to Object" indistinguishable. Both
        // `ParameterContract.type` and `ParameterDoc.typeName` document the advisory status.
        expect(getContract(Runner.prototype, 'run')!.params.map(p => p.type)).toEqual([Number, Object]);
        expect(documentClass(Runner).methods[0].parameters[1].typeName).toBe('Object');
    });
});

describe('field types reach the registry too (GAP-9)', () => {
    it('records design:type for a contracted field', () => {
        class Basket {
            @Enforce.greaterThan(0)
            itemCount: number = 1;
        }
        void Basket;

        const [field] = getFieldContractsForClass(Basket);

        expect(field.key).toBe('itemCount');
        expect(field.contract.type).toBe(Number);
        expect(field.contract.constraints.map(c => c.constraint)).toEqual(['greaterThan']);
    });
});
