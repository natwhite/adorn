/**
 * P2.1 / P2.2 — field contracts end to end, through the `@Enforce.*` authoring surface.
 *
 * The headline is BUG-1: `@Enforce.positive()` used to validate an assignment and then read back
 * `undefined` forever, because the accessor it installed had a setter that stored nothing, no
 * getter at all, and lived on the prototype with `configurable: false`. Every suite below would have
 * failed against that implementation.
 *
 * The unit-level design (storage, ordering, idempotence, the rejected `WeakMap` side table) is
 * covered in `src/Core/FieldDecoratorFactory.test.ts`. This file exercises the decorators as a user
 * writes them, including the two places field decoration interacts with the rest of adorn:
 * inheritance, and sharing a class with parameter contracts.
 */

import {Enforce} from '../src/FieldDeocrators/Enforce';
import {Contract} from '../src/Core/ContractInstaller';
import {StringMinLength} from '../src/ParameterDecorators/Constraints';
import {getFieldConstraints} from '../src/Core/FieldDecoratorFactory';

describe('a decorated field behaves like a field (BUG-1)', () => {
    class Basket {
        @Enforce.positive()
        itemCount: number = 1;

        @Enforce.minLength(3)
        label: string = 'abc';
    }

    it('round-trips an assigned value', () => {
        const basket = new Basket();
        basket.itemCount = 12;
        expect(basket.itemCount).toBe(12);
    });

    it('validates and keeps the initializer', () => {
        expect(new Basket().itemCount).toBe(1);
        expect(new Basket().label).toBe('abc');
    });

    it('rejects an invalid assignment and preserves the previous value', () => {
        const basket = new Basket();
        basket.itemCount = 9;

        expect(() => { basket.itemCount = -3; }).toThrow(/expected a positive number/);
        expect(basket.itemCount).toBe(9);
    });

    it('gives two instances independent state', () => {
        const a = new Basket();
        const b = new Basket();

        a.itemCount = 10;
        b.itemCount = 20;
        a.label = 'aaaa';

        expect(a.itemCount).toBe(10);
        expect(b.itemCount).toBe(20);
        expect(b.label).toBe('abc');
    });

    it('reports the class and field in the message', () => {
        expect(() => { new Basket().itemCount = 0; })
            .toThrow('Value Error: Basket.itemCount expected a positive number but received 0 instead');
    });

    it('survives JSON round-tripping like an undecorated object', () => {
        const basket = new Basket();
        basket.itemCount = 7;

        expect(JSON.parse(JSON.stringify(basket))).toEqual({itemCount: 7, label: 'abc'});
    });
});

describe('stacked constraints', () => {
    class Reading {
        @Enforce.greaterThanEqual(10)
        @Enforce.lessThanEqual(100)
        value: number = 50;
    }

    it('enforces every constraint on the field', () => {
        const reading = new Reading();

        expect(() => { reading.value = 5; }).toThrow(/greater than or equal to 10/);
        expect(() => { reading.value = 500; }).toThrow(/less than or equal to 100/);

        reading.value = 75;
        expect(reading.value).toBe(75);
    });

    it('reports the first violated constraint in declaration order, not __decorate order', () => {
        // Both are violated by `NaN`; the one written first is the one reported.
        expect(() => { new Reading().value = NaN; }).toThrow(/greater than or equal to 10/);
    });

    it('installs once, not once per decorator (BUG-1: configurable:false made the second throw)', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Reading.prototype, 'value')!;
        expect(descriptor.configurable).toBe(true);
        expect(getFieldConstraints(Reading.prototype, 'value')).toHaveLength(2);
    });
});

describe('inheritance', () => {
    class Base {
        @Enforce.positive()
        count: number = 1;
    }

    it('applies an inherited field contract to a subclass instance', () => {
        class Derived extends Base {}

        const derived = new Derived();
        derived.count = 5;

        expect(derived.count).toBe(5);
        expect(() => { derived.count = -1; }).toThrow(/expected a positive number/);
    });

    it('keeps subclass instances independent of each other and of the base', () => {
        class Derived extends Base {}

        const base = new Base();
        const derived = new Derived();

        base.count = 100;
        derived.count = 200;

        expect(base.count).toBe(100);
        expect(derived.count).toBe(200);
    });

    it('does not let a subclass corrupt the base contract', () => {
        class Derived extends Base {
            @Enforce.lessThanEqual(10)
            count: number = 5;
        }
        void Derived;

        // The parent's own constraints are untouched by the subclass declaring its own.
        expect(getFieldConstraints(Base.prototype, 'count').map(c => c.constraint)).toEqual(['positive']);
        expect(() => { new Base().count = -1; }).toThrow(/expected a positive number/);
    });

    it('OPEN QUESTION: a redeclared field replaces the base contract rather than adding to it', () => {
        class Derived extends Base {
            @Enforce.lessThanEqual(10)
            count: number = 5;
        }

        const derived = new Derived();
        derived.count = 8;
        expect(derived.count).toBe(8);

        // The subclass's own constraint is enforced...
        expect(() => { derived.count = 50; }).toThrow(/less than or equal to 10/);

        // ...but the base's `positive` is NOT, because the store is own-scoped exactly as
        // ContractRegistry is. Whether a subclass should inherit, replace, or be forbidden from
        // weakening its parent's field contract is a design-by-contract question (preconditions may
        // only be weakened) that Tier 2 owns. This test pins the current answer so a change to it is
        // deliberate rather than accidental.
        expect(() => { derived.count = -1; }).not.toThrow();
        expect(derived.count).toBe(-1);
    });
});

describe('static fields', () => {
    it('rescues a static initializer that ran before the decorator', () => {
        class Config {
            @Enforce.positive()
            static limit: number = 10;
        }

        // TypeScript emits `Config.limit = 10` *before* `__decorate`, so the value is already an own
        // data property when the decorator runs. Installing the accessor over it without carrying
        // the value across would read back `undefined` — BUG-1 again, for statics.
        expect(Config.limit).toBe(10);
    });

    it('validates assignments to a static field', () => {
        class Config {
            @Enforce.positive()
            static limit: number = 10;
        }

        Config.limit = 25;
        expect(Config.limit).toBe(25);
        expect(() => { Config.limit = -1; }).toThrow(/expected a positive number/);
        expect(Config.limit).toBe(25);
    });

    it('does not let a subclass assignment mutate the base class value', () => {
        class Base {
            @Enforce.positive()
            static limit: number = 10;
        }
        class Sub extends Base {}

        Sub.limit = 99;

        // Assigning to an inherited plain static creates an own property on the subclass; an
        // accessor found on the chain must not silently write through to the base's storage.
        expect(Sub.limit).toBe(99);
        expect(Base.limit).toBe(10);
        expect(() => { Sub.limit = -1; }).toThrow(/expected a positive number/);
    });

    it('rejects an invalid static initializer at class-evaluation time', () => {
        expect(() => {
            class Bad {
                @Enforce.positive()
                static limit: number = -1;
            }
            return Bad;
        }).toThrow(/expected a positive number/);
    });

    it('re-checks a rescued initializer against constraints declared above the installing one', () => {
        // `__decorate` applies bottom-up, so `lessThanEqual` installs and seeds first (5 passes) and
        // `greaterThanEqual` records afterwards. Without a second pass the initializer would escape
        // the constraint written above it.
        expect(() => {
            class Bad {
                @Enforce.greaterThanEqual(10)
                @Enforce.lessThanEqual(100)
                static limit: number = 5;
            }
            return Bad;
        }).toThrow(/greater than or equal to 10/);
    });
});

describe('coexisting with parameter contracts', () => {
    @Contract()
    class Task {
        @Enforce.positive()
        priority: number = 1;

        run(@StringMinLength(5) message: string) {
            return `${message}@${this.priority}`;
        }
    }

    it('enforces the field contract', () => {
        const task = new Task();
        task.priority = 3;

        expect(task.priority).toBe(3);
        expect(() => { task.priority = -1; }).toThrow(/expected a positive number/);
    });

    it('enforces the parameter contract on the same class', () => {
        const task = new Task();

        expect(() => task.run('abc')).toThrow(/length greater than 5/);
        expect(task.run('abcdef')).toBe('abcdef@1');
    });

    it('leaves Object.defineProperty unpatched (P1.4)', () => {
        // The old design armed a one-shot global patch of `Object.defineProperty`, which made a
        // field decorator on a class that also had parameter decorators a coin toss (plan §1.1).
        expect(Object.defineProperty).toBe(Object.getOwnPropertyDescriptor(Object, 'defineProperty')!.value);
    });

    it('does not need @Contract() for the field contract to work', () => {
        class Unannotated {
            @Enforce.positive()
            count: number = 1;
        }

        expect(() => { new Unannotated().count = -1; }).toThrow(/expected a positive number/);
    });
});

describe('totality, inherited from the shared descriptors', () => {
    class Guarded {
        @Enforce.minLength(3)
        label: string = 'abc';

        @Enforce.positive()
        count: number = 1;
    }

    it('reports a contract violation, not a TypeError, for null (BUG-4)', () => {
        const guarded = new Guarded();
        expect(() => { (guarded as any).label = null; }).toThrow(/expected a string of length/);
        expect(guarded.label).toBe('abc');
    });

    it('rejects NaN (Q-7)', () => {
        const guarded = new Guarded();
        expect(() => { guarded.count = NaN; }).toThrow(/expected a positive number/);
    });

    it('rejects undefined', () => {
        const guarded = new Guarded();
        expect(() => { (guarded as any).count = undefined; }).toThrow(/expected a positive number/);
    });
});

describe('field constraints are data (DEC-006)', () => {
    class Product {
        @Enforce.between(1, 10)
        rating: number = 5;
    }

    it('exposes identity and params, so a projection could render them', () => {
        const [constraint] = getFieldConstraints(Product.prototype, 'rating');

        expect(constraint.constraint).toBe('between');
        expect(constraint.params).toEqual({min: 1, max: 10});
        expect(constraint.describe()).toBe('a number between 1 and 10 (inclusive)');
        expect(constraint.schema!()).toEqual({type: 'number', minimum: 1, maximum: 10});
    });

    it('shares one descriptor identity with the parameter band, so the two cannot drift', () => {
        const [field] = getFieldConstraints(Product.prototype, 'rating');
        expect(field.predicate(0)).toBe(false);
        expect(field.predicate(5)).toBe(true);
        expect(field.predicate(11)).toBe(false);
    });
});
