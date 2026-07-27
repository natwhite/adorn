/**
 * O1b — enforcement-weave observation emission (DEC-035, DEC-036, plan §6).
 *
 * With an ObservationSink installed, every contract violation — a precondition and BOTH postcondition
 * bands — emits one value-free `{kind:'violation'}` event, and a completed call emits `{kind:'completed'}`.
 * These pin the four properties the plan requires: it is a side-channel that never influences control
 * flow; it fires under `throw`/`warn`/suppress alike; a reified constraint carries full, groupable
 * `ViolationFacts` while an `@Ensures` closure degrades to `_OTHER`; and "seeing ≠ emitting" — the
 * emitted facts are value-free and `error.message` is redacted by default (raw only under
 * `setValueDisclosure('all')`). The uninstalled path emits nothing and enforces exactly as before.
 */

import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {GreaterThan} from '../src/ParameterDecorators/Constraints';
import {GreaterThan as GreaterThanDescriptor} from '../src/Contracts/number';
import {Returns} from '../src/MethodDecorators/Returns';
import {Ensures} from '../src/MethodDecorators/Ensures';
import {resetRegistry} from '../src/Core/ContractRegistry';
import {resetConfiguration, setEnforcementMode, setViolationPolicy} from '../src/Core/Configuration';
import {resetValueDisclosure, setValueDisclosure} from '../src/Core/redaction';
import {resetContractDiagnostics, setContractDiagnosticsSink} from '../src/Adapters/legacy/ContractDiagnostics';
import {
    getObservationSink,
    setObservationSink,
    ObservationEvent,
    RETURN_INDEX,
} from '../src/Core/Observation';

let events: ObservationEvent[];

beforeEach(() => {
    resetRegistry();
    resetConfiguration();
    resetValueDisclosure();
    resetContractDiagnostics();
    setContractDiagnosticsSink(() => {}); // swallow recorded-but-unenforced warnings under test
    setEnforcementMode('development'); // ensure `assert`-trust postconditions run
    events = [];
    setObservationSink({record: e => events.push(e)});
});

afterEach(() => {
    setObservationSink(null);
    resetContractDiagnostics();
});

function violations() {
    return events.filter((e): e is Extract<ObservationEvent, {kind: 'violation'}> => e.kind === 'violation');
}
function completions() {
    return events.filter((e): e is Extract<ObservationEvent, {kind: 'completed'}> => e.kind === 'completed');
}
/** Call `fn`, swallowing a synchronous throw so the emitted event can be inspected once. */
function attempt(fn: () => unknown): void {
    try {
        fn();
    } catch {
        /* the violation is what we are asserting on */
    }
}
function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Preconditions — full, groupable facts from a reified constraint
// ---------------------------------------------------------------------------

describe('precondition violations', () => {
    it('emits one value-free {kind:violation} with full facts and adorn.<constraint> error type', () => {
        @Contract()
        class Accounts {
            transfer(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        attempt(() => new Accounts().transfer(-4242));

        expect(violations()).toHaveLength(1);
        const v = violations()[0];
        expect(v.violation).toMatchObject({
            constraint: 'greaterThan',
            kind: 'number',
            params: {exclusiveMin: 0},
            expectation: 'a number greater than 0',
            parameterName: 'amount',
            parameterIndex: 0,
            trust: 'guard',
            blame: 'caller',
        });
        expect(v.error?.type).toBe('adorn.greaterThan');
        expect(v.observation).toMatchObject({owner: 'Accounts', member: 'transfer', name: 'Accounts.transfer'});
    });

    it('keeps facts value-free and redacts error.message by default; raw only under disclosure', () => {
        @Contract()
        class Accounts {
            transfer(@GreaterThan(0) amount: number): number {
                return amount;
            }
        }

        // Default: the value is nowhere in the facts, and the message is redacted (DEC-030).
        attempt(() => new Accounts().transfer(-4242));
        const redacted = violations()[0];
        expect(JSON.stringify(redacted.violation)).not.toContain('-4242');
        expect(redacted.error?.message).toContain('[REDACTED]');
        expect(redacted.error?.message).not.toContain('-4242');

        // Opt in globally: the message now discloses the value, but the FACTS stay value-free.
        events = [];
        setValueDisclosure('all');
        attempt(() => new Accounts().transfer(-4242));
        const raw = violations()[0];
        expect(raw.error?.message).toContain('-4242');
        expect(JSON.stringify(raw.violation)).not.toContain('-4242');
    });
});

// ---------------------------------------------------------------------------
// Side-channel: fires under every policy, never influences control flow
// ---------------------------------------------------------------------------

describe('the emit is a side-channel independent of the violation policy', () => {
    function build() {
        @Contract()
        class C {
            m(@GreaterThan(0) n: number): number {
                return n;
            }
        }
        return C;
    }

    it("throws AND emits under the default 'throw' policy", () => {
        const C = build();
        expect(() => new C().m(-1)).toThrow(/greater than 0/);
        expect(violations()).toHaveLength(1);
    });

    it("fires under 'warn' while the call still proceeds", () => {
        setViolationPolicy('warn');
        const C = build();
        expect(new C().m(-1)).toBe(-1); // suppressed-and-proceeds
        expect(violations()).toHaveLength(1);
        expect(violations()[0].violation.blame).toBe('caller');
    });

    it('fires under a suppressing handler, and does not act as the handler', () => {
        const handled: unknown[] = [];
        setViolationPolicy(() => {
            handled.push(1); // returns → suppresses
        });
        const C = build();
        expect(new C().m(-1)).toBe(-1);
        expect(handled).toHaveLength(1); // the handler ran
        expect(violations()).toHaveLength(1); // and the sink saw it, separately
    });
});

// ---------------------------------------------------------------------------
// Both postcondition bands
// ---------------------------------------------------------------------------

describe('postcondition violations — both bands', () => {
    it('reified @Returns carries full facts, RETURN_INDEX, callee/assert', () => {
        @Contract()
        class Ledger {
            @Returns(GreaterThanDescriptor(0))
            balance(n: number): number {
                return n;
            }
        }

        attempt(() => new Ledger().balance(-1));

        expect(violations()).toHaveLength(1);
        expect(violations()[0].violation).toMatchObject({
            constraint: 'greaterThan',
            kind: 'number',
            parameterName: 'return value',
            parameterIndex: RETURN_INDEX,
            trust: 'assert',
            blame: 'callee',
        });
        expect(violations()[0].error?.type).toBe('adorn.greaterThan');
    });

    it('an @Ensures closure degrades to a low-fidelity _OTHER fact', () => {
        @Contract()
        class Ids {
            @Ensures(r => (r as number) > 0, 'the id is positive')
            make(n: number): number {
                return n;
            }
        }

        attempt(() => new Ids().make(-1));

        expect(violations()).toHaveLength(1);
        const v = violations()[0];
        expect(v.violation).toMatchObject({
            constraint: '_OTHER',
            kind: 'generic',
            params: {},
            expectation: 'the id is positive',
            parameterIndex: RETURN_INDEX,
            blame: 'callee',
        });
        expect(v.error?.type).toBe('_OTHER');
    });

    it('async @Returns violation still rejects AND emits (regression + async settle)', async () => {
        @Contract()
        class C {
            @Returns(GreaterThanDescriptor(0))
            async balance(n: number): Promise<number> {
                return n;
            }
        }

        await expect(new C().balance(-1)).rejects.toThrow(/greater than 0/);
        await flushMicrotasks();

        expect(violations()).toHaveLength(1);
        expect(violations()[0].violation.blame).toBe('callee');
        // The checked promise rejected, so the completion is observed as a throw.
        expect(completions().some(c => c.outcome === 'threw')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Completed events
// ---------------------------------------------------------------------------

describe('completed events', () => {
    it('a synchronous call emits a returned completion', () => {
        @Contract()
        class C {
            m(@GreaterThan(0) n: number): number {
                return n * 2;
            }
        }

        expect(new C().m(5)).toBe(10);
        expect(completions()).toHaveLength(1);
        expect(completions()[0].outcome).toBe('returned');
        expect(typeof completions()[0].durationMs).toBe('number');
        expect(completions()[0].observation.name).toBe('C.m');
    });

    it('an async call emits a returned completion when the promise settles', async () => {
        @Contract()
        class C {
            async m(@GreaterThan(0) n: number): Promise<number> {
                return n;
            }
        }

        expect(await new C().m(5)).toBe(5);
        await flushMicrotasks();
        expect(completions().some(c => c.outcome === 'returned')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Containment and the no-op fast path
// ---------------------------------------------------------------------------

describe('a throwing sink never breaks enforcement', () => {
    it('the original violation propagates, not the sink error, and valid calls still return', () => {
        setObservationSink({
            record: () => {
                throw new Error('sink boom');
            },
        });

        @Contract()
        class C {
            m(@GreaterThan(0) n: number): number {
                return n;
            }
        }

        expect(() => new C().m(-1)).toThrow(/greater than 0/);
        expect(() => new C().m(-1)).not.toThrow(/sink boom/);
        expect(new C().m(5)).toBe(5); // completed emit is guarded too
    });

    it('a scope-only sink (no record) does not break a violating call', () => {
        setObservationSink({scope: (_call, proceed) => proceed()});

        @Contract()
        class C {
            m(@GreaterThan(0) n: number): number {
                return n;
            }
        }

        expect(() => new C().m(-1)).toThrow(/greater than 0/);
        expect(new C().m(5)).toBe(5);
    });
});

describe('the uninstalled (NOOP) path', () => {
    it('emits nothing and enforces exactly as before', () => {
        setObservationSink(null); // no sink — the one-=== fast path

        @Contract()
        class C {
            m(@GreaterThan(0) n: number): number {
                return n;
            }
        }

        expect(() => new C().m(-1)).toThrow(/greater than 0/);
        expect(new C().m(3)).toBe(3);
        expect(events).toHaveLength(0); // our spy was uninstalled, and NOOP records nothing
    });
});
