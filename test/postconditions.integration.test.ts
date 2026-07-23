/**
 * The postcondition seam, end to end (Q-11, plan B §4/§5/§8).
 *
 * `@Ensures` records; `@Contract()`/`@Validate()` install the combined wrapper that runs
 * preconditions before `proceed()` and postconditions after. These pin the chosen defaults — throw
 * skips, async awaits-then-checks, a rejection skips — plus blame, the assert-trust default, inheritance
 * conjunction, the `@Validate()` ordering caveat, and the no-drift property the fuzzer depends on.
 */

import {Contract, Validate} from '../src/Core/ContractInstaller';
import {Ensures} from '../src/MethodDecorators/Ensures';
import {GreaterThan} from '../src/ParameterDecorators/Constraints';
import {getEffectivePostconditions, resetRegistry} from '../src/Core/ContractRegistry';
import {evaluatePostconditions} from '../src/Core/Postconditions';
import {
    resetConfiguration,
    setEnforcementMode,
    setViolationPolicy,
    ViolationSite,
} from '../src/Core/Configuration';
import {resetValueDisclosure, setValueDisclosure} from '../src/Core/redaction';
import {resetContractDiagnostics, setContractDiagnosticsSink} from '../src/Core/ContractDiagnostics';

beforeEach(() => {
    resetRegistry();
    resetConfiguration();
    resetValueDisclosure();
    resetContractDiagnostics();
    setContractDiagnosticsSink(() => {}); // swallow the recorded-but-unenforced warnings under test
});
afterEach(resetContractDiagnostics);

describe('synchronous enforcement', () => {
    it('throws when the return value violates a postcondition, and returns it when it holds', () => {
        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'the id is positive')
            make(n: number): number {
                return n;
            }
        }

        expect(new Ids().make(5)).toBe(5);
        expect(() => new Ids().make(-1)).toThrow(/Postcondition failed/);
    });

    it('redacts the returned value by default and blames the callee', () => {
        const seen: ViolationSite[] = [];
        setViolationPolicy((_violation, site) => {
            seen.push(site);
        });

        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'the id is positive')
            make(n: number): number {
                return n;
            }
        }

        new Ids().make(-42); // handler suppresses; the value is returned
        expect(seen).toHaveLength(1);
        expect(seen[0].blame).toBe('callee');
        expect(seen[0].owner).toBe('Ids');
        expect(seen[0].member).toBe('make');
    });

    it('discloses the raw value in the message only under setValueDisclosure("all")', () => {
        setValueDisclosure('all');

        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'positive')
            make(n: number): number {
                return n;
            }
        }

        expect(() => new Ids().make(-42)).toThrow(/-42/);
    });
});

describe('a method that throws — postconditions skip, the exception propagates untouched', () => {
    it('does not run the postcondition and re-throws the method’s own error', () => {
        const predicate = jest.fn(() => true);
        const own = new Error('method failure');

        @Contract()
        class Boom {
            @Ensures(predicate as never, 'never reached')
            go(): number {
                throw own;
            }
        }

        expect(() => new Boom().go()).toThrow(own); // the identical error object
        expect(predicate).not.toHaveBeenCalled();
    });
});

describe('async — await the settled value, then check; a rejection skips', () => {
    it('awaits the resolved value and rejects with the postcondition Error on violation', async () => {
        @Contract()
        class Api {
            @Ensures(r => (r as number) > 0, 'positive')
            async fetch(n: number): Promise<number> {
                return n;
            }
        }

        await expect(new Api().fetch(3)).resolves.toBe(3);
        await expect(new Api().fetch(-1)).rejects.toThrow(/Postcondition failed/);
    });

    it('skips postconditions when the promise rejects, propagating the rejection unchanged', async () => {
        const predicate = jest.fn(() => true);

        @Contract()
        class Api {
            @Ensures(predicate as never, 'never reached')
            async boom(): Promise<number> {
                throw new Error('async boom');
            }
        }

        await expect(new Api().boom()).rejects.toThrow('async boom');
        expect(predicate).not.toHaveBeenCalled();
    });
});

describe('violation policy', () => {
    it("'warn' proceeds and returns the (violating) value", () => {
        const warnings: string[] = [];
        setViolationPolicy('warn');
        // route Configuration's own warning emit through nothing special — jest console is fine, but
        // we only care that the value comes back.
        void warnings;

        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'positive')
            make(n: number): number {
                return n;
            }
        }

        expect(new Ids().make(-7)).toBe(-7);
    });
});

describe('trust — postconditions default to assert and strip in production', () => {
    it('does not enforce a postcondition when assert is stripped', () => {
        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'positive')
            make(n: number): number {
                return n;
            }
        }

        // Dev (default): enforced.
        expect(() => new Ids().make(-1)).toThrow(/Postcondition failed/);

        // Production: assert stripped, so the postcondition no longer runs.
        setEnforcementMode('production');
        expect(new Ids().make(-1)).toBe(-1);
    });
});

describe('installation shapes', () => {
    it('installs and enforces a postcondition-only method (no parameter constraints)', () => {
        @Contract()
        class Only {
            @Ensures(r => (r as number) >= 0, 'non-negative')
            abs(n: number): number {
                return n; // deliberately not abs, to allow a violation
            }
        }

        expect(new Only().abs(4)).toBe(4);
        expect(() => new Only().abs(-4)).toThrow(/Postcondition failed/);
    });

    it('runs preconditions (caller-blamed) and postconditions (callee-blamed) on one method', () => {
        const sites: ViolationSite[] = [];
        setViolationPolicy((_v, site) => {
            sites.push(site);
        });

        @Contract()
        class Combined {
            @Ensures(r => (r as number) < 100, 'result under 100')
            scale(@GreaterThan(0) n: number): number {
                return n;
            }
        }

        new Combined().scale(-5); // precondition fails (n not > 0)
        expect(sites[sites.length - 1].blame).toBe('caller');

        sites.length = 0;
        new Combined().scale(500); // precondition ok, postcondition fails (>= 100)
        expect(sites.map(s => s.blame)).toContain('callee');
    });
});

describe('inheritance — a subclass postcondition conjoins the parent’s (covariant strengthening)', () => {
    it('enforces both the parent and the subclass promise, base-most reported first', () => {
        @Contract()
        class Base {
            @Ensures(r => (r as number) > 0, 'positive')
            make(n: number): number {
                return n;
            }
        }
        @Contract()
        class Sub extends Base {
            @Ensures(r => (r as number) < 100, 'under 100')
            make(n: number): number {
                return n;
            }
        }

        expect(new Sub().make(50)).toBe(50);
        // Base-most first: the parent's broken guarantee is the one reported.
        expect(() => new Sub().make(-1)).toThrow(/positive/);
        expect(() => new Sub().make(200)).toThrow(/under 100/);
    });
});

describe('the @Validate() + @Ensures() ordering caveat (plan B §5, characterization)', () => {
    it('enforces when @Ensures sits below @Validate, and does NOT when it sits above', () => {
        class Sample {
            @Validate()
            @Ensures(r => (r as number) > 0, 'positive')
            ordered(n: number): number {
                return n;
            }

            @Ensures(r => (r as number) > 0, 'positive')
            @Validate()
            reversed(n: number): number {
                return n;
            }
        }

        const s = new Sample();
        // @Ensures below @Validate → @Validate saw it → enforced.
        expect(() => s.ordered(-1)).toThrow(/Postcondition failed/);
        // @Ensures above @Validate → @Validate ran first, saw nothing → recorded-but-unenforced.
        expect(s.reversed(-1)).toBe(-1);
    });
});

describe('the fuzzer handoff — evaluatePostconditions is the oracle the wrapper enforces (no drift)', () => {
    it('the wrapper flags a violation exactly when the shared oracle says {ok:false}', () => {
        // A handler that records and suppresses, so the wrapper returns the raw result every time and
        // we can read it — while still learning whether the wrapper detected a violation.
        let flagged = false;
        setViolationPolicy(() => {
            flagged = true;
        });

        @Contract()
        class Doubler {
            @Ensures((r, a) => (r as number) === (a as number) * 2, 'doubles the input')
            maybeDouble(n: number): number {
                return n < 0 ? n : n * 2; // buggy for negatives
            }
        }

        // The exact read + evaluator the fuzz driver (Phase B) will call.
        const posts = getEffectivePostconditions(Doubler.prototype, 'maybeDouble');
        expect(posts.length).toBe(1); // hasOracle — this method is fuzzable

        const instance = new Doubler();
        for (const n of [-3, -1, 0, 2, 5]) {
            flagged = false;
            const result = instance.maybeDouble(n);
            const verdict = evaluatePostconditions(posts, result, [n]);
            // The wrapper's enforcement decision and the fuzzer's oracle verdict are the same, because
            // they are the same function over the same posts — one declaration, two consumers.
            expect(flagged).toBe(!verdict.ok);
        }
    });
});
