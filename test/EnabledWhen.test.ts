/**
 * `@EnabledWhen` — state-reading enabledness guards (DEC-089), the receiver-aware sibling of `@Requires`.
 *
 * These pin the things that matter: a guard reads the RECEIVER (the capability `@Requires` cannot express)
 * and gates the call before the body runs (caller-blamed); a guard that cleanly returns `false` is a
 * "not enabled" caller error, while a guard that THROWS propagates unchanged as an author defect (the
 * deliberate divergence from `@Requires`); the exported `evaluateEnabledness` oracle agrees byte-for-byte
 * with what enforcement rejects (the no-drift guarantee the future sequence driver relies on); the band is
 * kept SEPARATE from `@Requires` so downstream tells enabledness from a precondition; and it is
 * UNPROJECTABLE — an `@EnabledWhen`-only method emits an empty tool schema.
 */

import {EnabledWhen, Requires, GreaterThanEqual, Contract, setViolationPolicy} from '../index';
import {toolSchemaForMethod} from '../schema';
import {evaluateEnabledness, getEffectiveEnablednessGuards, getEffectivePreconditions} from '../introspection';
import type {EnablednessGuard} from '../introspection';
import {resetConfiguration, setConfigurationSink} from '../src/Core/Configuration';

describe('@EnabledWhen — state-reading enforcement (DEC-089)', () => {
    @Contract()
    class Wallet {
        constructor(public balance: number) {}

        @EnabledWhen((self: Wallet, amount: number) => amount <= self.balance, 'balance covers the amount')
        withdraw(amount: number): number {
            this.balance -= amount;
            return this.balance;
        }
    }

    it('runs the method when the guard holds, reading receiver state', () => {
        expect(new Wallet(100).withdraw(50)).toBe(50);
    });

    it('throws before the body when the guard returns false, naming the description', () => {
        expect(() => new Wallet(100).withdraw(200)).toThrow('balance covers the amount');
    });

    it('does not run the body when not enabled (state is unchanged)', () => {
        const w = new Wallet(100);
        expect(() => w.withdraw(200)).toThrow();
        expect(w.balance).toBe(100); // the guard ran BEFORE the body, so no mutation happened
    });

    it('gates on state alone — a guard with no arg dependence', () => {
        @Contract()
        class Connection {
            open = true;
            @EnabledWhen((self: Connection) => self.open, 'connection is open')
            send(msg: string) {
                return `sent:${msg}`;
            }
        }
        const c = new Connection();
        expect(c.send('hi')).toBe('sent:hi');
        c.open = false;
        expect(() => c.send('hi')).toThrow('connection is open');
    });

    it('an @EnabledWhen-only method (no per-position constraints) still installs and enforces', () => {
        // Wallet.withdraw is exactly this shape; a fresh class pins it independently.
        @Contract()
        class Gate {
            passable = false;
            @EnabledWhen((self: Gate) => self.passable, 'gate is open')
            pass() {
                return 'through';
            }
        }
        const g = new Gate();
        expect(() => g.pass()).toThrow('gate is open');
        g.passable = true;
        expect(g.pass()).toBe('through');
    });

    it('runs the guard AFTER per-position and @Requires checks (a bad argument is reported first)', () => {
        @Contract()
        class Counter {
            constructor(public value: number) {}
            @EnabledWhen((self: Counter, step: number) => self.value + step <= 10, 'stays under the cap')
            inc(@GreaterThanEqual(1) step: number) {
                this.value += step;
                return this.value;
            }
        }
        // The per-position @GreaterThanEqual(1) fails first for step < 1 (the guard never gets to run)...
        expect(() => new Counter(0).inc(0)).toThrow();
        // ...and the guard fails when the argument is individually fine but the state forbids it.
        expect(() => new Counter(9).inc(5)).toThrow('stays under the cap');
        expect(new Counter(0).inc(3)).toBe(3);
    });

    it('a guard that THROWS propagates unchanged — an author defect, not a caller-blamed "not enabled"', () => {
        class Boom extends Error {}
        @Contract()
        class Guarded {
            @EnabledWhen(() => {
                throw new Boom('guard blew up');
            }, 'never reached')
            run() {
                return 'ok';
            }
        }
        // The original error surfaces verbatim — NOT rewritten to "Not enabled", NOT caller-blamed.
        expect(() => new Guarded().run()).toThrow(Boom);
        expect(() => new Guarded().run()).toThrow('guard blew up');
        expect(() => new Guarded().run()).not.toThrow('Not enabled');
    });

    describe("under the 'warn' policy", () => {
        afterEach(resetConfiguration);

        it('a false guard proceeds into the body (staged over live traffic)', () => {
            setConfigurationSink(() => {}); // swallow the warn line
            setViolationPolicy('warn');
            const w = new Wallet(100);
            // 200 > balance, so the guard is false; 'warn' lets the call through and the body runs.
            expect(w.withdraw(200)).toBe(-100);
        });
    });
});

describe('@EnabledWhen — the shared oracle and no-drift (DEC-089)', () => {
    @Contract()
    class Wallet {
        constructor(public balance: number) {}
        @EnabledWhen((self: Wallet, amount: number) => amount <= self.balance, 'balance covers the amount')
        withdraw(amount: number) {
            this.balance -= amount;
            return this.balance;
        }
    }

    it('evaluateEnabledness is the exact function enforcement runs (oracle == enforced)', () => {
        const guards = getEffectiveEnablednessGuards(Wallet.prototype, 'withdraw');
        expect(guards.length).toBe(1);
        expect(guards[0].band).toBe('enabledness');

        // The oracle flags exactly the (receiver, args) enforcement rejects, and passes those it accepts.
        expect(evaluateEnabledness(guards, new Wallet(100), [50]).ok).toBe(true);
        expect(new Wallet(100).withdraw(50)).toBe(50);

        expect(evaluateEnabledness(guards, new Wallet(100), [200]).ok).toBe(false);
        expect(() => new Wallet(100).withdraw(200)).toThrow();
    });

    it('reports the first failing guard, first-failure-wins, with no error on a clean false', () => {
        const g: EnablednessGuard = {
            predicate: (self: {v: number}) => self.v > 0,
            description: 'v positive',
            band: 'enabledness',
        };
        expect(evaluateEnabledness([g], {v: 1}, [])).toEqual({ok: true});
        const verdict = evaluateEnabledness([g], {v: -1}, []);
        if (verdict.ok) throw new Error('expected a not-enabled failure');
        expect(verdict.failed).toBe(g);
        expect(verdict.error).toBeUndefined(); // a clean false, not a throw
    });

    it('preserves a thrown value on `error` — the datum that distinguishes a defect from a skip', () => {
        const boom = new Error('boom');
        const g: EnablednessGuard = {
            predicate: () => {
                throw boom;
            },
            description: 'throws',
            band: 'enabledness',
        };
        const verdict = evaluateEnabledness([g], {}, []);
        if (verdict.ok) throw new Error('expected a failure');
        expect(verdict.error).toBe(boom);
    });
});

describe('@EnabledWhen — band separation, inheritance, unprojectability (DEC-089)', () => {
    it('keeps a separate band from @Requires — neither read leaks into the other', () => {
        @Contract()
        class Both {
            cap = 10;
            @Requires((amount: number) => amount > 0, 'amount positive')
            @EnabledWhen((self: Both, amount: number) => amount <= self.cap, 'within cap')
            take(amount: number) {
                return amount;
            }
        }
        const pres = getEffectivePreconditions(Both.prototype, 'take');
        const guards = getEffectiveEnablednessGuards(Both.prototype, 'take');
        expect(pres.length).toBe(1);
        expect(pres[0].description).toBe('amount positive');
        expect(guards.length).toBe(1);
        expect(guards[0].description).toBe('within cap');
        // The precondition band carries no `band` tag; the enabledness record is self-describing.
        expect((pres[0] as {band?: unknown}).band).toBeUndefined();
        expect(guards[0].band).toBe('enabledness');

        // Enforcement runs @Requires before the guard: a non-positive amount is reported first.
        expect(() => new Both().take(-1)).toThrow('amount positive');
        expect(() => new Both().take(50)).toThrow('within cap');
        expect(new Both().take(5)).toBe(5);
    });

    it('a subclass override inherits its parent @EnabledWhen (DEC-022 union, installer effective keys)', () => {
        @Contract()
        class Base {
            open = true;
            @EnabledWhen((self: Base) => self.open, 'base is open')
            op() {
                return 'base';
            }
        }
        @Contract()
        class Sub extends Base {
            op() {
                return 'sub';
            } // overrides WITHOUT redeclaring @EnabledWhen
        }
        expect(new Sub().op()).toBe('sub');
        const s = new Sub();
        s.open = false;
        expect(() => s.op()).toThrow('base is open'); // inherited guard still enforced
    });

    it('is UNPROJECTABLE: an @EnabledWhen-only method projects to an empty tool schema', () => {
        @Contract()
        class OnlyGuard {
            limit = 5;
            @EnabledWhen((self: OnlyGuard, n: number) => n <= self.limit, 'n under limit')
            use(n: number) {
                return n;
            }
        }
        const schema = toolSchemaForMethod(OnlyGuard, 'use');
        // The guard contributes nothing — no properties, nothing required (like @Requires/@Ensures).
        expect(schema.properties).toEqual({});
        expect(schema.required).toEqual([]);
    });
});
