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
    GreaterThan,
    GreaterThanEqual,
    LessThanEqual,
    StringMinLength,
} from '../src/ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from '../src/Core/ParameterDecoratorFactory';
import {getContract, getContractedClasses} from '../src/Core/ContractRegistry';
import {
    resetConfiguration,
    setAssertEnforcement,
    setEnforcementMode,
    setViolationPolicy,
} from '../src/Core/Configuration';

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
            send(@StringMinLength(10) message: string) {
                return message;
            }
            count(@GreaterThan(0) n: number) {
                return n;
            }
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
            send(@StringMinLength(10) message: string) {
                return message;
            }
        }

        expect(new Forgotten().send('short')).toBe('short'); // no throw
        expect(getContractedClasses()).not.toContain(Forgotten as unknown as Function);

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
    });

    it('stays silent when @Contract() is present', () => {
        @Contract()
        class Remembered {
            send(@StringMinLength(10) message: string) {
                return message;
            }
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
            run(@Custom() n: number) {
                return n;
            }
        }
        void ForgottenLegacy;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('ForgottenLegacy');
    });

    it('warns only once per class', () => {
        class WarnOnce {
            run(@GreaterThan(0) n: number) {
                return n;
            }
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
            run(@GreaterThan(0) n: number) {
                return n;
            }
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
                run(@GreaterThan(0) n: number) {
                    return n;
                }
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
            run(@GreaterThan(0) n: number) {
                return n;
            }
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
            send(@StringMinLength(10) message: string) {
                return message;
            }
            count(@GreaterThanEqual(10) @LessThanEqual(20) n: number) {
                return n;
            }
            untouched(anything: unknown) {
                return anything;
            }
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
            contracted(@GreaterThan(0) n: number) {
                return n;
            }
            plain(n: number) {
                return n;
            }
        }

        // an untouched method keeps its real arity, which the wrapper does not
        expect(Task.prototype.plain.length).toBe(1);
        expect(Task.prototype.contracted.length).toBe(0);
    });

    it('registers the class for projection enumeration (DEC-011)', () => {
        @Contract()
        class Enumerable {
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }

        expect(getContractedClasses()).toContain(Enumerable as unknown as Function);
    });

    it('registers a class even when it has no contracts to install', () => {
        // `@Contract()` is the enumeration marker as well as the installer, so a
        // deliberately-annotated but constraint-free class is still discoverable.
        @Contract()
        class Empty {
            run(n: number) {
                return n;
            }
        }

        expect(getContractedClasses()).toContain(Empty as unknown as Function);
    });

    it('installs contracts on static methods', () => {
        @Contract()
        class Task {
            static parse(@StringMinLength(3) input: string) {
                return input.trim();
            }
        }

        expect(Task.parse('abcd')).toBe('abcd');
        expect(() => Task.parse('ab')).toThrow(/length greater than 3/);
    });

    it('names the CLASS in a static violation, not Function (BUG-12)', () => {
        @Contract()
        class Task {
            static parse(@StringMinLength(3) input: string) {
                return input.trim();
            }
            run(@StringMinLength(3) input: string) {
                return input.trim();
            }
        }

        // PREVIOUSLY UNPINNED, which is why the bug survived: the test above matches only the
        // expectation clause, so it passed just as happily against `Function.parse(input)`.
        //
        // `DecoratorFactory.getObjectName` read `target.constructor.name`. That is right for a
        // prototype and wrong for a constructor — and a static member's decoration target IS the
        // constructor, so `.constructor` was `Function`. The instance form was correct throughout,
        // which is what made the discrepancy easy to miss.
        expect(() => Task.parse('ab')).toThrow(
            "Value Error: Task.parse(input) parameter 'input' " +
                'expected a string of length greater than 3 but received [REDACTED] instead',
        );

        // The instance form is asserted alongside it, so the two bands are pinned as agreeing rather
        // than as two independent facts.
        expect(() => new Task().run('ab')).toThrow(
            "Value Error: Task.run(input) parameter 'input' " +
                'expected a string of length greater than 3 but received [REDACTED] instead',
        );
    });

    it('is idempotent — installing twice does not double-wrap', () => {
        @Contract()
        class Task {
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }

        const installed = Task.prototype.run;
        installContracts(Task);
        expect(Task.prototype.run).toBe(installed);
        expect(() => new Task().run(-1)).toThrow(/greater than 0/);
    });

    it('marks the contract installed in the registry', () => {
        @Contract()
        class Task {
            run(@GreaterThan(0) n: number) {
                return n;
            }
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
            run(@GreaterThanEqual(0) n: number) {
                return `base:${n}`;
            }
        }

        @Contract()
        class Sub extends Base {
            run(@GreaterThanEqual(100) n: number) {
                return `sub:${n}`;
            }
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
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }

        expect(new Task().run(1)).toBe(1);
        expect(() => new Task().run(-1)).toThrow(/greater than 0/);
    });

    it('satisfies the diagnostic for the method it covers', () => {
        class Task {
            @Validate()
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }
        void Task;

        flushContractDiagnostics();
        expect(warnings).toEqual([]);
    });

    it('still warns for a sibling method it does not cover', () => {
        class Partial {
            @Validate()
            covered(@GreaterThan(0) n: number) {
                return n;
            }

            uncovered(@GreaterThan(0) n: number) {
                return n;
            }
        }
        void Partial;

        flushContractDiagnostics();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('uncovered');
        expect(warnings[0]).not.toContain('covered,');
    });

    it('registers the class for projection — installation implies enumeration (Q-12)', () => {
        // CHANGED, and deliberately: this previously asserted the OPPOSITE, that
        // `@Validate()` enforced without enumerating. That made a class using only
        // the per-method form enforced-but-undocumented — adorn guaranteeing
        // something at runtime that it would not admit to in a generated artifact.
        // Silently missing from an artifact people trust is the failure the plan
        // calls worse than being unenforced, because nothing ever throws to reveal
        // it (plan §8). Settled as: anything adorn installs, it also enumerates.
        class ValidatedOnly {
            @Validate()
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }
        void ValidatedOnly;

        expect(getContractedClasses()).toContain(ValidatedOnly as unknown as Function);
    });

    it('registers a class whose validated method carries no constraints yet', () => {
        // Enumeration marks intent to be visible, so it does not depend on there
        // being anything to install — same rule `@Contract()` already followed for
        // a constraint-free class.
        class NothingYet {
            @Validate()
            run(n: number) {
                return n;
            }
        }
        void NothingYet;

        expect(getContractedClasses()).toContain(NothingYet as unknown as Function);
    });

    it('leaves a sibling method visible but flagged as not installed', () => {
        // The consequence of enumerating from a per-method decorator: the class is
        // in the artifact, and an uncovered sibling shows up as recorded-but-not-
        // enforced rather than vanishing with the whole class.
        class Mixed {
            @Validate()
            covered(@GreaterThan(0) n: number) {
                return n;
            }

            uncovered(@GreaterThan(0) n: number) {
                return n;
            }
        }
        void Mixed;

        expect(getContractedClasses()).toContain(Mixed as unknown as Function);
        expect(getContract(Mixed.prototype, 'covered')!.installed).toBe(true);
        expect(getContract(Mixed.prototype, 'uncovered')!.installed).toBe(false);
    });

    it('composes with @Contract() without double-wrapping', () => {
        @Contract()
        class Both {
            @Validate()
            run(@GreaterThan(0) n: number) {
                return n;
            }
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
            run(n: number) {
                return n;
            }
        }

        expect(new Task().run(5)).toBe(5);
        expect(Task.prototype.run.length).toBe(1); // never wrapped
    });
});

describe('production toggling by trust (P3.2 / DEC-008)', () => {
    afterEach(resetConfiguration);

    it('keeps guards enforced in production and strips asserts', () => {
        // The assertion the whole trust model exists for. `@Contract()` with no
        // trust option defaults to `guard`, so a contract an author said nothing
        // about survives production — the safe direction to be wrong in.
        @Contract()
        class Boundary {
            handle(@GreaterThan(0) n: number) {
                return n;
            }
        }

        @Contract({trust: 'assert'})
        class Internal {
            check(@GreaterThan(0) n: number) {
                return n;
            }
        }

        setEnforcementMode('production');

        expect(() => new Boundary().handle(-1)).toThrow(/greater than 0/);
        expect(new Internal().check(-1)).toBe(-1); // stripped

        setEnforcementMode('development');

        expect(() => new Boundary().handle(-1)).toThrow(/greater than 0/);
        expect(() => new Internal().check(-1)).toThrow(/greater than 0/);
    });

    it('applies trust per method through @Validate()', () => {
        class Mixed {
            @Validate()
            boundary(@GreaterThan(0) n: number) {
                return n;
            }

            @Validate({trust: 'assert'})
            internal(@GreaterThan(0) n: number) {
                return n;
            }
        }

        setEnforcementMode('production');

        const mixed = new Mixed();
        expect(() => mixed.boundary(-1)).toThrow(/greater than 0/);
        expect(mixed.internal(-1)).toBe(-1);
    });

    it('resolves trust at install time, but reads the gate per call', () => {
        // Flipping the switch after the class is decorated still takes effect —
        // the gate is evaluated on the hot path, not baked into the wrapper.
        @Contract({trust: 'assert'})
        class Internal {
            check(@GreaterThan(0) n: number) {
                return n;
            }
        }

        expect(() => new Internal().check(-1)).toThrow(/greater than 0/);

        setAssertEnforcement(false);
        expect(new Internal().check(-1)).toBe(-1);

        setAssertEnforcement(true);
        expect(() => new Internal().check(-1)).toThrow(/greater than 0/);
    });

    it("routes violations without throwing under onViolation: 'warn', and still runs the method", () => {
        @Contract()
        class Task {
            run(@GreaterThan(0) n: number) {
                return `ran:${n}`;
            }
        }

        const seen: string[] = [];
        setViolationPolicy(violation => {
            seen.push((violation as Error).message);
        });

        // Suppressed, so the call proceeds — which is the point of 'warn': stage a
        // new contract over live traffic before letting it reject anything.
        expect(new Task().run(-1)).toBe('ran:-1');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatch(/greater than 0/);
    });

    it('tells a custom handler which class, method, and trust level violated', () => {
        @Contract({trust: 'assert'})
        class Task {
            run(@GreaterThan(0) n: number) {
                return n;
            }
        }

        const sites: Array<{owner: string; member: string; trust: string}> = [];
        setViolationPolicy((_violation, site) => {
            sites.push({...site});
        });

        new Task().run(-1);

        expect(sites).toEqual([{owner: 'Task', member: 'run', trust: 'assert'}]);
    });

    it('does not route a failure thrown by the method itself', () => {
        // Only contract checks go through the policy. A method's own exception is
        // the caller's business and must propagate untouched even when violations
        // are being suppressed.
        @Contract()
        class Task {
            run(@GreaterThan(0) n: number): number {
                throw new Error(`method blew up on ${n}`);
            }
        }

        setViolationPolicy(() => undefined);

        expect(() => new Task().run(1)).toThrow(/method blew up on 1/);
    });
});
