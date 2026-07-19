/**
 * CHARACTERIZATION TESTS — parameter-decorator core pipeline, WITH
 * `reflect-metadata` loaded.
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
 * Loading `reflect-metadata` installs `Reflect.decorate` and so flips every
 * decorated class in the process onto the first branch. DEC-005 and plan risk 3
 * both require the P1.3/P1.4 work to be re-verified under that branch rather
 * than assumed equivalent — this file is that verification.
 *
 * `reflect-metadata` patches the realm's `Reflect`, and Jest gives each test
 * file its own module registry and its own realm, so importing it here does not
 * leak into `parameter-decorator-core.test.ts`. Both files assert which branch
 * they are on, so that isolation is itself checked rather than trusted.
 *
 * These are characterization tests: they pin CURRENT behavior, including
 * behavior that is known-buggy. See the header of the sibling file for the
 * conventions used.
 */

import 'reflect-metadata';

import {
    GreaterThanEqual,
    LessThanEqual,
    Positive,
    StringMinLength,
} from '../src/ParameterDecorators/Constraints';

describe('preconditions of this file', () => {
    it('runs on the Reflect.decorate branch of tslib __decorate', () => {
        expect(typeof (Reflect as any).decorate).toBe('function');
        expect(typeof (Reflect as any).getMetadata).toBe('function');
    });
});

describe('emitDecoratorMetadata still works after the TypeScript upgrade (DEC-003)', () => {
    /**
     * NON-NEGOTIABLE per DEC-003, and the reason DEC-004 selects ts-jest over
     * Vitest: esbuild permanently ignores `emitDecoratorMetadata`, so a Vitest
     * migration would make these assertions unsatisfiable. If this block fails,
     * either the compiler options regressed or the transform stopped using the
     * real TypeScript compiler.
     */
    class Task {
        test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
            return `${message}:${someNumber}`;
        }

        untouched(a: string, b: number) { return `${a}${b}`; }
    }

    it('emits design:paramtypes for a parameter-decorated method', () => {
        const paramtypes = (Reflect as any).getMetadata('design:paramtypes', Task.prototype, 'test');
        expect(paramtypes).toBeDefined();
        expect(paramtypes.map((t: any) => t.name)).toEqual(['String', 'Number']);
    });

    it('emits design:type and design:returntype for a decorated method', () => {
        expect((Reflect as any).getMetadata('design:type', Task.prototype, 'test')).toBe(Function);
        expect((Reflect as any).getMetadata('design:returntype', Task.prototype, 'test')).toBeUndefined();
    });

    it('emits no metadata for an undecorated method', () => {
        // Metadata is only emitted for members that carry a decorator; this is
        // the limit P1.5's type checking has to work within.
        expect((Reflect as any).getMetadata('design:paramtypes', Task.prototype, 'untouched')).toBeUndefined();
    });

    it('survives the wrapper being installed over the original method', () => {
        // Metadata is attached to (prototype, key), not to the function object,
        // so replacing the method with a wrapper does not lose it. P1.3 moves
        // installation to a descriptor-returning method decorator; this must
        // still hold afterwards.
        expect(Task.prototype.test.length).toBe(0); // the wrapper, not the original
        const paramtypes = (Reflect as any).getMetadata('design:paramtypes', Task.prototype, 'test');
        expect(paramtypes.map((t: any) => t.name)).toEqual(['String', 'Number']);
    });
});

describe('core pipeline behaves identically on the Reflect.decorate branch', () => {
    class Task {
        greeting = 'hello';

        test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
            return `${this.greeting}:${message}:${someNumber}`;
        }
    }

    const task = new Task();

    it('enforces constraints and passes valid calls through', () => {
        expect(task.test('0123456789', 500)).toBe('hello:0123456789:500');
        expect(() => task.test('short', 500)).toThrow(/expected a string of length greater than 10/);
        expect(() => task.test('0123456789', 5)).toThrow(/expected a number greater than or equal to 100/);
    });

    it('preserves the return value and `this`', () => {
        const other = new Task();
        other.greeting = 'bonjour';
        expect(other.test('0123456789', 500)).toBe('bonjour:0123456789:500');
    });

    it('produces the same formatted signature in violation messages', () => {
        let message = '';
        try {
            task.test('short', 500);
        } catch (e: any) {
            message = e.message;
        }
        expect(message).toBe(
            "Value Error: Task.test(message, someNumber) parameter 'message' " +
            "expected a string of length greater than 10 but received 'short' instead",
        );
    });

    it('CHARACTERIZATION: name and arity are lost on this branch too', () => {
        // Same known defects as the non-Reflect branch — recorded here so a fix
        // that only addresses one branch is caught. Intended after P1.2/P1.6:
        // name 'test', length 2.
        expect(Task.prototype.test.name).toBe('');
        expect(Task.prototype.test.length).toBe(0);
    });

    it('runs stacked decorators on a single parameter', () => {
        class Bounded {
            clamp(@GreaterThanEqual(100) @LessThanEqual(1000) n: number) { return n; }
        }

        expect(new Bounded().clamp(500)).toBe(500);
        expect(() => new Bounded().clamp(50)).toThrow(/greater than or equal to 100/);
        expect(() => new Bounded().clamp(5000)).toThrow(/less than or equal to 1000/);
    });

    it('still evaluates constraints in reverse parameter order', () => {
        class Task2 {
            test(@StringMinLength(10) message: string, @LessThanEqual(1000) someNumber: number) { return 'ok'; }
        }

        const recorded = (Task2.prototype.test as any).parameterDecorators as { parameterIndex: number }[];
        expect(recorded.map(d => d.parameterIndex)).toEqual([1, 0]);
        expect(() => new Task2().test('short', 5000)).toThrow(/parameter 'someNumber'/);
    });
});

describe('__decorate / Object.defineProperty interaction on the Reflect.decorate branch (DEC-005)', () => {
    /**
     * `Reflect.decorate` does not itself define the property — tslib still runs
     * its own trailing `Object.defineProperty(target, key, r)` afterwards. So the
     * clobbering hazard, and the one-shot patch that swallows it, are live on
     * this branch exactly as on the other. P1.4 must be verified here too.
     */

    it('leaves the wrapper installed after __decorate completes', () => {
        class Task {
            test(@StringMinLength(10) message: string) { return 'ok'; }
        }

        const installed = Object.getOwnPropertyDescriptor(Task.prototype, 'test')!.value;
        expect(installed.length).toBe(0);
        expect(installed.toString()).toContain('test(message)');
        expect(() => new Task().test('short')).toThrow(/expected a string of length greater than 10/);
    });

    it('restores Object.defineProperty by the time decoration finishes', () => {
        const before = Object.defineProperty;

        class Task {
            test(@Positive() n: number, @GreaterThanEqual(1) m: number) { return n + m; }
        }
        void Task;

        expect(Object.defineProperty).toBe(before);
    });

    it('keeps Object.defineProperty usable immediately after a decorated class', () => {
        class Task {
            test(@Positive() n: number) { return n; }
        }
        void Task;

        const probe: any = {};
        Object.defineProperty(probe, 'marker', {value: 'applied', configurable: true});
        expect(probe.marker).toBe('applied');
    });
});
