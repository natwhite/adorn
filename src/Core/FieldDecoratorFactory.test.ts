/**
 * P2.1 — the field decorator factory, and the storage design that fixes BUG-1.
 *
 * The suites are ordered by what they defend:
 *
 *   1. the store (constraints are *data*, recorded in declaration order),
 *   2. installation (idempotent, own-scoped, refuses what it cannot contract),
 *   3. the accessor (values round-trip, per-instance, invalid assignment leaves the prior value),
 *   4. observability — the reason a `WeakMap` side table was rejected.
 */

import {
    CreateFieldDecorator,
    getFieldConstraints,
    getFieldContracts,
    getFieldKeys,
    installFieldContract,
    installFieldContracts,
    recordFieldConstraint,
} from './FieldDecoratorFactory';
import {GreaterThanEqual, LessThanEqual, Positive} from '../Contracts/number';
import {StringMinLength} from '../Contracts/string';
import {getFieldContract, getFieldContractsForClass} from './ContractRegistry';
import {Enforce} from '../FieldDeocrators/Enforce';

describe('the constraint store', () => {
    it('reports nothing for an untouched target', () => {
        const target = {};
        expect(getFieldConstraints(target, 'count')).toHaveLength(0);
        expect(getFieldContracts(target).size).toBe(0);
        expect(getFieldKeys(target)).toEqual([]);
    });

    it('records a constraint as data, not a closure', () => {
        const target = {};
        recordFieldConstraint(target, 'count', Positive());

        const [constraint] = getFieldConstraints(target, 'count');

        // The point of DEC-006: identity and params are readable, so a projection can render this.
        expect(constraint.constraint).toBe('positive');
        expect(constraint.kind).toBe('number');
        expect(constraint.params).toEqual({exclusiveMin: 0});
        expect(JSON.parse(JSON.stringify(constraint))).toEqual({
            kind: 'number',
            constraint: 'positive',
            params: {exclusiveMin: 0},
        });
    });

    it('refuses a bare closure, so no field constraint can be unprojectable', () => {
        expect(() => recordFieldConstraint({}, 'count', (() => true) as any))
            .toThrow(/ConstraintDescriptor/);
        expect(() => CreateFieldDecorator(((v: any) => v > 0) as any))
            .toThrow(/ConstraintDescriptor/);
    });

    it('is own-scoped — a subclass prototype does not read its parent entry', () => {
        const base = {};
        const derived = Object.create(base);
        recordFieldConstraint(base, 'count', Positive());

        expect(getFieldConstraints(base, 'count')).toHaveLength(1);
        expect(getFieldConstraints(derived, 'count')).toHaveLength(0);
    });

    it('stores stacked constraints in declaration order, not __decorate arrival order', () => {
        class Reading {
            @Enforce_greaterThanEqual(10)
            @Enforce_lessThanEqual(100)
            value: number = 50;
        }

        const recorded = getFieldConstraints(Reading.prototype, 'value').map(c => c.constraint);

        // `__decorate` applies bottom-up, so `max` arrives first. The store normalises (SMELL-13
        // never applies to the field band).
        expect(recorded).toEqual(['min', 'max']);
    });
});

describe('installation', () => {
    it('is idempotent — a second call does not re-wrap', () => {
        const target: any = {};
        recordFieldConstraint(target, 'count', Positive());

        installFieldContract(target, 'count');
        const first = Object.getOwnPropertyDescriptor(target, 'count');
        installFieldContract(target, 'count');
        const second = Object.getOwnPropertyDescriptor(target, 'count');

        expect(second!.get).toBe(first!.get);
        expect(second!.set).toBe(first!.set);
    });

    it('installs a configurable, non-enumerable accessor pair on the target', () => {
        const target: any = {};
        recordFieldConstraint(target, 'count', Positive());
        installFieldContract(target, 'count');

        const descriptor = Object.getOwnPropertyDescriptor(target, 'count')!;
        expect(typeof descriptor.get).toBe('function');
        expect(typeof descriptor.set).toBe('function');
        // configurable:true is the direct fix for BUG-1's `configurable: false`, which made a second
        // decorator on the same field throw.
        expect(descriptor.configurable).toBe(true);
        // non-enumerable on the prototype: an unassigned field must not show up in `for...in`.
        expect(descriptor.enumerable).toBe(false);
    });

    it('refuses a non-configurable property rather than failing silently', () => {
        const target: any = {};
        Object.defineProperty(target, 'count', {value: 1, configurable: false});
        recordFieldConstraint(target, 'count', Positive());

        expect(() => installFieldContract(target, 'count')).toThrow(/non-configurable/);
    });

    it('refuses a getter/setter, whose install would be silently undone by __decorate', () => {
        const target: any = {};
        Object.defineProperty(target, 'count', {
            configurable: true,
            get() { return 1; },
            set() { /* noop */ },
        });
        recordFieldConstraint(target, 'count', Positive());

        expect(() => installFieldContract(target, 'count')).toThrow(/getter\/setter, not a field/);
    });

    it('installFieldContracts covers statics and instance fields from the constructor', () => {
        class Host {
            static limit: number;
            count: number;
        }
        recordFieldConstraint(Host, 'limit', Positive());
        recordFieldConstraint(Host.prototype, 'count', Positive());

        installFieldContracts(Host);

        expect(typeof Object.getOwnPropertyDescriptor(Host, 'limit')!.set).toBe('function');
        expect(typeof Object.getOwnPropertyDescriptor(Host.prototype, 'count')!.set).toBe('function');
    });

    it('installFieldContracts is safe to re-drive, so @Contract() could call it', () => {
        class Host { count: number; }
        recordFieldConstraint(Host.prototype, 'count', Positive());

        installFieldContracts(Host);
        const first = Object.getOwnPropertyDescriptor(Host.prototype, 'count');
        installFieldContracts(Host);

        expect(Object.getOwnPropertyDescriptor(Host.prototype, 'count')!.set).toBe(first!.set);
    });
});

describe('the accessor — BUG-1', () => {
    class Widget {
        @CreateFieldDecorator(Positive())
        count: number = 1;

        @CreateFieldDecorator(StringMinLength(3))
        label: string = 'abc';
    }

    it('reads back the value it was assigned (BUG-1: was permanently undefined)', () => {
        const widget = new Widget();
        widget.count = 42;
        expect(widget.count).toBe(42);
    });

    it('validates and stores the field initializer', () => {
        const widget = new Widget();
        expect(widget.count).toBe(1);
        expect(widget.label).toBe('abc');
    });

    it('rejects an invalid initializer at construction time', () => {
        class Bad {
            @CreateFieldDecorator(Positive())
            count: number = -1;
        }
        expect(() => new Bad()).toThrow(/expected a positive number/);
    });

    it('rejects an invalid assignment', () => {
        const widget = new Widget();
        expect(() => { widget.count = -1; }).toThrow(/Widget\.count expected a positive number/);
    });

    it('leaves the previously stored value intact when an assignment is rejected', () => {
        const widget = new Widget();
        widget.count = 7;
        expect(() => { widget.count = -1; }).toThrow();
        expect(widget.count).toBe(7);
    });

    it('keeps two instances completely independent (BUG-1: prototype-shared state)', () => {
        const a = new Widget();
        const b = new Widget();

        a.count = 1;
        b.count = 2;

        expect(a.count).toBe(1);
        expect(b.count).toBe(2);
    });

    it('validates every assignment, not only the first', () => {
        const widget = new Widget();
        widget.count = 5;
        widget.count = 6;
        expect(() => { widget.count = -1; }).toThrow();

        // The own property must remain an accessor. A data property here would shadow the
        // prototype setter and silently disable validation from the second write onwards.
        const own = Object.getOwnPropertyDescriptor(widget, 'count')!;
        expect(typeof own.get).toBe('function');
        expect(typeof own.set).toBe('function');
    });

    it('reads undefined for a contracted field that was never assigned', () => {
        class Sparse {
            @CreateFieldDecorator(Positive())
            count: number;
        }
        expect(new Sparse().count).toBeUndefined();
    });

    it('names the field in the violation message', () => {
        const widget = new Widget();
        expect(() => { widget.label = 'ab'; })
            .toThrow("Value Error: Widget.label expected a string of length greater than 3 but received 'ab' instead");
    });

    it('supports symbol-keyed fields', () => {
        const key = Symbol('count');
        const target: any = {};
        recordFieldConstraint(target, key, Positive());
        installFieldContract(target, key);

        const instance = Object.create(target);
        instance[key] = 5;
        expect(instance[key]).toBe(5);
        expect(() => { instance[key] = -1; }).toThrow(/expected a positive number/);
    });
});

describe('observability — why the WeakMap side table was rejected', () => {
    class Model {
        @CreateFieldDecorator(Positive())
        count: number = 1;

        @CreateFieldDecorator(StringMinLength(1))
        name: string = 'a';

        plain: boolean = true;
    }

    it('serialises exactly like an undecorated class', () => {
        const model = new Model();
        model.count = 42;

        // With a prototype accessor over a WeakMap side table this is `{}` — every contracted field
        // silently vanishes from serialisation.
        expect(JSON.stringify(model)).toBe('{"count":42,"name":"a","plain":true}');
    });

    it('enumerates its contracted fields', () => {
        expect(Object.keys(new Model()).sort()).toEqual(['count', 'name', 'plain']);
    });

    it('spreads and Object.assigns its contracted fields', () => {
        const model = new Model();
        expect({...model}).toEqual({count: 1, name: 'a', plain: true});
        expect(Object.assign({}, model)).toEqual({count: 1, name: 'a', plain: true});
    });

    it('routes Object.assign *into* an instance through validation', () => {
        const model = new Model();
        expect(() => Object.assign(model, {count: -5})).toThrow(/expected a positive number/);
        expect(model.count).toBe(1);
    });

    it('does not list an unassigned contracted field in for...in', () => {
        class Sparse {
            @CreateFieldDecorator(Positive())
            count: number;

            assigned: number = 1;
        }

        const keys: string[] = [];
        for (const key in new Sparse()) keys.push(key);
        expect(keys).toEqual(['assigned']);
    });
});

describe('field contracts are visible to projections (GAP-9)', () => {
    /**
     * The store used to be adapter-local, so a field was **enforced at runtime and absent from every
     * generated artifact** — the same shape as BUG-14 and the same failure DEC-016 rejects: nothing
     * throws, and the document looks complete.
     *
     * These go through `@Enforce`, the real public authoring surface, for the reason BUG-14 exists at
     * all: a test that records into the store by hand cannot tell you whether any decorator ever
     * reaches it.
     */

    it('exposes an @Enforce field through the registry, tagged by band', () => {
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;

            @Enforce.nonNegative()
            static minimumOrder: number = 0;
        }

        const entries = getFieldContractsForClass(Basket);

        expect(entries.map(entry => ({key: entry.key, isStatic: entry.isStatic}))).toEqual([
            {key: 'itemCount', isStatic: false},
            {key: 'minimumOrder', isStatic: true},
        ]);
    });

    it('carries the identity and params a document renders, not an opaque closure', () => {
        class Basket {
            @Enforce.between(1, 10)
            itemCount: number = 1;
        }

        const [field] = getFieldContractsForClass(Basket);

        expect(field.contract.constraints[0].constraint).toBe('between');
        expect(field.contract.constraints[0].params).toEqual({min: 1, max: 10});
        expect(field.contract.constraints[0].describe()).toContain('between 1 and 10');
    });

    it('marks the field installed, so a projection can tell enforced from merely recorded', () => {
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;
        }

        expect(getFieldContractsForClass(Basket)[0].contract.installed).toBe(true);

        // Recorded but never installed stays `false` — the field-band twin of what the docs renderer
        // already flags loudly for methods.
        const recordedOnly = {};
        recordFieldConstraint(recordedOnly, 'count', Positive());
        expect(getFieldContract(recordedOnly, 'count')!.installed).toBe(false);
    });

    it('lists stacked constraints in the order enforcement applies them', () => {
        class Reading {
            @Enforce.greaterThanEqual(10)
            @Enforce.lessThanEqual(100)
            value: number = 50;
        }

        const [field] = getFieldContractsForClass(Reading);

        // Declaration order in the registry, and the first-declared constraint is the one that
        // reports — so the document and the runtime tell the same story (DEC-017).
        expect(field.contract.constraints.map(c => c.constraint)).toEqual(['min', 'max']);
        expect(() => { new Reading().value = 5; }).toThrow(/greater than or equal to 10/);
    });

    it('does not conjure a field contract for an installed-but-unrecorded field', () => {
        // `installFieldContract` may be driven class-wide; it must not put an empty contract into the
        // registry that a document would then render as a contracted field with no constraints.
        const target: any = {};
        installFieldContract(target, 'count');

        expect(getFieldContract(target, 'count')).toBeUndefined();
    });

    it('OPEN QUESTION (Q-14): a subclass redeclaring a field REPLACES the base contract', () => {
        // Unchanged by the move to the registry — the field band is own-scoped exactly as the method
        // band is. Whether a subclass should inherit, be allowed to strengthen, or be forbidden from
        // weakening a field precondition is a Design-by-Contract / Liskov decision and is NOT settled
        // here; this pins the status quo so whichever way it is answered is a deliberate change.
        class Base {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }

        class Sub extends Base {
            @Enforce.greaterThanEqual(0)
            value: number = 0;
        }

        expect(getFieldContractsForClass(Base)[0].contract.constraints[0].params).toEqual({min: 10});
        expect(getFieldContractsForClass(Sub)[0].contract.constraints[0].params).toEqual({min: 0});

        // The subclass's own accessor shadows the base's and enforces only its own constraint.
        const sub = new Sub();
        sub.value = 5;
        expect(sub.value).toBe(5);
    });
});

// Local decorator aliases used by the declaration-order test above, kept out of `Enforce` so this
// suite exercises the factory directly.
function Enforce_greaterThanEqual(min: number) {
    return CreateFieldDecorator(GreaterThanEqual(min));
}

function Enforce_lessThanEqual(max: number) {
    return CreateFieldDecorator(LessThanEqual(max));
}
