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
    getEffectiveFieldConstraints,
    getFieldConstraints,
    getFieldContracts,
    getFieldKeys,
    installFieldContract,
    installFieldContracts,
    recordFieldConstraint,
} from './FieldDecoratorFactory';
import {GreaterThan, GreaterThanEqual, LessThanEqual} from '../Contracts/number';
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
        recordFieldConstraint(target, 'count', GreaterThan(0));

        const [constraint] = getFieldConstraints(target, 'count');

        // The point of DEC-006: identity and params are readable, so a projection can render this.
        expect(constraint.constraint).toBe('greaterThan');
        expect(constraint.kind).toBe('number');
        expect(constraint.params).toEqual({exclusiveMin: 0});
        expect(JSON.parse(JSON.stringify(constraint))).toEqual({
            kind: 'number',
            constraint: 'greaterThan',
            params: {exclusiveMin: 0},
        });
    });

    it('refuses a bare closure, so no field constraint can be unprojectable', () => {
        expect(() => recordFieldConstraint({}, 'count', (() => true) as any)).toThrow(/ConstraintDescriptor/);
        expect(() => CreateFieldDecorator(((v: any) => v > 0) as any)).toThrow(/ConstraintDescriptor/);
    });

    it('is own-scoped — a subclass prototype does not read its parent entry', () => {
        const base = {};
        const derived = Object.create(base);
        recordFieldConstraint(base, 'count', GreaterThan(0));

        expect(getFieldConstraints(base, 'count')).toHaveLength(1);
        expect(getFieldConstraints(derived, 'count')).toHaveLength(0);

        // Storage stays own-scoped under DEC-021 — that is what makes weakening unexpressible, since
        // a descendant has no route to an ancestor's array. Inheritance is a property of the *read*.
        expect(getEffectiveFieldConstraints(derived, 'count')).toHaveLength(1);
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
        recordFieldConstraint(target, 'count', GreaterThan(0));

        installFieldContract(target, 'count');
        const first = Object.getOwnPropertyDescriptor(target, 'count');
        installFieldContract(target, 'count');
        const second = Object.getOwnPropertyDescriptor(target, 'count');

        expect(second!.get).toBe(first!.get);
        expect(second!.set).toBe(first!.set);
    });

    it('installs a configurable, non-enumerable accessor pair on the target', () => {
        const target: any = {};
        recordFieldConstraint(target, 'count', GreaterThan(0));
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
        recordFieldConstraint(target, 'count', GreaterThan(0));

        expect(() => installFieldContract(target, 'count')).toThrow(/non-configurable/);
    });

    it('refuses a getter/setter, whose install would be silently undone by __decorate', () => {
        const target: any = {};
        Object.defineProperty(target, 'count', {
            configurable: true,
            get() {
                return 1;
            },
            set() {
                /* noop */
            },
        });
        recordFieldConstraint(target, 'count', GreaterThan(0));

        expect(() => installFieldContract(target, 'count')).toThrow(/getter\/setter, not a field/);
    });

    it('installFieldContracts covers statics and instance fields from the constructor', () => {
        class Host {
            static limit: number;
            count: number;
        }
        recordFieldConstraint(Host, 'limit', GreaterThan(0));
        recordFieldConstraint(Host.prototype, 'count', GreaterThan(0));

        installFieldContracts(Host);

        expect(typeof Object.getOwnPropertyDescriptor(Host, 'limit')!.set).toBe('function');
        expect(typeof Object.getOwnPropertyDescriptor(Host.prototype, 'count')!.set).toBe('function');
    });

    it('installFieldContracts is safe to re-drive, so @Contract() could call it', () => {
        class Host {
            count: number;
        }
        recordFieldConstraint(Host.prototype, 'count', GreaterThan(0));

        installFieldContracts(Host);
        const first = Object.getOwnPropertyDescriptor(Host.prototype, 'count');
        installFieldContracts(Host);

        expect(Object.getOwnPropertyDescriptor(Host.prototype, 'count')!.set).toBe(first!.set);
    });
});

describe('the accessor — BUG-1', () => {
    class Widget {
        @CreateFieldDecorator(GreaterThan(0))
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
            @CreateFieldDecorator(GreaterThan(0))
            count: number = -1;
        }
        expect(() => new Bad()).toThrow(/expected a number greater than 0/);
    });

    it('rejects an invalid assignment', () => {
        const widget = new Widget();
        expect(() => {
            widget.count = -1;
        }).toThrow(/Widget\.count expected a number greater than 0/);
    });

    it('leaves the previously stored value intact when an assignment is rejected', () => {
        const widget = new Widget();
        widget.count = 7;
        expect(() => {
            widget.count = -1;
        }).toThrow();
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
        expect(() => {
            widget.count = -1;
        }).toThrow();

        // The own property must remain an accessor. A data property here would shadow the
        // prototype setter and silently disable validation from the second write onwards.
        const own = Object.getOwnPropertyDescriptor(widget, 'count')!;
        expect(typeof own.get).toBe('function');
        expect(typeof own.set).toBe('function');
    });

    it('reads undefined for a contracted field that was never assigned', () => {
        class Sparse {
            @CreateFieldDecorator(GreaterThan(0))
            count: number;
        }
        expect(new Sparse().count).toBeUndefined();
    });

    it('names the field in the violation message', () => {
        const widget = new Widget();
        expect(() => {
            widget.label = 'ab';
        }).toThrow(
            // Value redacted by default (BUG-19); this test pins the field naming in the message.
            'Value Error: Widget.label expected a string of length greater than 3 but received [REDACTED] instead',
        );
    });

    it('supports symbol-keyed fields', () => {
        const key = Symbol('count');
        const target: any = {};
        recordFieldConstraint(target, key, GreaterThan(0));
        installFieldContract(target, key);

        const instance = Object.create(target);
        instance[key] = 5;
        expect(instance[key]).toBe(5);
        expect(() => {
            instance[key] = -1;
        }).toThrow(/expected a number greater than 0/);
    });
});

describe('observability — why the WeakMap side table was rejected', () => {
    class Model {
        @CreateFieldDecorator(GreaterThan(0))
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
        expect(() => Object.assign(model, {count: -5})).toThrow(/expected a number greater than 0/);
        expect(model.count).toBe(1);
    });

    it('does not list an unassigned contracted field in for...in', () => {
        class Sparse {
            @CreateFieldDecorator(GreaterThan(0))
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
            @Enforce.greaterThan(0)
            itemCount: number = 1;

            @Enforce.greaterThanEqual(0)
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
            @Enforce.greaterThan(0)
            itemCount: number = 1;
        }

        expect(getFieldContractsForClass(Basket)[0].contract.installed).toBe(true);

        // Recorded but never installed stays `false` — the field-band twin of what the docs renderer
        // already flags loudly for methods.
        const recordedOnly = {};
        recordFieldConstraint(recordedOnly, 'count', GreaterThan(0));
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
        expect(() => {
            new Reading().value = 5;
        }).toThrow(/greater than or equal to 10/);
    });

    it('does not conjure a field contract for an installed-but-unrecorded field', () => {
        // `installFieldContract` may be driven class-wide; it must not put an empty contract into the
        // registry that a document would then render as a contracted field with no constraints.
        const target: any = {};
        installFieldContract(target, 'count');

        expect(getFieldContract(target, 'count')).toBeUndefined();
    });

    /*
     * Q-14, resolved by DEC-021. This test asserted the opposite until then — that a subclass
     * redeclaring a field REPLACED the base contract, so `Sub` accepted `5` against a base minimum of
     * `10`. It is **inverted deliberately**, not adjusted: the status quo it pinned was the open
     * question, and the question is now answered.
     */
    it('a subclass redeclaring a field UNIONS with the base contract (DEC-021)', () => {
        class Base {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }

        class Sub extends Base {
            @Enforce.lessThanEqual(100)
            value: number = 50;
        }

        // Own-scoped storage is unchanged — each declaration landed on the object it was written on.
        expect(getFieldContract(Base.prototype, 'value')!.constraints.map(c => c.constraint)).toEqual([
            'min',
        ]);
        expect(getFieldContract(Sub.prototype, 'value')!.constraints.map(c => c.constraint)).toEqual(['max']);

        // What a projection reads is the union, base-most first, so a generated document describes
        // what is actually enforced. Reporting only `Sub`'s own `max` here would recreate BUG-16's
        // failure shape — enforced, and missing from an artifact that looks complete.
        expect(getFieldContractsForClass(Sub)[0].contract.constraints.map(c => c.params)).toEqual([
            {min: 10},
            {max: 100},
        ]);

        const sub = new Sub();
        expect(() => {
            sub.value = 5;
        }).toThrow(/greater than or equal to 10/);
        expect(() => {
            sub.value = 500;
        }).toThrow(/less than or equal to 100/);
        sub.value = 42;
        expect(sub.value).toBe(42);
    });

    it('lists an inherited field a subclass never redeclares', () => {
        class Base {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }
        class Sub extends Base {}

        // The field is enforced on a `Sub` instance, so it must appear in `Sub`'s contracts. Walking
        // own-scoped storage alone would return `[]` and document `Sub` as having no field contracts.
        const entries = getFieldContractsForClass(Sub);
        expect(entries.map(entry => entry.key)).toEqual(['value']);
        expect(entries[0].contract.constraints.map(c => c.params)).toEqual([{min: 10}]);
        expect(entries[0].contract.installed).toBe(true);

        expect(() => {
            new Sub().value = 5;
        }).toThrow(/greater than or equal to 10/);
    });

    it('lists a redeclared field once, not twice', () => {
        class Base {
            @Enforce.greaterThanEqual(10)
            value: number = 10;
        }
        class Sub extends Base {
            @Enforce.lessThanEqual(100)
            value: number = 50;
        }

        // Two declarations, one contract once resolved. A document listing `value` twice would
        // misrepresent that.
        expect(getFieldContractsForClass(Sub).map(entry => entry.key)).toEqual(['value']);
    });

    it('unions inherited static field contracts too', () => {
        class Base {
            @Enforce.greaterThanEqual(10)
            static limit: number = 10;
        }
        class Sub extends Base {
            @Enforce.lessThanEqual(100)
            static limit: number = 50;
        }

        expect(getFieldContractsForClass(Sub)[0].isStatic).toBe(true);
        expect(() => {
            Sub.limit = 5;
        }).toThrow(/greater than or equal to 10/);
        expect(() => {
            Sub.limit = 500;
        }).toThrow(/less than or equal to 100/);

        // BUG-17: the subclass's own static initializer survives. `Sub.limit = 50` is emitted before
        // the decorator and lands on Base's inherited accessor, so by decoration time `Sub` carries
        // an own accessor — which used to be rejected as "a getter/setter, not a field".
        expect(Sub.limit).toBe(50);
        expect(Base.limit).toBe(10);
    });

    it('rejects a subclass static initializer that violates an inherited constraint (BUG-17)', () => {
        class Base {
            @Enforce.greaterThanEqual(10)
            static limit: number = 10;
        }

        // The rescued value is re-validated against the *effective* list, so a subclass cannot use a
        // static redeclaration to slip a value past a constraint it inherits.
        expect(() => {
            class Sub extends Base {
                @Enforce.lessThanEqual(100)
                static limit: number = 5;
            }
            return Sub;
        }).toThrow(/greater than or equal to 10/);
    });

    it('still refuses a real user getter/setter (BUG-17 did not widen the escape hatch)', () => {
        const target: any = {};
        Object.defineProperty(target, 'count', {
            configurable: true,
            get() {
                return 1;
            },
            set() {
                /* noop */
            },
        });
        recordFieldConstraint(target, 'count', GreaterThan(0));

        // Only adorn's *own* branded accessors are rescued; anything else is still refused, because
        // a `get`/`set` member's install would be silently undone by `__decorate`'s trailing write.
        expect(() => installFieldContract(target, 'count')).toThrow(/getter\/setter, not a field/);
    });

    it('resolves the union through the registry directly, not only through the accessor', () => {
        // The chain walk is a registry read, so it holds for any prototype chain — including plain
        // objects a schema-driven adapter might use, which never go through a class at all.
        const base = {};
        const derived = Object.create(base);

        recordFieldConstraint(base, 'count', GreaterThan(0));
        recordFieldConstraint(derived, 'count', LessThanEqual(10));

        expect(getFieldConstraints(derived, 'count').map(c => c.constraint)).toEqual(['max']);
        expect(getEffectiveFieldConstraints(derived, 'count').map(c => c.constraint)).toEqual([
            'greaterThan',
            'max',
        ]);

        // ...and the ancestor's own view is untouched by the descendant's declaration.
        expect(getEffectiveFieldConstraints(base, 'count').map(c => c.constraint)).toEqual(['greaterThan']);
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
