/**
 * O1c — `@Observe`, the disclosure record path, the double-emit reconciliation, and the console sink.
 *
 * Pins the surface the task requires: `@Observe` opens the sink's `scope` and emits one `{kind:'completed'}`
 * with the declared `SpanKind`; a `@Contract()`+`@Observe()` method emits `completed` exactly ONCE (the
 * reconciliation, without touching contract-check semantics); `@Telemetry.value()` discloses on the record
 * path while an un-opted value stays `[REDACTED]`; `@Sensitive` vetoes an explicit opt-in AND surfaces a
 * diagnostic; the verbosity gate; structured error facts on a throw; the one-`===` uninstalled fast path;
 * and `consoleObservationSink`'s output.
 */

import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {Observe} from '../src/MethodDecorators/Observe';
import {Telemetry} from '../src/Telemetry/Telemetry';
import {Sensitive} from '../src/Sensitive/Sensitive';
import {GreaterThan} from '../src/ParameterDecorators/Constraints';
import {consoleObservationSink} from '../src/Adapters/legacy/ObservationBehavior';
import {getObservationSink, setObservationSink, ObservationEvent, ObservationCall, RETURN_INDEX} from '../src/Core/Observation';
import {resetRegistry} from '../src/Core/ContractRegistry';
import {resetConfiguration, setObservationVerbosity, setViolationPolicy} from '../src/Core/Configuration';
import {resetValueDisclosure} from '../src/Core/redaction';
import {resetContractDiagnostics, setContractDiagnosticsSink} from '../src/Adapters/legacy/ContractDiagnostics';

let events: ObservationEvent[];
let scopeCalls: ObservationCall[];

beforeEach(() => {
    resetRegistry();
    resetConfiguration();
    resetValueDisclosure();
    resetContractDiagnostics();
    setContractDiagnosticsSink(() => {}); // swallow diagnostics by default; the veto test installs its own
    events = [];
    scopeCalls = [];
    setObservationSink({
        record: e => events.push(e),
        scope: (call, proceed) => {
            scopeCalls.push(call);
            return proceed();
        },
    });
});

afterEach(() => {
    setObservationSink(null);
    resetContractDiagnostics();
});

function completions() {
    return events.filter((e): e is Extract<ObservationEvent, {kind: 'completed'}> => e.kind === 'completed');
}
function violations() {
    return events.filter((e): e is Extract<ObservationEvent, {kind: 'violation'}> => e.kind === 'violation');
}
function valuesOf(e: Extract<ObservationEvent, {kind: 'completed'}>) {
    return e.values || [];
}
function attempt(fn: () => unknown): void {
    try {
        fn();
    } catch {
        /* asserting on the emitted event */
    }
}

// ---------------------------------------------------------------------------
// @Observe — scope + completed, with the declared SpanKind
// ---------------------------------------------------------------------------

describe('@Observe opens a scope and emits one completion', () => {
    it('flows the call through the sink scope and emits {kind:completed} with kind=internal', () => {
        class Svc {
            @Observe()
            work(n: number): number {
                return n * 2;
            }
        }

        expect(new Svc().work(5)).toBe(10); // does not change what the method returns

        expect(scopeCalls).toHaveLength(1);
        expect(scopeCalls[0].observation).toMatchObject({name: 'Svc.work', kind: 'internal'});

        expect(completions()).toHaveLength(1);
        const c = completions()[0];
        expect(c.outcome).toBe('returned');
        expect(c.observation).toMatchObject({owner: 'Svc', member: 'work', name: 'Svc.work', kind: 'internal'});
        expect(typeof c.durationMs).toBe('number');
    });

    it('@Observe({kind}) sets the SpanKind on both the scope call and the completed event (Q-24 R7)', () => {
        class Api {
            @Observe({kind: 'client'})
            fetch(id: string): string {
                return id;
            }
        }

        new Api().fetch('u1');

        expect(scopeCalls[0].observation.kind).toBe('client');
        expect(completions()[0].observation.kind).toBe('client');
    });

    it('a throw settles as a threw completion carrying structured ErrorFacts, and still propagates', () => {
        class Svc {
            @Observe()
            boom(): number {
                throw new TypeError('nope');
            }
        }

        expect(() => new Svc().boom()).toThrow(/nope/); // the error is not swallowed

        expect(completions()).toHaveLength(1);
        const c = completions()[0];
        expect(c.outcome).toBe('threw');
        expect(c.error?.type).toBe('TypeError');
        expect(c.error?.message).toBe('nope');
    });

    it('awaits an async method and emits the completion when the promise settles', async () => {
        class Svc {
            @Observe()
            async load(n: number): Promise<number> {
                return n;
            }
        }

        expect(await new Svc().load(3)).toBe(3);
        expect(completions()).toHaveLength(1);
        expect(completions()[0].outcome).toBe('returned');
    });
});

// ---------------------------------------------------------------------------
// The uninstalled fast path
// ---------------------------------------------------------------------------

describe('the uninstalled (NOOP) path', () => {
    it('emits nothing and returns the value unchanged — the one-=== fast path', () => {
        setObservationSink(null);
        expect(getObservationSink().record).toBeUndefined();

        class Svc {
            @Observe()
            work(n: number): number {
                return n + 1;
            }
        }

        expect(new Svc().work(1)).toBe(2);
        expect(events).toHaveLength(0);
        expect(scopeCalls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// The double-emit reconciliation (plan §5) — the pinned single emit
// ---------------------------------------------------------------------------

describe('@Contract() + @Observe() emits {kind:completed} exactly ONCE', () => {
    it('a valid call emits one completion (the richer @Observe one), and one scope', () => {
        @Contract()
        class Ledger {
            @Observe()
            debit(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        expect(new Ledger().debit(10)).toBe(10);

        // Without the reconciliation this would be 2 (enforcement + @Observe). Pinned to 1.
        expect(completions()).toHaveLength(1);
        expect(scopeCalls).toHaveLength(1); // only @Observe opens a scope
        expect(completions()[0].observation.name).toBe('Ledger.debit');
    });

    it('still enforces and still emits the violation — contract semantics are untouched', () => {
        @Contract()
        class Ledger {
            @Observe()
            debit(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        expect(() => new Ledger().debit(-1)).toThrow(/greater than 0/); // enforcement unchanged
        expect(violations()).toHaveLength(1); // O1b violation still emitted
        expect(violations()[0].violation.constraint).toBe('greaterThan');
        // The method threw at the precondition, before proceed(), so there is no completion at all.
        expect(completions()).toHaveLength(0);
    });

    it('the single completion holds for an async @Contract()+@Observe() method too', async () => {
        @Contract()
        class Ledger {
            @Observe()
            async debit(@GreaterThan(0) amount: number): Promise<number> {
                return amount;
            }
        }

        expect(await new Ledger().debit(7)).toBe(7);
        expect(completions()).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// The disclosure record path — "seeing ≠ emitting" (DEC-036)
// ---------------------------------------------------------------------------

describe('@Telemetry disclosure on the record path', () => {
    it('discloses an opted-in value and REDACTS an un-opted one', () => {
        class Accounts {
            @Observe()
            transfer(@Telemetry.value() amount: number, memo: string): number {
                return amount;
            }
        }

        new Accounts().transfer(42, 'lunch');

        const vals = valuesOf(completions()[0]);
        const amount = vals.find(v => v.index === 0)!;
        const memo = vals.find(v => v.index === 1)!;

        expect(amount).toMatchObject({name: 'amount', disclosed: true, rendering: 42});
        expect(memo).toMatchObject({name: 'memo', disclosed: false, rendering: '[REDACTED]'});
        // The raw value of the un-opted parameter is nowhere in the emitted event.
        expect(JSON.stringify(completions()[0])).not.toContain('lunch');
    });

    it('discloses an opted-in return via @Telemetry.result()', () => {
        class Accounts {
            @Observe()
            @Telemetry.result()
            balance(): number {
                return 99;
            }
        }

        new Accounts().balance();
        const ret = valuesOf(completions()[0]).find(v => v.index === RETURN_INDEX)!;
        expect(ret).toMatchObject({disclosed: true, rendering: 99});
    });

    it('emits a surrogate for @Telemetry.redact(type)', () => {
        class Accounts {
            @Observe()
            open(@Telemetry.redact('type') account: object): void {}
        }

        new Accounts().open({iban: 'X'});
        const v = valuesOf(completions()[0]).find(x => x.index === 0)!;
        expect(v.disclosed).toBe(true);
        expect(v.rendering).toBe('Object'); // the type name, not the value
        expect(JSON.stringify(completions()[0])).not.toContain('iban');
    });

    it('@Sensitive vetoes an explicit @Telemetry.value(): value redacted, vetoed flagged, diagnostic surfaced', () => {
        const diagnostics: string[] = [];
        setContractDiagnosticsSink(m => diagnostics.push(m));

        class C {
            @Observe()
            login(@Sensitive() @Telemetry.value() password: string): boolean {
                return password.length > 0;
            }
        }

        new C().login('hunter2');

        const v = valuesOf(completions()[0]).find(x => x.index === 0)!;
        expect(v).toMatchObject({disclosed: false, rendering: '[REDACTED]', vetoed: true});
        expect(JSON.stringify(completions()[0])).not.toContain('hunter2'); // the value never leaves

        // ...and the collision is SURFACED, not silent (Q-24 R8 / Fr2).
        expect(diagnostics.some(m => /overridden by @Sensitive/.test(m))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The verbosity gate (O1c)
// ---------------------------------------------------------------------------

describe('setObservationVerbosity gates detail-level observations', () => {
    it("a detail site is silent under 'normal' and emits under 'detailed'", () => {
        class Svc {
            @Observe({detail: 'detail'})
            chatty(): number {
                return 1;
            }
        }
        const svc = new Svc();

        svc.chatty(); // default verbosity is 'normal'
        expect(completions()).toHaveLength(0);

        setObservationVerbosity('detailed');
        svc.chatty();
        expect(completions()).toHaveLength(1);
    });

    it("a default @Observe() (detail 'always') always emits", () => {
        class Svc {
            @Observe()
            important(): number {
                return 1;
            }
        }
        new Svc().important();
        expect(completions()).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// A throwing record sink is contained
// ---------------------------------------------------------------------------

describe('a throwing sink never breaks the observed call', () => {
    it('the method result propagates and the sink error is swallowed', () => {
        setObservationSink({
            record: () => {
                throw new Error('sink boom');
            },
        });

        class Svc {
            @Observe()
            work(n: number): number {
                return n;
            }
        }

        expect(new Svc().work(5)).toBe(5);
        expect(() => new Svc().work(5)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// consoleObservationSink
// ---------------------------------------------------------------------------

describe('consoleObservationSink', () => {
    it('writes one JSON line per event naming the method and the completion', () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (line?: any) => lines.push(String(line));
        try {
            setObservationSink(consoleObservationSink);

            class Svc {
                @Observe()
                work(@Telemetry.value() n: number): number {
                    return n * 2;
                }
            }
            new Svc().work(21);
        } finally {
            console.log = original;
        }

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('[adorn:observe]');
        expect(lines[0]).toContain('completed');
        expect(lines[0]).toContain('Svc.work');
        expect(lines[0]).toContain('21'); // the opted-in value is rendered by the console sink
    });
});
