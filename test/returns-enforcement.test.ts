/**
 * The reified `@Returns(<descriptor>)` seam, end to end (DEC-033, plan Item 2).
 *
 * `@Returns` records a `ConstraintDescriptor` into the reserved `post` band; `@Contract()`/`@Validate()`
 * install the combined wrapper that checks the return value against it after `proceed()`. These pin the
 * chosen semantics — a violating return throws, a valid one passes, redaction-by-default, callee blame,
 * the `assert`-trust default, async settling, throw/rejection skip, inheritance conjunction — and the
 * two cross-cutting invariants the plan flags as highest-risk:
 *
 *  1. **Two postcondition bands coexist** and the reified band is checked first (`@Returns` before
 *     `@Ensures`), so the most structured broken guarantee is reported first.
 *  2. **A `@Returns`-only method is enforced AND documented AND schema’d** — the three consumers (weave,
 *     docs, schema) each read the reified band, so a `@Returns`-only method is never the DEC-016
 *     "enforced but undocumented" asymmetry.
 */

import {Contract, Validate} from '../src/Adapters/legacy/ContractInstaller';
import {Returns} from '../src/MethodDecorators/Returns';
import {Ensures} from '../src/MethodDecorators/Ensures';
import {GreaterThan, GreaterThanEqual, LessThanEqual} from '../src/Contracts/number';
import {resetRegistry} from '../src/Core/ContractRegistry';
import {
    resetConfiguration,
    setEnforcementMode,
    setViolationPolicy,
    ViolationSite,
} from '../src/Core/Configuration';
import {resetValueDisclosure, setValueDisclosure} from '../src/Core/redaction';
import {
    resetContractDiagnostics,
    setContractDiagnosticsSink,
} from '../src/Adapters/legacy/ContractDiagnostics';
import {generateMarkdown} from '../src/Projections/docs';
import {generateSchema} from '../src/Projections/schema';

beforeEach(() => {
    resetRegistry();
    resetConfiguration();
    resetValueDisclosure();
    resetContractDiagnostics();
    setContractDiagnosticsSink(() => {}); // swallow the recorded-but-unenforced warnings under test
});
afterEach(resetContractDiagnostics);

describe('synchronous enforcement', () => {
    it('throws when the return value violates the descriptor, and returns it when it holds', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }

        expect(new Ledger().balance(5)).toBe(5);
        expect(() => new Ledger().balance(-1)).toThrow(/return value/);
        // The descriptor's own message machinery renders it (DEC-010), naming the expectation.
        expect(() => new Ledger().balance(-1)).toThrow(/greater than or equal to 0/);
    });

    it('redacts the returned value by default and blames the callee', () => {
        const seen: ViolationSite[] = [];
        const messages: string[] = [];
        setViolationPolicy((violation, site) => {
            seen.push(site);
            messages.push((violation as Error).message);
        });

        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }

        new Ledger().balance(-42); // handler suppresses; the value is returned
        expect(seen).toHaveLength(1);
        expect(seen[0].blame).toBe('callee');
        expect(seen[0].owner).toBe('Ledger');
        expect(seen[0].member).toBe('balance');
        // DEC-030: the return value is redacted by default (a return cannot be @Sensitive — Q-23 — so
        // disclosure follows the global switch alone, which is off).
        expect(messages[0]).toContain('[REDACTED]');
        expect(messages[0]).not.toContain('-42');
    });

    it('discloses the raw value in the message only under setValueDisclosure("all")', () => {
        setValueDisclosure('all');

        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }

        expect(() => new Ledger().balance(-42)).toThrow(/-42/);
    });
});

describe('a method that throws — the return check skips, the exception propagates untouched', () => {
    it('does not run the descriptor and re-throws the method’s own error', () => {
        const own = new Error('method failure');

        @Contract()
        class Boom {
            @Returns(GreaterThanEqual(0))
            go(): number {
                throw own;
            }
        }

        expect(() => new Boom().go()).toThrow(own); // the identical error object, not a return violation
    });
});

describe('async — await the settled value, then check; a rejection skips', () => {
    it('awaits the resolved value and rejects with the return violation on failure', async () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async fetch(n: number): Promise<number> {
                return n;
            }
        }

        await expect(new Api().fetch(3)).resolves.toBe(3);
        await expect(new Api().fetch(-1)).rejects.toThrow(/return value/);
    });

    it('skips the return check when the promise rejects, propagating the rejection unchanged', async () => {
        @Contract()
        class Api {
            @Returns(GreaterThanEqual(0))
            async boom(): Promise<number> {
                throw new Error('async boom');
            }
        }

        await expect(new Api().boom()).rejects.toThrow('async boom');
    });
});

describe('violation policy', () => {
    it("'warn' proceeds and returns the (violating) value", () => {
        setViolationPolicy('warn');

        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }

        expect(new Ledger().balance(-7)).toBe(-7);
    });
});

describe('trust — the reified band defaults to assert and strips in production', () => {
    it('does not enforce the return descriptor when assert is stripped', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }

        // Dev (default): enforced.
        expect(() => new Ledger().balance(-1)).toThrow(/return value/);

        // Production: assert stripped, so the return check no longer runs (the same POSTCONDITION_TRUST
        // gate the closure band uses — no parallel machinery).
        setEnforcementMode('production');
        expect(new Ledger().balance(-1)).toBe(-1);
    });
});

describe('inheritance — a subclass @Returns conjoins the parent’s (covariant strengthening, free)', () => {
    it('enforces both the parent and the subclass descriptor, base-most reported first', () => {
        @Contract()
        class Base {
            @Returns(GreaterThan(0))
            make(n: number): number {
                return n;
            }
        }
        @Contract()
        class Sub extends Base {
            @Returns(LessThanEqual(100))
            make(n: number): number {
                return n;
            }
        }

        expect(new Sub().make(50)).toBe(50);
        // Base-most first: the parent's broken guarantee is the one reported.
        expect(() => new Sub().make(-1)).toThrow(/greater than 0/);
        expect(() => new Sub().make(200)).toThrow(/less than or equal to 100/);
    });
});

describe('@Returns + @Ensures coexist on one method — the reified band is checked first (DEC-033)', () => {
    it('reports the @Returns (descriptor) violation before the @Ensures (closure) one', () => {
        const messages: string[] = [];
        setViolationPolicy(violation => {
            messages.push((violation as Error).message);
        });

        @Contract()
        class M {
            @Returns(GreaterThanEqual(0))
            @Ensures(r => (r as number) > 1000, 'over 1000')
            make(n: number): number {
                return n;
            }
        }

        new M().make(-5); // violates BOTH bands; the handler suppresses, so both run, in band order
        expect(messages).toHaveLength(2);
        // Reified first — the structured, projectable guarantee.
        expect(messages[0]).toMatch(/return value/);
        expect(messages[0]).toMatch(/greater than or equal to 0/);
        // Closure second.
        expect(messages[1]).toMatch(/Postcondition failed/);
        expect(messages[1]).toContain('over 1000');
    });

    it('under the default throw policy, the thrown error is the reified one', () => {
        @Contract()
        class M {
            @Returns(GreaterThanEqual(0))
            @Ensures(r => (r as number) > 1000, 'over 1000')
            make(n: number): number {
                return n;
            }
        }

        expect(() => new M().make(-5)).toThrow(/return value/);
        expect(() => new M().make(-5)).not.toThrow(/Postcondition failed/);
    });
});

describe('the @Validate() + @Returns() ordering caveat (characterization, identical to @Ensures)', () => {
    it('enforces when @Returns sits below @Validate, and does NOT when it sits above', () => {
        class Sample {
            @Validate()
            @Returns(GreaterThanEqual(0))
            ordered(n: number): number {
                return n;
            }

            @Returns(GreaterThanEqual(0))
            @Validate()
            reversed(n: number): number {
                return n;
            }
        }

        const s = new Sample();
        // @Returns below @Validate → @Validate saw it → enforced.
        expect(() => s.ordered(-1)).toThrow(/return value/);
        // @Returns above @Validate → @Validate ran first, saw nothing → recorded-but-unenforced.
        expect(s.reversed(-1)).toBe(-1);
    });
});

describe('the two-band consumption rule — a @Returns-only method is enforced, documented, AND schema’d', () => {
    // The single highest-risk interaction in the plan (Gaps §1): the weave and BOTH projections must
    // read the reified `post` band, or a method carrying only a `@Returns` (no `@Ensures`, no params) is
    // silently half-dropped. This pins all three consumers at once.
    it('enforces at runtime, renders a Returns row, and emits a returns schema fragment', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanEqual(0))
            balance(n: number): number {
                return n;
            }
        }
        void Ledger;

        // (a) enforced — a violating return throws, a valid one passes.
        expect(new Ledger().balance(5)).toBe(5);
        expect(() => new Ledger().balance(-1)).toThrow(/return value/);

        // (b) documented — a "Returns" table row in generateMarkdown().
        const markdown = generateMarkdown();
        expect(markdown).toContain('## Ledger');
        expect(markdown).toContain('| Return | Constraint | Expectation |');
        expect(markdown).toContain('| `return` | `min` | a number greater than or equal to 0 |');

        // (c) schema’d — a `returns` fragment in generateSchema().
        const schema = JSON.parse(generateSchema());
        expect(schema.$defs.Ledger.methods.balance.returns).toEqual({type: 'number', minimum: 0});
    });
});
