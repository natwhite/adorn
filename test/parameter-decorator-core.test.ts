/**
 * CHARACTERIZATION TESTS — parameter-decorator core pipeline.
 *
 * WHAT THESE ARE FOR
 * ------------------
 * These pin the *current, observed* behavior of the path
 *
 *     @Constraint() on a parameter
 *       -> ParameterDecoratorFactory.CreateSimpleDecorator
 *       -> tslib __decorate / __param
 *       -> the installed wrapper
 *
 * so that the P1.2 -> P1.3 -> P1.4 refactor (DEC-005) is detectable. That
 * refactor rewrites exactly this pipeline: it moves installation into a
 * MethodDecoratorFactory, then a registry-driven `@Contract()` installer, then
 * deletes the `Object.defineProperty` monkey-patch. Every assertion below is a
 * tripwire for that sequence.
 *
 * READ THIS BEFORE "FIXING" A FAILING TEST HERE
 * ---------------------------------------------
 * Several assertions pin behavior that is *known to be wrong*. They are marked
 *
 *     // CHARACTERIZATION: known defect <ID>, pinned so the refactor is detectable
 *
 * A failure on one of those is expected once the corresponding fix lands, and
 * the correct response is to update the test to the new intended behavior — not
 * to treat it as a regression. Assertions without that marker pin behavior that
 * is believed correct and must survive the refactor.
 *
 * SCOPE
 * -----
 * Deliberately limited to the parameter-decorator core. Field decorators
 * (`@Enforce`, BUG-1), `Memoize` (BUG-3), and the `Verify` helpers are not
 * covered here — they are being changed by unrelated work, and pinning them
 * would churn.
 *
 * THIS FILE DELIBERATELY DOES NOT LOAD `reflect-metadata`.
 * Its presence flips tslib's `__decorate` to the `Reflect.decorate` branch, so
 * the same behaviors are re-verified under that branch in the sibling file
 * `parameter-decorator-reflect-metadata.test.ts` (DEC-005, plan risk 3).
 */

import {
    GreaterThanEqual,
    LessThanEqual,
    Positive,
    StringMinLength,
} from '../src/ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from '../src/Core/ParameterDecoratorFactory';

describe('preconditions of this file', () => {
    it('runs on the non-Reflect.decorate branch of tslib __decorate', () => {
        // If this fails, `reflect-metadata` leaked in from somewhere and this
        // file is silently testing the *other* __decorate branch, making the
        // sibling file redundant rather than complementary.
        expect(typeof (Reflect as any).decorate).toBe('undefined');
        expect(typeof (Reflect as any).getMetadata).toBe('undefined');
    });
});

describe('constraint enforcement', () => {
    class Task {
        greeting = 'hello';

        test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
            return `${this.greeting}:${message}:${someNumber}`;
        }
    }

    const task = new Task();

    it('invokes the method normally when every constraint is satisfied', () => {
        expect(task.test('0123456789', 500)).toBe('hello:0123456789:500');
    });

    it('throws when a string constraint is violated', () => {
        expect(() => task.test('short', 500)).toThrow(/expected a string of length greater than 10/);
    });

    it('throws when a number constraint is violated', () => {
        expect(() => task.test('0123456789', 50)).toThrow(/expected a number greater than or equal to 100/);
    });

    it('throws an Error (not a bare value)', () => {
        let caught: unknown;
        try {
            task.test('short', 500);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
    });

    it('enforces on every call, not just the first', () => {
        expect(task.test('0123456789', 500)).toBe('hello:0123456789:500');
        expect(() => task.test('short', 500)).toThrow();
        expect(task.test('0123456789', 500)).toBe('hello:0123456789:500');
        expect(() => task.test('short', 500)).toThrow();
    });

    it('applies constraints per instance-independent prototype wrapper', () => {
        const other = new Task();
        other.greeting = 'bonjour';
        expect(other.test('0123456789', 500)).toBe('bonjour:0123456789:500');
        expect(() => other.test('short', 500)).toThrow();
    });
});

describe('multiple decorators', () => {
    it('runs decorators attached to different parameters of one method', () => {
        class Task {
            test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
                return 'ok';
            }
        }

        const task = new Task();
        expect(task.test('0123456789', 500)).toBe('ok');
        // each parameter's decorator is reachable and fires independently
        expect(() => task.test('short', 500)).toThrow(/parameter 'message'/);
        expect(() => task.test('0123456789', 5)).toThrow(/parameter 'someNumber'/);
    });

    it('runs multiple decorators stacked on a single parameter', () => {
        class Task {
            test(@GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) {
                return someNumber;
            }
        }

        const task = new Task();
        expect(task.test(500)).toBe(500);
        // lower bound (the outer decorator) fires
        expect(() => task.test(50)).toThrow(/greater than or equal to 100/);
        // upper bound (the inner decorator) fires
        expect(() => task.test(5000)).toThrow(/less than or equal to 1000/);
    });

    it('records one entry per decorator, including two on the same parameter', () => {
        class Task {
            test(@StringMinLength(10) message: string, @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) {
                return 'ok';
            }
        }

        const recorded = (Task.prototype.test as any).parameterDecorators as { parameterIndex: number }[];
        expect(recorded).toHaveLength(3);
        expect(recorded.filter(d => d.parameterIndex === 0)).toHaveLength(1);
        expect(recorded.filter(d => d.parameterIndex === 1)).toHaveLength(2);
    });

    it('evaluates constraints in reverse parameter order', () => {
        // CHARACTERIZATION: not a defect as such, but load-bearing and entirely
        // implicit. tslib's __decorate applies its decorator array back-to-front,
        // so the LAST parameter's decorators are registered first and therefore
        // validated first. With every argument invalid, it is the highest-index
        // parameter that reports. A registry-driven install (P1.3) is very
        // likely to normalise this to natural parameter order; when it does,
        // this assertion is the thing that tells you.
        class Task {
            test(@StringMinLength(10) message: string, @LessThanEqual(1000) someNumber: number) {
                return 'ok';
            }
        }

        const recorded = (Task.prototype.test as any).parameterDecorators as { parameterIndex: number }[];
        expect(recorded.map(d => d.parameterIndex)).toEqual([1, 0]);

        // both arguments violate their constraints; parameter 1 reports first
        expect(() => new Task().test('short', 5000)).toThrow(/parameter 'someNumber'/);
    });
});

describe('wrapper transparency', () => {
    class Task {
        greeting = 'hello';

        test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
            return `${this.greeting}:${message}:${someNumber}`;
        }

        returnsObject(@Positive() n: number) {
            return {n, self: this};
        }

        async asyncMethod(@Positive() n: number) {
            return n * 2;
        }
    }

    it('returns the original return value', () => {
        expect(new Task().test('0123456789', 500)).toBe('hello:0123456789:500');
    });

    it('preserves `this`', () => {
        const task = new Task();
        task.greeting = 'custom';
        expect(task.test('0123456789', 500)).toBe('custom:0123456789:500');

        const result = task.returnsObject(1);
        expect(result.self).toBe(task);
    });

    it('preserves async return values', async () => {
        await expect(new Task().asyncMethod(21)).resolves.toBe(42);
    });

    it('rejects rather than throws synchronously? no — it throws synchronously for async methods', () => {
        // CHARACTERIZATION: the wrapper validates *before* invoking, so an async
        // method throws synchronously instead of returning a rejected Promise.
        // That is a real behavioural wart (an `async` function should normally
        // reject, never throw), and P1.7's ResultAdapter work is where it would
        // be reconsidered. Pinned as-is.
        expect(() => new Task().asyncMethod(-1)).toThrow(/expected a positive number/);
    });

    it('preserves the original source via toString()', () => {
        // `CreateSimpleDecorator` explicitly re-points toString at the original,
        // which is also what keeps `getParamNames` working for later decorators.
        expect(Task.prototype.test.toString()).toContain('test(message, someNumber)');
    });

    it('does NOT preserve the method name', () => {
        // CHARACTERIZATION: known defect (previously unrecorded — see report),
        // pinned so the refactor is detectable.
        //
        // `ParameterDecoratorFactory` builds the wrapper as
        //     obj[originalFunction.name] = function (...args) { ... }
        // with the comment "Maintain the original function name". It does not.
        // JS named evaluation only assigns an inferred `.name` when an anonymous
        // function is assigned to a *binding* or to a *literal/computed key in an
        // object literal*. Assignment to a member expression on an existing
        // object does not, so the wrapper's name stays ''.
        //
        // Intended behaviour after P1.2/P1.6: 'test'.
        expect(Task.prototype.test.name).toBe('');

        // The undecorated sibling shows what it should have been.
        class Undecorated {
            test(message: string, someNumber: number) { return ''; }
        }
        expect(Undecorated.prototype.test.name).toBe('test');
    });

    it('does NOT preserve arity', () => {
        // CHARACTERIZATION: known defect (plan P1.6), pinned so the refactor is
        // detectable. The wrapper is `function (...args)`, so `length` is 0. The
        // source comment at ParameterDecoratorFactory.ts:87-88 claims the rest
        // parameter maintains the original length; it does not.
        //
        // Intended behaviour after P1.6: 2.
        expect(Task.prototype.test.length).toBe(0);

        class Undecorated {
            test(message: string, someNumber: number) { return ''; }
        }
        expect(Undecorated.prototype.test.length).toBe(2);
    });

    it('carries the bookkeeping expandos onto the installed function', () => {
        // CHARACTERIZATION: pins the *current mechanism*. P1.1 replaces these
        // expandos with a WeakMap-backed ContractRegistry, at which point these
        // properties should disappear entirely and this test should be deleted.
        expect((Task.prototype.test as any).parameterDecorated).toBe(true);
        expect(Array.isArray((Task.prototype.test as any).parameterDecorators)).toBe(true);
        expect(Object.getOwnPropertyNames(Task.prototype.test)).toEqual(
            expect.arrayContaining(['parameterDecorated', 'parameterDecorators', 'toString']),
        );
    });
});

describe('violation message formatting', () => {
    class Task {
        test(@StringMinLength(10) message: string, @GreaterThanEqual(100) someNumber: number) {
            return 'ok';
        }
    }

    const messageFor = (fn: () => unknown): string => {
        try {
            fn();
        } catch (e: any) {
            return e.message;
        }
        throw new Error('expected the call to throw, but it did not');
    };

    it('includes the formatted signature: Class.method(param, param) parameter \'name\'', () => {
        expect(messageFor(() => new Task().test('short', 500)))
            .toContain("Task.test(message, someNumber) parameter 'message'");
    });

    it('names the offending parameter, not just its index', () => {
        expect(messageFor(() => new Task().test('0123456789', 5)))
            .toContain("Task.test(message, someNumber) parameter 'someNumber'");
    });

    it('reports the full message including expectation and actual value', () => {
        expect(messageFor(() => new Task().test('short', 500))).toBe(
            "Value Error: Task.test(message, someNumber) parameter 'message' " +
            "expected a string of length greater than 10 but received 'short' instead",
        );
    });

    it('derives the class name from the runtime prototype owner, not the caller', () => {
        // CHARACTERIZATION: with inheritance the signature reports the class that
        // *declared* the method, not the instance's class. `getObjectName` reads
        // `target.constructor.name` at decoration time, and decoration happens on
        // the declaring prototype. P1.6 revisits inheritance handling; expect this
        // to be reconsidered there.
        class Base {
            run(@Positive() n: number) { return `base:${n}`; }
        }
        class Sub extends Base {}

        expect(new Sub().run(5)).toBe('base:5');
        expect(messageFor(() => new Sub().run(-1))).toContain('Base.run(n)');
        expect(messageFor(() => new Sub().run(-1))).not.toContain('Sub.run');
    });
});

describe('__decorate / Object.defineProperty interaction (DEC-005)', () => {
    /**
     * This is the behaviour `DecoratorFactory.OverrideObjectDefineProperty`
     * exists to protect, and the reason P1.4 may not run before P1.3.
     *
     * For a method carrying parameter decorators TypeScript emits a four-argument
     * `__decorate(..., proto, "key", null)`. tslib resolves the `null` descriptor
     * to `Object.getOwnPropertyDescriptor(target, key)` *before* the decorators
     * run, and then unconditionally re-applies it:
     *
     *     return c > 3 && r && Object.defineProperty(target, key, r), r;
     *
     * That trailing call would restore the ORIGINAL method and silently discard
     * the wrapper. The one-shot patch swallows exactly that call.
     *
     * Verified against the TypeScript 6.0.3 emitter — the shape is unchanged.
     */

    it('leaves the wrapper installed after __decorate completes', () => {
        class Task {
            test(@StringMinLength(10) message: string) { return 'ok'; }
        }

        const installed = Object.getOwnPropertyDescriptor(Task.prototype, 'test')!.value;

        // Structural evidence the wrapper (not the original) is installed: the
        // wrapper is `function (...args)` so its arity is 0, while it still
        // reports the original's source through the overridden toString.
        expect(installed.length).toBe(0);
        expect(installed.toString()).toContain('test(message)');

        // Behavioural evidence: constraints actually fire. If __decorate had
        // restored the original method, this call would succeed silently — which
        // is the precise failure mode DEC-005 warns about.
        expect(() => new Task().test('short')).toThrow(/expected a string of length greater than 10/);
    });

    it('restores Object.defineProperty by the time decoration finishes', () => {
        // The patch is one-shot and must be consumed by the very __decorate call
        // that armed it. If it were still armed here, the next defineProperty
        // ANYWHERE in the process would be silently swallowed (BUG-2).
        const before = Object.defineProperty;

        class Task {
            test(@StringMinLength(10) message: string, @GreaterThanEqual(1) n: number) { return 'ok'; }
        }
        void Task;

        expect(Object.defineProperty).toBe(before);
    });

    it('does not leak the patch across successive decorated classes', () => {
        const pristine = Object.defineProperty;

        class A { a(@Positive() n: number) { return n; } }
        class B { b(@Positive() n: number) { return n; } }
        class C { c(@Positive() n: number) { return n; } }

        expect(Object.defineProperty).toBe(pristine);

        // and all three wrappers are live
        expect(() => new A().a(-1)).toThrow();
        expect(() => new B().b(-1)).toThrow();
        expect(() => new C().c(-1)).toThrow();
    });

    it('keeps Object.defineProperty usable immediately after a decorated class', () => {
        class Task {
            test(@Positive() n: number) { return n; }
        }
        void Task;

        // A real defineProperty right after decoration must take effect. This is
        // the observable form of BUG-2: were the patch still armed, this write
        // would be swallowed and `probe.marker` would be undefined.
        const probe: any = {};
        Object.defineProperty(probe, 'marker', {value: 'applied', configurable: true});
        expect(probe.marker).toBe('applied');
    });
});

describe('known defects pinned', () => {
    it('CHARACTERIZATION: known defect BUG-4 — a null argument raises TypeError, not a contract violation', () => {
        // `StringMinLength` dereferences `params.value.length` with no guard, so
        // a null argument produces a bare TypeError from inside adorn instead of
        // the contract violation the caller should see. Pinned so the refactor is
        // detectable; P3.3 adds uniform null/type guards.
        class Task {
            test(@StringMinLength(10) message: string) { return 'ok'; }
        }

        expect(() => new Task().test(null as any)).toThrow(TypeError);
        expect(() => new Task().test(null as any)).toThrow(/Cannot read properties of null/);
        // note what it is NOT: a message naming the parameter or the constraint
        expect(() => new Task().test(null as any)).not.toThrow(/parameter 'message'/);
    });

    it('CHARACTERIZATION: known defect Q-1 / DEC-001 — @Positive accepts zero', () => {
        // `Positive` rejects only `value < 0`, so 0 passes despite the name. Q-1
        // is the open decision on whether to make it strict or rename it; either
        // resolution changes this assertion.
        class Task {
            test(@Positive() n: number) { return n; }
        }

        expect(new Task().test(0)).toBe(0);
        expect(new Task().test(1)).toBe(1);
        expect(() => new Task().test(-1)).toThrow(/expected a positive number/);
    });

    it('CHARACTERIZATION: known defect SMELL-2 — a non-Error throw is masked by stack surgery', () => {
        // The wrapper's catch block does `e.stack.split('\n')` unconditionally.
        // When a decorator throws a non-Error, `e.stack` is undefined and the
        // caller receives a TypeError from adorn's own error handling instead of
        // the original failure. P3.1 replaces this with Error.captureStackTrace
        // plus a non-Error guard.
        const ThrowsAString = () => ParameterDecoratorFactory.CreateSimpleDecorator(() => {
            throw 'the original failure';
        });

        class Task {
            test(@ThrowsAString() n: number) { return n; }
        }

        expect(() => new Task().test(1)).toThrow(TypeError);
        expect(() => new Task().test(1)).toThrow(/reading 'split'/);
        // the original thrown value is lost entirely
        expect(() => new Task().test(1)).not.toThrow(/the original failure/);
    });

    it('CHARACTERIZATION: SMELL-2 — successful stack rewriting drops frames by a hardcoded count', () => {
        // For a genuine Error the catch block keeps line 0 and drops lines 1-2,
        // hardcoding "exactly 2 frames of adorn internals". Any change to wrapper
        // depth silently corrupts the stack. Pinned loosely: the message line
        // survives and adorn's own frames are gone from the top of the trace.
        class Task {
            test(@StringMinLength(10) message: string) { return 'ok'; }
        }

        let stack = '';
        try {
            new Task().test('short');
        } catch (e: any) {
            stack = e.stack;
        }

        const lines = stack.split('\n');
        expect(lines[0]).toContain('Value Error:');
        expect(lines.slice(1, 3).join('\n')).not.toContain('ParameterDecoratorFactory');
    });
});

describe('ParameterDecoratorFactory.CreateSimpleDecorator (public authoring surface)', () => {
    it('passes a fully populated ParamObject to the decorator body', () => {
        const seen: any[] = [];
        const Capture = () => ParameterDecoratorFactory.CreateSimpleDecorator(params => {
            seen.push({...params});
        });

        class Task {
            doWork(@Capture() alpha: string, @Capture() beta: number) { return 'ok'; }
        }

        new Task().doWork('a', 1);

        expect(seen).toHaveLength(2);
        // reverse parameter order, as pinned above
        expect(seen[0]).toEqual({
            objectName: 'Task',
            funcName: 'doWork',
            paramName: 'beta',
            value: 1,
            signature: "Task.doWork(alpha, beta) parameter 'beta'",
        });
        expect(seen[1]).toMatchObject({paramName: 'alpha', value: 'a'});
    });

    it('does not let a decorator mutate the arguments actually passed through', () => {
        // CHARACTERIZATION: `ParamObject.value` is a copy; writing to it is a
        // silent no-op. The disabled "Deconstruct parameter value changes" line
        // in the factory shows this was once intended to work. Pinned so that if
        // coercion/modifier support lands, it is a deliberate change.
        const Mutate = () => ParameterDecoratorFactory.CreateSimpleDecorator((params: any) => {
            params.value = 'CHANGED';
        });

        class Task {
            doWork(@Mutate() alpha: string) { return alpha; }
        }

        expect(new Task().doWork('original')).toBe('original');
    });
});
