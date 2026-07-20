/**
 * P1.3 — registry-driven installation, and the DX regression it buys the fix
 * with.
 *
 * The first suite below is the important one. `@Contract()` eliminates the
 * `Object.defineProperty` monkey-patch (DEC-005), but it does so by making
 * installation explicit — which means **forgetting the annotation silently
 * deletes every contract on the class**. No error, no crash, the method just
 * runs unguarded, and the class also disappears from documentation and fuzzing.
 *
 * The plan calls that its single biggest DX regression and its top risk, and
 * makes the development-mode warning mandatory rather than optional. These tests
 * are what hold it to that.
 */

import {Contract, installContracts, Validate} from '../src/Core/ContractInstaller';
import {
    flushContractDiagnostics,
    resetContractDiagnostics,
    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
} from '../src/Core/ContractDiagnostics';
import {
    GreaterThanEqual,
    LessThanEqual,
    Positive,
    StringMinLength,
} from '../src/ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from '../src/Core/ParameterDecoratorFactory';
import {getContract, getContractedClasses} from '../src/Core/ContractRegistry';

describe('the missing-@Contract() diagnostic (mandatory, plan top risk 1)', () => {
    let warnings: string[];

    beforeEach(() => {
        resetContractDiagnostics();
        warnings = [];
        setContractDiagnosticsSink(message => warnings.push(message));
    });

    afterEach(() => {
        resetContractDiagnostics();
    });

    it('warns, naming the class and the affected methods, when @Contract() is missing', () => {
        class Forgotten {
            send(@StringMinLength(10) message: string) { return message; }
            count(@Positive() n: number) { return n; }
        }
        void Forgotten;

        flushContractDiagnostics();

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Forgotten');
        expect(warnings[0]).toContain('count, send');
        expect(warnings[0]).toContain('@Contract()');
        // it must say what the consequence is, not just that something is off
        expect(warnings[0]).toContain('NOT being enforced');
    });

    it('confirms the silent failure the warning exists to reveal', () => {
        // Without the annotation the constraint genuinely does nothing. This is
        // the behaviour that would otherwise ship undetected.
        class Forgotten {
            send(@StringMinLength(10) message: string) { return message; }
        }

        expect(new Forgotten().send('short')).toBe('short'); // no throw
        expect(getContractedClasses()).not.toContain(Forgotten as unknown as Function);

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
    });

    it('stays silent when @Contract() is present', () => {
        @Contract()
        class Remembered {
            send(@StringMinLength(10) message: string) { return message; }
        }
        void Remembered;

        flushContractDiagnostics();
        expect(warnings).toEqual([]);
    });

    it('also fires for hand-written CreateSimpleDecorator closures', () => {
        // Those never reach ContractRegistry (a closure has no identity or
        // params, so the registry refuses it by design), so a warning driven
        // solely off the registry's `installed` flag would miss them — even
        // though forgetting `@Contract()` breaks them identically.
        const Custom = () => ParameterDecoratorFactory.CreateSimpleDecorator(() => undefined);

        class ForgottenLegacy {
            run(@Custom() n: number) { return n; }
        }
        void ForgottenLegacy;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('ForgottenLegacy');
    });

    it('warns only once per class', () => {
        class WarnOnce {
            run(@Positive() n: number) { return n; }
        }
        void WarnOnce;

        flushContractDiagnostics();
        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
    });

    it('fires automatically on the microtask queue, without an explicit flush', async () => {
        // The check cannot run at decoration time: TypeScript emits member
        // decorators BEFORE the class decorator, so when a parameter decorator
        // runs it genuinely cannot know whether `@Contract()` is coming. Nor can
        // it run on first call — an uninstalled method has no wrapper to hook.
        // Deferring by one microtask is what makes the answer knowable.
        class Deferred {
            run(@Positive() n: number) { return n; }
        }
        void Deferred;

        expect(warnings).toEqual([]); // nothing yet, synchronously
        await Promise.resolve();
        expect(warnings).toHaveLength(1);
    });

    it('is silent in production mode', () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            class ProdClass {
                run(@Positive() n: number) { return n; }
            }
            void ProdClass;
            flushContractDiagnostics();
            expect(warnings).toEqual([]);
        } finally {
            process.env.NODE_ENV = previous;
        }
    });

    it('can be silenced explicitly — without that making the contracts work', () => {
        setContractDiagnosticsEnabled(false);

        class Silenced {
            run(@Positive() n: number) { return n; }
        }

        flushContractDiagnostics();
        expect(warnings).toEqual([]);
        // silencing the diagnostic does not install anything; it is an escape
        // hatch for noise, not a correctness switch
        expect(new Silenced().run(-1)).toBe(-1);
    });
});

describe('@Contract() installation', () => {
    it('enforces every recorded constraint on the class with one annotation', () => {
        @Contract()
        class Task {
            send(@StringMinLength(10) message: string) { return message; }
            count(@GreaterThanEqual(10) @LessThanEqual(20) n: number) { return n; }
            untouched(anything: unknown) { return anything; }
        }

        const task = new Task();
        expect(task.send('0123456789')).toBe('0123456789');
        expect(() => task.send('short')).toThrow(/length greater than 10/);
        expect(task.count(15)).toBe(15);
        expect(() => task.count(5)).toThrow(/greater than or equal to 10/);
        expect(() => task.count(25)).toThrow(/less than or equal to 20/);
    });

    it('leaves methods without contracts completely untouched', () => {
        @Contract()
        class Task {
            contracted(@Positive() n: number) { return n; }
            plain(n: number) { return n; }
        }

        // an untouched method keeps its real arity, which the wrapper does not
        expect(Task.prototype.plain.length).toBe(1);
        expect(Task.prototype.contracted.length).toBe(0);
    });

    it('registers the class for projection enumeration (DEC-011)', () => {
        @Contract()
        class Enumerable {
            run(@Positive() n: number) { return n; }
        }

        expect(getContractedClasses()).toContain(Enumerable as unknown as Function);
    });

    it('registers a class even when it has no contracts to install', () => {
        // `@Contract()` is the enumeration marker as well as the installer, so a
        // deliberately-annotated but constraint-free class is still discoverable.
        @Contract()
        class Empty {
            run(n: number) { return n; }
        }

        expect(getContractedClasses()).toContain(Empty as unknown as Function);
    });

    it('installs contracts on static methods', () => {
        @Contract()
        class Task {
            static parse(@StringMinLength(3) input: string) { return input.trim(); }
        }

        expect(Task.parse('abcd')).toBe('abcd');
        expect(() => Task.parse('ab')).toThrow(/length greater than 3/);
    });

    it('is idempotent — installing twice does not double-wrap', () => {
        @Contract()
        class Task {
            run(@Positive() n: number) { return n; }
        }

        const installed = Task.prototype.run;
        installContracts(Task);
        expect(Task.prototype.run).toBe(installed);
        expect(() => new Task().run(-1)).toThrow(/positive/);
    });

    it('marks the contract installed in the registry', () => {
        @Contract()
        class Task {
            run(@Positive() n: number) { return n; }
        }
        void Task;

        expect(getContract(Task.prototype, 'run')!.installed).toBe(true);
    });

    it('does not let a subclass corrupt its parent contract', () => {
        // The inheritance bug in the old factory: it read `target[propertyKey]`,
        // which resolves through the prototype chain, found the PARENT's wrapper,
        // saw the `parameterDecorated` expando and pushed into the parent's
        // decorator list — corrupting the base class for every other subclass.
        // Registry lookups are own-property scoped, so a subclass now starts with
        // an empty contract.
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) { return `base:${n}`; }
        }

        @Contract()
        class Sub extends Base {
            run(@GreaterThanEqual(100) n: number) { return `sub:${n}`; }
        }

        class Other extends Base {}

        expect(new Base().run(5)).toBe('base:5');
        expect(() => new Base().run(-1)).toThrow(/greater than or equal to 0/);

        expect(new Sub().run(500)).toBe('sub:500');
        expect(() => new Sub().run(5)).toThrow(/greater than or equal to 100/);

        // the parent's contract is unchanged for everyone else
        expect(new Other().run(5)).toBe('base:5');
        expect(() => new Other().run(-1)).toThrow(/greater than or equal to 0/);

        expect(getContract(Base.prototype, 'run')!.params[0].constraints).toHaveLength(1);
        expect(getContract(Sub.prototype, 'run')!.params[0].constraints).toHaveLength(1);
    });

    it('rejects being applied to something that is not a class', () => {
        expect(() => installContracts({} as any)).toThrow(/must be applied to a class/);
    });
});

describe('@Validate() per-method opt-in (plan P1.3, option A2)', () => {
    let warnings: string[];

    beforeEach(() => {
        resetContractDiagnostics();
        warnings = [];
        setContractDiagnosticsSink(message => warnings.push(message));
    });

    afterEach(() => resetContractDiagnostics());

    it('enforces the method it is written on', () => {
        class Task {
            @Validate()
            run(@Positive() n: number) { return n; }
        }

        expect(new Task().run(1)).toBe(1);
        expect(() => new Task().run(-1)).toThrow(/positive/);
    });

    it('satisfies the diagnostic for the method it covers', () => {
        class Task {
            @Validate()
            run(@Positive() n: number) { return n; }
        }
        void Task;

        flushContractDiagnostics();
        expect(warnings).toEqual([]);
    });

    it('still warns for a sibling method it does not cover', () => {
        class Partial {
            @Validate()
            covered(@Positive() n: number) { return n; }

            uncovered(@Positive() n: number) { return n; }
        }
        void Partial;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('uncovered');
        expect(warnings[0]).not.toContain('covered,');
    });

    it('does NOT register the class for projection — that is @Contract()\'s job', () => {
        class ValidatedOnly {
            @Validate()
            run(@Positive() n: number) { return n; }
        }
        void ValidatedOnly;

        // Enforced but invisible to documentation and fuzzing (DEC-011). This is
        // the trade `@Validate()` makes and the reason `@Contract()` is the
        // recommended form.
        expect(getContractedClasses()).not.toContain(ValidatedOnly as unknown as Function);
    });

    it('composes with @Contract() without double-wrapping', () => {
        @Contract()
        class Both {
            @Validate()
            run(@Positive() n: number) { return n; }
        }

        let thrown = 0;
        try {
            new Both().run(-1);
        } catch {
            thrown++;
        }
        expect(thrown).toBe(1);
        expect(new Both().run(1)).toBe(1);
    });

    it('is harmless on a method with no constraints', () => {
        class Task {
            @Validate()
            run(n: number) { return n; }
        }

        expect(new Task().run(5)).toBe(5);
        expect(Task.prototype.run.length).toBe(1); // never wrapped
    });
});
