/**
 * CHARACTERIZATION TESTS — parameter-decorator core pipeline.
 *
 * WHAT THESE ARE FOR
 * ------------------
 * These pin the *current, observed* behavior of the path
 *
 *     @Constraint() on a parameter
 *       -> ParameterDecoratorFactory records into ContractRegistry
 *       -> @Contract() on the class installs via MethodDecoratorFactory
 *       -> the installed wrapper
 *
 * UPDATED FOR P1.2 -> P1.3 -> P1.4 (DEC-005).
 * ------------------------------------------
 * That refactor has now landed, and it rewrote exactly this pipeline. Three
 * things changed for every test in this file:
 *
 *  1. `@Contract()` is REQUIRED on the class. Parameter decorators now only
 *     *record*; installation is a separate, explicit step. Every class below
 *     carries the annotation, and a dedicated suite
 *     (`contract-installation.test.ts`) covers what happens when it is missing.
 *  2. Constraints evaluate in DECLARATION order, not reverse (SMELL-11).
 *  3. There is no `Object.defineProperty` monkey-patch any more (P1.4).
 *
 * Assertions that changed as a deliberate consequence are marked
 *
 *     // CHANGED BY P1.x: <what and why>
 *
 * Assertions still marked CHARACTERIZATION pin behavior that remains known-bad
 * and is owned by later, scheduled work (P1.6 arity, P3.3 null guards, Q-1).
 *
 * READ THIS BEFORE "FIXING" A FAILING TEST HERE
 * ---------------------------------------------
 * A failure on a CHARACTERIZATION assertion is expected once the corresponding
 * fix lands, and the correct response is to update the test to the new intended
 * behavior — not to treat it as a regression. Assertions without that marker pin
 * behavior that is believed correct and must survive.
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
import {Contract} from '../src/Core/ContractInstaller';
import {getContract} from '../src/Core/ContractRegistry';

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
    @Contract()
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
        @Contract()
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
        @Contract()
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

    it('records one registry entry per decorator, including two on the same parameter', () => {
        // CHANGED BY P1.3: this previously read the `parameterDecorators` expando
        // stamped onto the method object. Those expandos are gone — contracts
        // live in the WeakMap-backed ContractRegistry (P1.1 / DEC-011), which is
        // also what every projection reads. Same fact, honest source.
        @Contract()
        class Task {
            test(@StringMinLength(10) message: string, @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) {
                return 'ok';
            }
        }

        expect((Task.prototype.test as any).parameterDecorators).toBeUndefined();
        expect((Task.prototype.test as any).parameterDecorated).toBeUndefined();

        const contract = getContract(Task.prototype, 'test')!;
        expect(contract).toBeDefined();
        expect(contract.params.map(p => p.index)).toEqual([0, 1]);
        expect(contract.params[0].constraints).toHaveLength(1);
        expect(contract.params[1].constraints).toHaveLength(2);
        expect(contract.installed).toBe(true);
    });

    it('evaluates constraints in DECLARATION order', () => {
        // CHANGED BY P1.3: this previously pinned *reverse* parameter order.
        //
        // tslib's `__decorate` applies its decorator array back-to-front, so the
        // last parameter's decorators were registered — and therefore checked —
        // first. With every argument invalid it was the highest-index parameter
        // that reported. That was never a decision, just an inherited artefact of
        // the emitter, and SMELL-11 asked for it to be settled deliberately.
        //
        // `buildParameterEnforcement` now normalises to declaration order:
        // parameters left to right, and stacked decorators top to bottom. That is
        // the order a reader of the signature expects and the order documentation
        // will list constraints in, so enforcement and projection agree.
        @Contract()
        class Task {
            test(@StringMinLength(10) message: string, @LessThanEqual(1000) someNumber: number) {
                return 'ok';
            }
        }

        // both arguments violate their constraints; parameter 0 now reports first
        expect(() => new Task().test('short', 5000)).toThrow(/parameter 'message'/);
        expect(() => new Task().test('short', 5000)).not.toThrow(/parameter 'someNumber'/);

        // and each still reports for itself when it is the only violation
        expect(() => new Task().test('0123456789', 5000)).toThrow(/parameter 'someNumber'/);
    });

    it('evaluates stacked decorators on one parameter in declaration order', () => {
        // The same normalisation, one level down: when a single value violates
        // both stacked constraints, the one written first reports.
        @Contract()
        class Task {
            test(@GreaterThanEqual(100) @LessThanEqual(50) n: number) { return n; }
        }

        // 10 violates only the first-declared constraint
        expect(() => new Task().test(10)).toThrow(/greater than or equal to 100/);
        // 500 violates only the second-declared one
        expect(() => new Task().test(500)).toThrow(/less than or equal to 50/);
        // 75 violates BOTH (< 100 and > 50) — the first-declared one is reported,
        // which is the assertion that actually pins the ordering.
        expect(() => new Task().test(75)).toThrow(/greater than or equal to 100/);
    });
});

describe('wrapper transparency', () => {
    @Contract()
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
        // The wrapper explicitly re-points toString at the original. Beyond
        // transparency this is load-bearing: parameter names are recovered by
        // parsing the source (SMELL-1).
        expect(Task.prototype.test.toString()).toContain('test(message, someNumber)');
    });

    it('preserves the method name', () => {
        // CHANGED BY P1.2 — this is the BUG-7 fix.
        //
        // The old wrapper was built as
        //     obj[originalFunction.name] = function (...args) { ... }
        // with the comment "Maintain the original function name". It did not:
        // named evaluation only infers `.name` for an anonymous function assigned
        // to a *binding* or to a key in an *object literal*, never for assignment
        // to a member expression on an existing object, so `.name` stayed ''.
        //
        // `MethodDecoratorFactory.adoptIdentity` now sets it explicitly.
        expect(Task.prototype.test.name).toBe('test');

        // matching the undecorated sibling exactly
        class Undecorated {
            test(message: string, someNumber: number) { return ''; }
        }
        expect(Undecorated.prototype.test.name).toBe(Task.prototype.test.name);
    });

    it('does NOT preserve arity', () => {
        // CHARACTERIZATION: still-open defect, owned by P1.6 and deliberately
        // NOT fixed by P1.2-P1.4. The wrapper reads its arguments out of
        // `arguments` rather than a rest parameter, so `length` is now ours to
        // set — but setting it is a behavioural change that belongs with the rest
        // of P1.6's wrapper-correctness work.
        //
        // Intended behaviour after P1.6: 2.
        expect(Task.prototype.test.length).toBe(0);

        class Undecorated {
            test(message: string, someNumber: number) { return ''; }
        }
        expect(Undecorated.prototype.test.length).toBe(2);
    });

    it('no longer stamps bookkeeping expandos onto the installed function', () => {
        // CHANGED BY P1.3: `parameterDecorated` / `parameterDecorators` were
        // written onto the method object itself. They are gone — the registry
        // holds this now (plan P1.1). Only `toString` is added, and only because
        // source transparency is load-bearing for parameter-name recovery.
        expect((Task.prototype.test as any).parameterDecorated).toBeUndefined();
        expect((Task.prototype.test as any).parameterDecorators).toBeUndefined();
        expect(Object.getOwnPropertyNames(Task.prototype.test)).toEqual(
            expect.arrayContaining(['toString']),
        );
        expect(Object.getOwnPropertyNames(Task.prototype.test)).not.toEqual(
            expect.arrayContaining(['parameterDecorated', 'parameterDecorators']),
        );
    });
});

describe('violation message formatting', () => {
    @Contract()
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
        // Byte-for-byte identical to the pre-refactor message. P1.3 rebuilt the
        // constraints on top of P1.0 descriptors; `Descriptor.formatMessage`
        // reproduces the original wording exactly so that wiring the descriptor
        // model in was not also a silent change to every error string.
        expect(messageFor(() => new Task().test('short', 500))).toBe(
            "Value Error: Task.test(message, someNumber) parameter 'message' " +
            "expected a string of length greater than 10 but received 'short' instead",
        );
    });

    it('derives the class name from the runtime prototype owner, not the caller', () => {
        // CHARACTERIZATION: with inheritance the signature reports the class that
        // *declared* the method, not the instance's class. The owner name is read
        // at install time from the prototype the contract was recorded on, and
        // that is the declaring class. P1.6 revisits inheritance handling; expect
        // this to be reconsidered there.
        @Contract()
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
     * This block used to document why `OverrideObjectDefineProperty` had to
     * exist. It now documents why it does not.
     *
     * For a method carrying parameter decorators TypeScript emits a four-argument
     * `__decorate(..., proto, "key", null)`. tslib resolves the `null` descriptor
     * to `Object.getOwnPropertyDescriptor(target, key)` *before* the decorators
     * run, and then unconditionally re-applies it:
     *
     *     return c > 3 && r && Object.defineProperty(target, key, r), r;
     *
     * That trailing call restores the ORIGINAL method. Under the old design the
     * parameter decorator had already assigned a wrapper to `target[key]`, so the
     * restore silently discarded it — hence the one-shot global patch.
     *
     * P1.3 removed the reason: parameter decorators no longer write anything to
     * the method, so there is nothing to clobber. `@Contract()` installs *after*
     * that trailing write has already happened. P1.4 then deleted the patch.
     *
     * Verified against the TypeScript 6.0.3 emitter — the `__decorate` shape is
     * unchanged, so the hazard is still real; it is simply no longer reachable.
     */

    it('leaves the wrapper installed after __decorate completes', () => {
        @Contract()
        class Task {
            test(@StringMinLength(10) message: string) { return 'ok'; }
        }

        const installed = Object.getOwnPropertyDescriptor(Task.prototype, 'test')!.value;

        // Structural evidence the wrapper (not the original) is installed: it
        // still reports the original's source through the overridden toString,
        // while its own arity is 0.
        expect(installed.length).toBe(0);
        expect(installed.toString()).toContain('test(message)');

        // Behavioural evidence: constraints actually fire. If __decorate had
        // restored the original method, this call would succeed silently — which
        // is the precise failure mode DEC-005 warns about.
        expect(() => new Task().test('short')).toThrow(/expected a string of length greater than 10/);
    });

    it('never patches Object.defineProperty at all (P1.4)', () => {
        // Previously the patch was armed during decoration and consumed by the
        // very __decorate call that armed it. There is no patch now, so the
        // identity holds continuously rather than merely being restored in time.
        const before = Object.defineProperty;

        @Contract()
        class Task {
            test(@StringMinLength(10) message: string, @GreaterThanEqual(1) n: number) { return 'ok'; }
        }
        void Task;

        expect(Object.defineProperty).toBe(before);
    });

    it('does not leak a patch across successive decorated classes', () => {
        const pristine = Object.defineProperty;

        @Contract()
        class A { a(@Positive() n: number) { return n; } }
        @Contract()
        class B { b(@Positive() n: number) { return n; } }
        @Contract()
        class C { c(@Positive() n: number) { return n; } }

        expect(Object.defineProperty).toBe(pristine);

        // and all three wrappers are live
        expect(() => new A().a(-1)).toThrow();
        expect(() => new B().b(-1)).toThrow();
        expect(() => new C().c(-1)).toThrow();
    });

    it('keeps Object.defineProperty usable immediately after a decorated class', () => {
        @Contract()
        class Task {
            test(@Positive() n: number) { return n; }
        }
        void Task;

        // A real defineProperty right after decoration must take effect. This was
        // the observable form of BUG-2.
        const probe: any = {};
        Object.defineProperty(probe, 'marker', {value: 'applied', configurable: true});
        expect(probe.marker).toBe('applied');
    });

    it('leaves an intervening Object.defineProperty untouched mid-decoration (BUG-2 containment)', () => {
        // The old patch swallowed the FIRST defineProperty after it was armed,
        // whoever made it. Field decorators are emitted before methods and so
        // never tripped it in practice, but a constructor-parameter decorator
        // could have. With no patch there is no window at all.
        const probe: any = {};

        @Contract()
        class Task {
            test(@Positive() n: number) { return n; }
        }
        Object.defineProperty(probe, 'first', {value: 1, configurable: true});
        Object.defineProperty(probe, 'second', {value: 2, configurable: true});

        void Task;
        expect(probe.first).toBe(1);
        expect(probe.second).toBe(2);
    });
});

describe('known defects pinned', () => {
    it('CHARACTERIZATION: known defect BUG-4 — a null argument raises TypeError, not a contract violation', () => {
        // `minLength`'s derived predicate dereferences `.length` with no guard,
        // so a null argument produces a bare TypeError from inside adorn instead
        // of the contract violation the caller should see. Preserved verbatim
        // through the P1.0 descriptor port; P3.3 adds uniform null/type guards.
        @Contract()
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
        @Contract()
        class Task {
            test(@Positive() n: number) { return n; }
        }

        expect(new Task().test(0)).toBe(0);
        expect(new Task().test(1)).toBe(1);
        expect(() => new Task().test(-1)).toThrow(/expected a positive number/);
    });

    it('a non-Error throw now propagates unchanged (SMELL-2 fixed)', () => {
        // CHANGED BY P1.3 — this previously pinned the defect.
        //
        // The old catch block did `e.stack.split('\n')` unconditionally. When a
        // check threw a non-Error, `e.stack` was undefined and the caller
        // received a TypeError from adorn's own error handling *instead of* the
        // original failure — the failure mode was strictly worse than no handling
        // at all. `DecoratorFactory.attributeToCaller` now ignores anything
        // without a string `stack`.
        const ThrowsAString = () => ParameterDecoratorFactory.CreateSimpleDecorator(() => {
            throw 'the original failure';
        });

        @Contract()
        class Task {
            test(@ThrowsAString() n: number) { return n; }
        }

        expect(() => new Task().test(1)).toThrow('the original failure');
        expect(() => new Task().test(1)).not.toThrow(TypeError);

        let caught: unknown;
        try {
            new Task().test(1);
        } catch (e) {
            caught = e;
        }
        // propagated as thrown, still a primitive string
        expect(caught).toBe('the original failure');
    });

    it('trims adorn frames without counting them (SMELL-2 fixed)', () => {
        // CHANGED BY P1.3 — the old implementation kept stack line 0 and dropped
        // lines 1-2, hardcoding "exactly 2 frames of adorn internals", so any
        // change to wrapper depth silently corrupted the trace.
        // `Error.captureStackTrace(err, wrapper)` elides everything up to and
        // including the wrapper without counting anything, so the assertion can
        // now be strict about the WHOLE stack rather than just its first frames.
        @Contract()
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
        // no adorn internals anywhere in the trace, at any depth
        expect(stack).not.toContain('ParameterDecoratorFactory');
        expect(stack).not.toContain('MethodDecoratorFactory');
        // and the caller's own frame is the first one reported
        expect(lines[1]).toContain('parameter-decorator-core.test.ts');
    });
});

describe('ParameterDecoratorFactory.CreateSimpleDecorator (public authoring surface)', () => {
    it('passes a fully populated ParamObject to the decorator body', () => {
        const seen: any[] = [];
        const Capture = () => ParameterDecoratorFactory.CreateSimpleDecorator(params => {
            seen.push({...params});
        });

        @Contract()
        class Task {
            doWork(@Capture() alpha: string, @Capture() beta: number) { return 'ok'; }
        }

        new Task().doWork('a', 1);

        expect(seen).toHaveLength(2);
        // CHANGED BY P1.3: declaration order, so alpha (index 0) is seen first.
        // This previously asserted beta first — see the SMELL-11 note above.
        expect(seen[0]).toEqual({
            objectName: 'Task',
            funcName: 'doWork',
            paramName: 'alpha',
            value: 'a',
            signature: "Task.doWork(alpha, beta) parameter 'alpha'",
        });
        expect(seen[1]).toMatchObject({paramName: 'beta', value: 1});
    });

    it('does not let a decorator mutate the arguments actually passed through', () => {
        // CHARACTERIZATION: `ParamObject.value` is a copy; writing to it is a
        // silent no-op. The disabled "Deconstruct parameter value changes" line
        // in the old factory showed this was once intended to work. Pinned so
        // that if coercion/modifier support lands, it is a deliberate change.
        const Mutate = () => ParameterDecoratorFactory.CreateSimpleDecorator((params: any) => {
            params.value = 'CHANGED';
        });

        @Contract()
        class Task {
            doWork(@Mutate() alpha: string) { return alpha; }
        }

        expect(new Task().doWork('original')).toBe('original');
    });

    it('hand-written closures are enforced but stay invisible to the registry', () => {
        // The honest consequence of keeping this authoring form (ISSUES.md Q-3):
        // a closure carries no identity and no params, so ContractRegistry
        // refuses it by design and no projection can ever see it. It is staged
        // adapter-side instead, and enforced exactly as before.
        const NonEmpty = () => ParameterDecoratorFactory.CreateSimpleDecorator((params: any) => {
            if (!params.value) throw new Error(`Value Error: ${params.signature} must not be empty`);
        });

        @Contract()
        class Task {
            doWork(@NonEmpty() alpha: string) { return alpha; }
        }

        expect(new Task().doWork('x')).toBe('x');
        expect(() => new Task().doWork('')).toThrow(/must not be empty/);

        // enforced, but not projectable
        expect(getContract(Task.prototype, 'doWork')).toBeUndefined();
    });
});
