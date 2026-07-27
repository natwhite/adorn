/**
 * P2.1 / P2.2 — field contracts end to end, through the `@Enforce.*` authoring surface.
 *
 * The headline is BUG-1: `@Enforce.greaterThan(0)` used to validate an assignment and then read back
 * `undefined` forever, because the accessor it installed had a setter that stored nothing, no
 * getter at all, and lived on the prototype with `configurable: false`. Every suite below would have
 * failed against that implementation.
 *
 * The unit-level design (storage, ordering, idempotence, the rejected `WeakMap` side table) is
 * covered in `src/Adapters/legacy/FieldDecoratorFactory.test.ts`. This file exercises the decorators as a user
 * writes them, including the two places field decoration interacts with the rest of adorn:
 * inheritance, and sharing a class with parameter contracts.
 */

import {Enforce} from '../src/FieldDecorators/Enforce';
import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {StringMinLength} from '../src/ParameterDecorators/Constraints';
import {
    getEffectiveFieldConstraints,
    getFieldConstraints,
    installFieldContract,
} from '../src/Adapters/legacy/FieldDecoratorFactory';
import {getContractedClasses} from '../src/Core/ContractRegistry';

describe('a decorated field behaves like a field (BUG-1)', () => {
    class Basket {
        @Enforce.greaterThan(0)
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

        expect(() => {
            basket.itemCount = -3;
        }).toThrow(/expected a number greater than 0/);
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
        expect(() => {
            new Basket().itemCount = 0;
            // Value redacted by default (BUG-19); the class/field naming is the subject here.
        }).toThrow(
            'Value Error: Basket.itemCount expected a number greater than 0 but received [REDACTED] instead',
        );
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

        expect(() => {
            reading.value = 5;
        }).toThrow(/greater than or equal to 10/);
        expect(() => {
            reading.value = 500;
        }).toThrow(/less than or equal to 100/);

        reading.value = 75;
        expect(reading.value).toBe(75);
    });

    it('reports the first violated constraint in declaration order, not __decorate order', () => {
        // Both are violated by `NaN`; the one written first is the one reported.
        expect(() => {
            new Reading().value = NaN;
        }).toThrow(/greater than or equal to 10/);
    });

    it('installs once, not once per decorator (BUG-1: configurable:false made the second throw)', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Reading.prototype, 'value')!;
        expect(descriptor.configurable).toBe(true);
        expect(getFieldConstraints(Reading.prototype, 'value')).toHaveLength(2);
    });
});

describe('inheritance', () => {
    class Base {
        @Enforce.greaterThan(0)
        count: number = 1;
    }

    it('applies an inherited field contract to a subclass instance', () => {
        class Derived extends Base {}

        const derived = new Derived();
        derived.count = 5;

        expect(derived.count).toBe(5);
        expect(() => {
            derived.count = -1;
        }).toThrow(/expected a number greater than 0/);
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

        // The structural half of DEC-021: storage stays own-scoped, so the subclass's declaration
        // landed on `Derived.prototype` and the parent's array is byte-for-byte what it was. There is
        // no write API that takes an ancestor, which is why weakening is unexpressible rather than
        // rejected — the union read below can only ever add to what is stored here.
        expect(getFieldConstraints(Base.prototype, 'count').map(c => c.constraint)).toEqual(['greaterThan']);
        expect(getFieldConstraints(Derived.prototype, 'count').map(c => c.constraint)).toEqual(['max']);

        // ...while the effective view of the subclass is the union, base-most first.
        expect(getEffectiveFieldConstraints(Derived.prototype, 'count').map(c => c.constraint)).toEqual([
            'greaterThan',
            'max',
        ]);

        expect(() => {
            new Base().count = -1;
        }).toThrow(/expected a number greater than 0/);
    });

    /*
     * Q-14 was open when these were first written, and this test asserted the opposite: that a
     * subclass redeclaring a decorated field **replaced** the base contract, so `Derived.count`
     * accepted `-1`. DEC-021 settles it — a subclass may strengthen an inherited field constraint and
     * can never weaken one — so the assertion is **inverted deliberately** rather than adjusted.
     */
    it('a redeclared field ADDS to the base contract rather than replacing it (DEC-021)', () => {
        class Derived extends Base {
            @Enforce.lessThanEqual(10)
            count: number = 5;
        }

        const derived = new Derived();
        derived.count = 8;
        expect(derived.count).toBe(8);

        // The subclass's own constraint is enforced...
        expect(() => {
            derived.count = 50;
        }).toThrow(/less than or equal to 10/);

        // ...and so is the base's, which the subclass has no way to shed. Redeclaring `count`
        // shadows the base's *accessor*, but the accessor is only how the assignment is intercepted;
        // the contract is resolved along the prototype chain at check time, so both apply.
        expect(() => {
            derived.count = -1;
        }).toThrow(/expected a number greater than 0/);
        expect(derived.count).toBe(8);
    });

    it('reports the base constraint before the subclass one', () => {
        class Derived extends Base {
            @Enforce.lessThanEqual(10)
            count: number = 5;
        }

        // `NaN` violates both. Base-most first, so a reader scanning the hierarchy top-down meets
        // the reported constraint where they would look for it.
        expect(() => {
            new Derived().count = NaN;
        }).toThrow(/expected a number greater than 0/);
    });

    it('cannot weaken an inherited bound even by restating it more loosely', () => {
        // The direct attempt at weakening: the subclass restates the *same* constraint identity with
        // a laxer bound. Union means the strict one survives, so `5` is still rejected — the
        // subclass has strengthened `>= 10` to `>= 10 AND >= 0`, which is just `>= 10`.
        class Strict {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }
        class Loosened extends Strict {
            @Enforce.greaterThanEqual(0)
            value: number = 10;
        }

        const loosened = new Loosened();
        expect(() => {
            loosened.value = 5;
        }).toThrow(/greater than or equal to 10/);

        loosened.value = 20;
        expect(loosened.value).toBe(20);
    });

    it('rejects a subclass initializer that violates an inherited constraint', () => {
        // The weakening attempt fails at its earliest observable moment: a subclass declaring a
        // default its parent forbids cannot be constructed at all.
        class Strict {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }
        class Weakened extends Strict {
            @Enforce.greaterThanEqual(0)
            value: number = 0;
        }

        expect(() => new Weakened()).toThrow(/greater than or equal to 10/);
    });

    it('applies constraints from every level of a three-deep hierarchy', () => {
        class A {
            @Enforce.greaterThanEqual(0)
            v: number = 5;
        }
        class B extends A {
            @Enforce.lessThanEqual(100)
            v: number = 5;
        }
        class C extends B {
            @Enforce.integer()
            v: number = 5;
        }

        const c = new C();
        expect(() => {
            c.v = -1;
        }).toThrow(/greater than or equal to 0/);
        expect(() => {
            c.v = 500;
        }).toThrow(/less than or equal to 100/);
        expect(() => {
            c.v = 1.5;
        }).toThrow(/an integer/);

        c.v = 42;
        expect(c.v).toBe(42);

        // The middle of the chain is unaffected by what its own subclass added.
        const b = new B();
        b.v = 1.5;
        expect(b.v).toBe(1.5);
    });
});

describe('static fields', () => {
    it('rescues a static initializer that ran before the decorator', () => {
        class Config {
            @Enforce.greaterThan(0)
            static limit: number = 10;
        }

        // TypeScript emits `Config.limit = 10` *before* `__decorate`, so the value is already an own
        // data property when the decorator runs. Installing the accessor over it without carrying
        // the value across would read back `undefined` — BUG-1 again, for statics.
        expect(Config.limit).toBe(10);
    });

    it('validates assignments to a static field', () => {
        class Config {
            @Enforce.greaterThan(0)
            static limit: number = 10;
        }

        Config.limit = 25;
        expect(Config.limit).toBe(25);
        expect(() => {
            Config.limit = -1;
        }).toThrow(/expected a number greater than 0/);
        expect(Config.limit).toBe(25);
    });

    it('does not let a subclass assignment mutate the base class value', () => {
        class Base {
            @Enforce.greaterThan(0)
            static limit: number = 10;
        }
        class Sub extends Base {}

        Sub.limit = 99;

        // Assigning to an inherited plain static creates an own property on the subclass; an
        // accessor found on the chain must not silently write through to the base's storage.
        expect(Sub.limit).toBe(99);
        expect(Base.limit).toBe(10);
        expect(() => {
            Sub.limit = -1;
        }).toThrow(/expected a number greater than 0/);
    });

    it('rejects an invalid static initializer at class-evaluation time', () => {
        expect(() => {
            class Bad {
                @Enforce.greaterThan(0)
                static limit: number = -1;
            }
            return Bad;
        }).toThrow(/expected a number greater than 0/);
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
        @Enforce.greaterThan(0)
        priority: number = 1;

        run(@StringMinLength(5) message: string) {
            return `${message}@${this.priority}`;
        }
    }

    it('enforces the field contract', () => {
        const task = new Task();
        task.priority = 3;

        expect(task.priority).toBe(3);
        expect(() => {
            task.priority = -1;
        }).toThrow(/expected a number greater than 0/);
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
            @Enforce.greaterThan(0)
            count: number = 1;
        }

        expect(() => {
            new Unannotated().count = -1;
        }).toThrow(/expected a number greater than 0/);
    });
});

describe('totality, inherited from the shared descriptors', () => {
    class Guarded {
        @Enforce.minLength(3)
        label: string = 'abc';

        @Enforce.greaterThan(0)
        count: number = 1;
    }

    it('reports a contract violation, not a TypeError, for null (BUG-4)', () => {
        const guarded = new Guarded();
        expect(() => {
            (guarded as any).label = null;
        }).toThrow(/expected a string of length/);
        expect(guarded.label).toBe('abc');
    });

    it('rejects NaN (Q-7)', () => {
        const guarded = new Guarded();
        expect(() => {
            guarded.count = NaN;
        }).toThrow(/expected a number greater than 0/);
    });

    it('rejects undefined', () => {
        const guarded = new Guarded();
        expect(() => {
            (guarded as any).count = undefined;
        }).toThrow(/expected a number greater than 0/);
    });
});

/*
 * BUG-16. No `resetRegistry()` anywhere in this file, deliberately: it disarms already-installed
 * field accessors (SMELL-18), because field enforcement reads the registry on every assignment while
 * method enforcement plans into a closure at install time. Every class below is therefore declared
 * *inside* its test, and enumeration is asserted with `toContain` rather than against an exact list,
 * since the registry accumulates across the whole file.
 */
describe('a field-only class is enumerated (BUG-16 / DEC-016 extended to fields)', () => {
    it('enumerates a class whose only contracts are instance fields', () => {
        class FieldOnly {
            @Enforce.greaterThan(0)
            amount: number = 1;
        }

        // Before the fix this was absent: field decorators installed enforcement and never called
        // `registerContractedClass`, so the class was enforced at runtime and missing from
        // `documentContracts()` / `generateMarkdown()`. Nothing threw, and the artifact looked
        // complete — the asymmetry DEC-016 settled for methods, applied here to fields.
        expect(getContractedClasses()).toContain(FieldOnly as unknown as Function);
    });

    it('enumerates a class whose only contracts are static fields', () => {
        class StaticFieldOnly {
            @Enforce.greaterThanEqual(0)
            static limit: number = 10;
        }

        // A static field's decorator is handed the constructor, not the prototype. Both bands must
        // resolve to the same enumerated constructor or a projection sees half the picture.
        expect(getContractedClasses()).toContain(StaticFieldOnly as unknown as Function);
    });

    it('enumerates without @Contract(), which fields never required', () => {
        class NoAnnotation {
            @Enforce.minLength(3)
            label: string = 'abc';
        }

        expect(getContractedClasses()).toContain(NoAnnotation as unknown as Function);
    });

    it('enumerates a subclass that adds its own field contract', () => {
        class Parent {
            @Enforce.greaterThan(0)
            count: number = 1;
        }
        class Child extends Parent {
            @Enforce.lessThanEqual(10)
            count: number = 5;
        }

        const enumerated = getContractedClasses();
        expect(enumerated).toContain(Parent as unknown as Function);
        expect(enumerated).toContain(Child as unknown as Function);
    });

    it('does NOT enumerate Object when installing onto a plain object target', () => {
        // `installFieldContract` is a public imperative entry point and its target is not always a
        // class. A naive `target.constructor` would register `Object` here, and every projection
        // would then try to document it.
        const target: any = {};
        installFieldContract(target, 'count');

        expect(getContractedClasses()).not.toContain(Object as unknown as Function);
    });

    it('does NOT enumerate for a detached prototype-like object', () => {
        // `Object.create(proto)` is an object carrying contracted fields, not a class. It has no
        // constructor of its own, so there is nothing meaningful to enumerate.
        const base: any = {};
        const detached = Object.create(base);
        installFieldContract(detached, 'count');

        expect(getContractedClasses()).not.toContain(Object as unknown as Function);
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
