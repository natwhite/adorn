/**
 * O1c — the `@Telemetry` disclosure band and the shared disclosure resolver (DEC-036, plan §7 / Q-24).
 *
 * Two things are pinned here: that the decorators record the right marking into the telemetry band
 * (record-only, index-keyed, minification-safe), and that the shared resolver composes the three inputs —
 * `@Sensitive` veto, `@Telemetry` opt-in, global switch — into the right decision, including the veto of an
 * explicit opt-in surfacing `vetoed: true` rather than an indistinguishable deny. The *rendering* of that
 * decision (EmittedValue, the dev diagnostic) is pinned in `test/observe.test.ts`.
 */

import {Telemetry} from './Telemetry';
import {Sensitive} from '../Sensitive/Sensitive';
import {
    getParameterTelemetry,
    getReturnTelemetry,
    getTelemetryParameterIndices,
    resetRegistry,
} from '../Core/ContractRegistry';
import {resetValueDisclosure, setValueDisclosure} from '../Core/redaction';
import {resolveParameterDisclosure, resolveReturnDisclosure} from '../Core/telemetryDisclosure';

beforeEach(() => {
    resetRegistry();
    resetValueDisclosure();
});

// ---------------------------------------------------------------------------
// Recording — record-only, into the telemetry band
// ---------------------------------------------------------------------------

describe('the decorators record into the telemetry band, and install nothing', () => {
    it('@Telemetry.value() records a value opt-in on the parameter index', () => {
        class C {
            m(@Telemetry.value() amount: number) {
                return amount;
            }
        }
        void C;
        expect(getParameterTelemetry(C.prototype, 'm', 0)).toEqual({disclose: 'value'});
        expect(getTelemetryParameterIndices(C.prototype, 'm')).toEqual([0]);
    });

    it('@Telemetry.value(name) carries the explicit-name hatch (DEC-OBS-4)', () => {
        class C {
            m(@Telemetry.value('accountId') a: string) {
                return a;
            }
        }
        void C;
        expect(getParameterTelemetry(C.prototype, 'm', 0)).toEqual({disclose: 'value', name: 'accountId'});
    });

    it('@Telemetry.redact(strategy) records a surrogate opt-in', () => {
        class C {
            m(@Telemetry.redact('type') a: string, @Telemetry.redact('length') b: string) {
                return a + b;
            }
        }
        void C;
        expect(getParameterTelemetry(C.prototype, 'm', 0)).toEqual({disclose: {redact: 'type'}});
        expect(getParameterTelemetry(C.prototype, 'm', 1)).toEqual({disclose: {redact: 'length'}});
    });

    it('@Telemetry.result() records a return opt-in (the Q-23 disclosure half)', () => {
        class C {
            @Telemetry.result()
            balance(): number {
                return 1;
            }
        }
        void C;
        expect(getReturnTelemetry(C.prototype, 'balance')).toEqual({disclose: 'value'});
    });

    it('@Telemetry.redact rejects an unknown / not-yet-shipped strategy loudly', () => {
        expect(() => Telemetry.redact('hash' as any)).toThrow(/fast-follow|unknown strategy/);
        expect(() => Telemetry.redact('nonsense' as any)).toThrow(/unknown strategy/);
    });

    it('@Telemetry.result() rejects application to a non-method', () => {
        expect(() => (Telemetry.result() as any)({}, 'x', undefined)).toThrow(/must be applied to a method/);
    });
});

// ---------------------------------------------------------------------------
// The disclosure resolver — the three-input truth table
// ---------------------------------------------------------------------------

describe('the disclosure resolver composes veto + opt-in + global (DEC-036)', () => {
    it('deny is the default — nothing said, nothing leaves', () => {
        class C {
            m(plain: number) {
                return plain;
            }
        }
        const r = resolveParameterDisclosure(C.prototype, 'm', 0);
        expect(r.disclosure).toBe('deny');
        expect(r.declared).toBe(false);
        expect(r.vetoed).toBe(false);
    });

    it('@Telemetry.value() resolves to a value disclosure', () => {
        class C {
            m(@Telemetry.value() amount: number) {
                return amount;
            }
        }
        expect(resolveParameterDisclosure(C.prototype, 'm', 0).disclosure).toBe('value');
    });

    it('@Telemetry.redact() resolves to a surrogate disclosure', () => {
        class C {
            m(@Telemetry.redact('type') a: string) {
                return a;
            }
        }
        expect(resolveParameterDisclosure(C.prototype, 'm', 0).disclosure).toEqual({redact: 'type'});
    });

    it('the global setValueDisclosure(all) switch discloses an un-annotated value (local debug)', () => {
        class C {
            m(plain: number) {
                return plain;
            }
        }
        expect(resolveParameterDisclosure(C.prototype, 'm', 0).disclosure).toBe('deny');
        setValueDisclosure('all');
        expect(resolveParameterDisclosure(C.prototype, 'm', 0).disclosure).toBe('value');
    });

    it('@Sensitive can only ever REMOVE disclosure — the global switch never reaches it', () => {
        class C {
            m(@Sensitive() secret: string) {
                return secret;
            }
        }
        setValueDisclosure('all');
        const r = resolveParameterDisclosure(C.prototype, 'm', 0);
        expect(r.disclosure).toBe('deny');
        expect(r.sensitive).toBe(true);
        expect(r.vetoed).toBe(false); // no explicit opt-in to veto — nothing to surface
    });

    it('@Sensitive VETOES an explicit @Telemetry.value(), and the veto is surfaced (vetoed:true)', () => {
        class C {
            m(@Sensitive() @Telemetry.value() secret: string) {
                return secret;
            }
        }
        const r = resolveParameterDisclosure(C.prototype, 'm', 0);
        expect(r.disclosure).toBe('deny'); // the value stays redacted — the veto wins (DEC-025)
        expect(r.declared).toBe(true);
        expect(r.vetoed).toBe(true); // ...but the collision is not silent
    });

    it('a class-level @Sensitive vetoes an opted-in parameter of the class', () => {
        @Sensitive()
        class C {
            m(@Telemetry.value() a: string) {
                return a;
            }
        }
        void C;
        const r = resolveParameterDisclosure(C.prototype, 'm', 0);
        expect(r.disclosure).toBe('deny');
        expect(r.vetoed).toBe(true);
    });

    it('@Telemetry.result() vetoed by a class-level @Sensitive resolves to a surfaced veto', () => {
        // A return cannot be marked @Sensitive directly (Q-23 — the signature is field/param/class only),
        // so the return-veto arrives via a class-level @Sensitive, which sensitises every value including
        // the return.
        @Sensitive()
        class C {
            @Telemetry.result()
            balance(): number {
                return 1;
            }
        }
        void C;
        const r = resolveReturnDisclosure(C.prototype, 'balance');
        expect(r.disclosure).toBe('deny');
        expect(r.declared).toBe(true);
        expect(r.vetoed).toBe(true);
    });
});
