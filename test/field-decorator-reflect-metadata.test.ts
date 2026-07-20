/**
 * Field contracts on the **`Reflect.decorate`** branch of tslib's `__decorate`.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * tslib's `__decorate` branches at call time:
 *
 *     if (typeof Reflect === "object" && typeof Reflect.decorate === "function")
 *         r = Reflect.decorate(decorators, target, key, desc);
 *     else
 *         for (var i = decorators.length - 1; i >= 0; i--) ...
 *
 * Loading `reflect-metadata` flips every decorated class in the process onto the first branch.
 * DEC-005 and plan risk 3 require decoration work to be verified under that branch rather than
 * assumed equivalent, and the field path depends on two branch-sensitive facts:
 *
 *   1. a field is emitted as `__decorate([...], Proto, "key", void 0)`, so `r` stays falsy and the
 *      trailing `Object.defineProperty(target, key, r)` never fires — meaning the accessor the
 *      decorator installs is not clobbered;
 *   2. decorators are applied **bottom-up**, which is what `recordFieldConstraint`'s `unshift`
 *      normalises back to declaration order.
 *
 * `reflect-metadata` implements its own `DecorateProperty` loop, so neither is guaranteed by the
 * tslib code above. This file checks both rather than trusting them.
 *
 * Jest gives each test file its own module registry and realm, so importing `reflect-metadata` here
 * does not leak into `field-decorators.test.ts`. Both files assert which branch they are on.
 */

import 'reflect-metadata';

import {Enforce} from '../src/FieldDeocrators/Enforce';
import {getFieldConstraints} from '../src/Core/FieldDecoratorFactory';

describe('preconditions of this file', () => {
    it('runs on the Reflect.decorate branch', () => {
        expect(typeof (Reflect as any).decorate).toBe('function');
    });
});

describe('field contracts under Reflect.decorate', () => {
    class Basket {
        @Enforce.greaterThan(0)
        itemCount: number = 1;

        @Enforce.greaterThanEqual(10)
        @Enforce.lessThanEqual(100)
        weight: number = 50;
    }

    it('installs an accessor that survives the decoration call', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Basket.prototype, 'itemCount')!;
        expect(typeof descriptor.get).toBe('function');
        expect(typeof descriptor.set).toBe('function');
        expect(descriptor.configurable).toBe(true);
    });

    it('stores and validates exactly as on the tslib branch', () => {
        const basket = new Basket();
        basket.itemCount = 7;

        expect(basket.itemCount).toBe(7);
        expect(() => {
            basket.itemCount = -1;
        }).toThrow(/expected a number greater than 0/);
        expect(basket.itemCount).toBe(7);
    });

    it('keeps instances independent', () => {
        const a = new Basket();
        const b = new Basket();
        a.itemCount = 1;
        b.itemCount = 2;

        expect([a.itemCount, b.itemCount]).toEqual([1, 2]);
    });

    it('records stacked constraints in declaration order on this branch too', () => {
        expect(getFieldConstraints(Basket.prototype, 'weight').map(c => c.constraint)).toEqual([
            'min',
            'max',
        ]);
        expect(() => {
            new Basket().weight = 5;
        }).toThrow(/greater than or equal to 10/);
    });

    it('rescues a static initializer on this branch too', () => {
        class Config {
            @Enforce.greaterThan(0)
            static limit: number = 10;
        }

        expect(Config.limit).toBe(10);
        expect(() => {
            Config.limit = 0;
        }).toThrow(/expected a number greater than 0/);
    });

    it('leaves Object.defineProperty unpatched', () => {
        expect(Object.defineProperty).toBe(Object.getOwnPropertyDescriptor(Object, 'defineProperty')!.value);
    });
});
