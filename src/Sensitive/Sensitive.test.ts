/**
 * Tests for the `@Sensitive` marker (DEC-PII-1/2).
 *
 * The marker is record-only, so these assert on the recorded markings via the registry's sensitivity
 * band, and on the two properties that make it a genuine foundation: it is inheritance-safe in the
 * DEC-021 sense (a subclass cannot un-mark), and it never pollutes the enforcement/projection bands.
 *
 * Classes are declared *inside* each test (SMELL-18 convention) so the suite is independent of
 * registry accumulation order.
 */

import 'reflect-metadata';
import {Sensitive} from './Sensitive';
import {
    getClassSensitivity,
    getEffectiveClassSensitivity,
    getEffectiveFieldSensitivity,
    getFieldContract,
    getFieldContractsForClass,
    getFieldSensitivity,
    getParameterSensitivity,
} from '../Core/ContractRegistry';
import {Enforce} from '../FieldDeocrators/Enforce';

describe('@Sensitive — recording', () => {
    it('marks a field, recorded against the prototype under the property key', () => {
        class Customer {
            @Sensitive() ssn = '';
            name = '';
        }

        expect(getFieldSensitivity(Customer.prototype, 'ssn')).toEqual({level: 'sensitive'});
        // An unmarked sibling is not sensitive.
        expect(getFieldSensitivity(Customer.prototype, 'name')).toBeUndefined();
        // And the effective (inheritance-aware) read agrees for the flat case.
        expect(getEffectiveFieldSensitivity(Customer.prototype, 'ssn')).toEqual({level: 'sensitive'});
    });

    it('marks a method parameter, index-keyed', () => {
        class AuditService {
            record(actor: string, @Sensitive() ssn: string): void {
                void actor;
                void ssn;
            }
        }

        expect(getParameterSensitivity(AuditService.prototype, 'record', 1)).toEqual({level: 'sensitive'});
        expect(getParameterSensitivity(AuditService.prototype, 'record', 0)).toBeUndefined();
    });

    it('marks a static method parameter against the constructor', () => {
        class Tokens {
            static issue(@Sensitive() secret: string): string {
                return secret;
            }
        }

        expect(getParameterSensitivity(Tokens, 'issue', 0)).toEqual({level: 'sensitive'});
    });

    it('marks a whole class, and every field of it reads as sensitive', () => {
        @Sensitive()
        class PaymentInstrument {
            pan = '';
            expiry = '';
        }

        expect(getClassSensitivity(PaymentInstrument)).toEqual({level: 'sensitive'});
        // Class-level marking sensitises every field read through the class.
        expect(getEffectiveFieldSensitivity(PaymentInstrument.prototype, 'pan')).toEqual({
            level: 'sensitive',
        });
        expect(getEffectiveFieldSensitivity(PaymentInstrument.prototype, 'expiry')).toEqual({
            level: 'sensitive',
        });
    });

    it('defaults the marking to {level: "sensitive"} — the forward-compatible object shape', () => {
        class Account {
            @Sensitive() balance = 0;
        }

        const marking = getFieldSensitivity(Account.prototype, 'balance');
        expect(marking).toEqual({level: 'sensitive'});
        // It is a small object with room to grow, not a bare boolean.
        expect(typeof marking).toBe('object');
    });
});

describe('@Sensitive — inheritance-safety (DEC-021, reused not reinvented)', () => {
    it('a subclass cannot un-mark an inherited sensitive field', () => {
        class Person {
            @Sensitive() email = '';
        }
        // The subclass redeclares the field WITHOUT the marker — an attempt to shed it.
        class Employee extends Person {
            email = '';
            department = '';
        }

        // Own-scoped read on the subclass sees no own marking...
        expect(getFieldSensitivity(Employee.prototype, 'email')).toBeUndefined();
        // ...but the effective read walks the chain and still finds the parent's marking.
        expect(getEffectiveFieldSensitivity(Employee.prototype, 'email')).toEqual({level: 'sensitive'});
    });

    it('a subclass of a @Sensitive class is itself sensitive and cannot shed it', () => {
        @Sensitive()
        class Secret {
            value = '';
        }
        class DerivedSecret extends Secret {
            extra = '';
        }

        expect(getClassSensitivity(DerivedSecret)).toBeUndefined(); // not declared on the subclass
        expect(getEffectiveClassSensitivity(DerivedSecret)).toEqual({level: 'sensitive'}); // in force anyway
        expect(getEffectiveFieldSensitivity(DerivedSecret.prototype, 'extra')).toEqual({level: 'sensitive'});
    });

    it('a subclass may ADD a marking a parent did not have (strengthen)', () => {
        class Base {
            a = '';
        }
        class Sub extends Base {
            @Sensitive() b = '';
        }

        expect(getEffectiveFieldSensitivity(Sub.prototype, 'b')).toEqual({level: 'sensitive'});
        expect(getEffectiveFieldSensitivity(Sub.prototype, 'a')).toBeUndefined();
        // The parent is untouched — the marking is own-scoped to the subclass.
        expect(getFieldSensitivity(Base.prototype, 'b')).toBeUndefined();
    });
});

describe('@Sensitive — record-only, no enforcement-band pollution', () => {
    it('does not create a field contract or trigger accessor installation', () => {
        class Order {
            @Sensitive() cardNumber = '';
        }

        // No entry in the field CONTRACT band — the marker never touches it.
        expect(getFieldContract(Order.prototype, 'cardNumber')).toBeUndefined();
        expect(getFieldContractsForClass(Order)).toEqual([]);

        // And the field behaves as an ordinary readable, writable property (no validating accessor).
        const order = new Order();
        order.cardNumber = '4111111111111111';
        expect(order.cardNumber).toBe('4111111111111111');
        // It still enumerates/serialises normally.
        expect(Object.keys(order)).toContain('cardNumber');
        expect(JSON.parse(JSON.stringify(order)).cardNumber).toBe('4111111111111111');
    });

    it('coexists with @Enforce on the same field — sensitive AND enforced, independently', () => {
        class Balance {
            @Sensitive()
            @Enforce.greaterThanEqual(0)
            amount = 0;
        }

        // Enforcement is present and works...
        expect(getFieldContract(Balance.prototype, 'amount')).toBeDefined();
        const b = new Balance();
        b.amount = 5;
        expect(b.amount).toBe(5);
        expect(() => {
            b.amount = -1;
        }).toThrow();

        // ...and the sensitivity marking is present alongside it, in its own band.
        expect(getEffectiveFieldSensitivity(Balance.prototype, 'amount')).toEqual({level: 'sensitive'});
    });
});
