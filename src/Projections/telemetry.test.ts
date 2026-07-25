/**
 * O1d — the telemetry-disclosure projection: "what leaves the process, and in what form" (DEC-035, DEC-036).
 *
 * Pins that the model reports the right disclosure state per position (disclosed / surrogate / vetoed /
 * redacted-by-default), that a telemetry-only parameter is not silently dropped, that the scanned
 * denominator is rendered (a clean table is never a clean bill of health), and that the projection stays a
 * pure registry read — Core/+Contracts/ only, no decorator adapter (DEC-012).
 */

import 'reflect-metadata';

import {Contract} from '../Core/ContractInstaller';
import {GreaterThan, StringMinLength} from '../ParameterDecorators/Constraints';
import {Telemetry} from '../Telemetry/Telemetry';
import {Sensitive} from '../Sensitive/Sensitive';
import {resetRegistry} from '../Core/ContractRegistry';
import {resetValueDisclosure} from '../Core/redaction';
import {RETURN_INDEX} from '../Core/Observation';
import {
    ClassTelemetry,
    generateTelemetryReport,
    PositionTelemetry,
    serializeTelemetry,
    telemetryForClass,
    telemetryForContracts,
} from './telemetry';

beforeEach(() => {
    resetRegistry();
    resetValueDisclosure();
});

function methodOf(report: {classes: ReadonlyArray<ClassTelemetry>}, method: string) {
    const positions: PositionTelemetry[] = [];
    report.classes.forEach(c => c.methods.forEach(m => (m.name === method ? positions.push(...m.positions) : null)));
    return positions;
}

// ---------------------------------------------------------------------------
// Disclosure state per position
// ---------------------------------------------------------------------------

describe('the model reports the disclosure each position carries', () => {
    it('disclosed / surrogate / redacted-by-default, side by side', () => {
        @Contract()
        class Accounts {
            transfer(
                @Telemetry.value() @GreaterThan(0) amount: number,
                @Telemetry.redact('type') account: object,
                @StringMinLength(1) memo: string,
            ): number {
                return amount;
            }
        }

        const positions = methodOf(telemetryForClass(Accounts), 'transfer');
        const by = (i: number) => positions.find(p => p.index === i)!;

        expect(by(0)).toMatchObject({name: 'amount', state: 'disclosed'});
        expect(by(1)).toMatchObject({name: 'account', state: 'surrogate', strategy: 'type'});
        expect(by(2)).toMatchObject({name: 'memo', state: 'redacted'}); // absence is reviewable
    });

    it('reports a telemetry-only parameter that carries no constraint (the DEC-016 asymmetry closed)', () => {
        @Contract()
        class Accounts {
            // `token` has ONLY a @Telemetry opt-in (no constraint) — it must still appear, or a value
            // could leave the process without showing up in the "what leaves" table.
            issue(@Telemetry.value('token') token: string, @GreaterThan(0) ttl: number): string {
                return token;
            }
        }

        const positions = methodOf(telemetryForClass(Accounts), 'issue');
        expect(positions.find(p => p.name === 'token')).toMatchObject({index: 0, state: 'disclosed'});
        expect(positions.find(p => p.index === 1)).toMatchObject({state: 'redacted'});
    });

    it('reports an opted-in return, and a @Sensitive-vetoed opt-in as a distinct state', () => {
        @Contract()
        class Accounts {
            @Telemetry.result()
            balance(): number {
                return 1;
            }

            login(@Sensitive() @Telemetry.value() password: string): boolean {
                return !!password;
            }
        }

        const ret = methodOf(telemetryForClass(Accounts), 'balance').find(p => p.index === RETURN_INDEX)!;
        expect(ret).toMatchObject({kind: 'return', state: 'disclosed'});

        const pwd = methodOf(telemetryForClass(Accounts), 'login').find(p => p.index === 0)!;
        expect(pwd).toMatchObject({state: 'vetoed', sensitive: true});
    });

    it('an un-marked return is not reported as a redundant redacted row', () => {
        @Contract()
        class Accounts {
            plain(@GreaterThan(0) n: number): number {
                return n;
            }
        }
        const positions = methodOf(telemetryForClass(Accounts), 'plain');
        expect(positions.some(p => p.index === RETURN_INDEX)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Rendering — the scanned denominator, and the state strings
// ---------------------------------------------------------------------------

describe('serializeTelemetry renders the table with its scanned denominator', () => {
    it('states what it scanned and renders the state cells', () => {
        @Contract()
        class Accounts {
            transfer(@Telemetry.value() @GreaterThan(0) amount: number, @StringMinLength(1) memo: string): number {
                return amount;
            }
        }

        const md = serializeTelemetry(telemetryForClass(Accounts));

        expect(md).toContain('Scanned 1 class(es): Accounts');
        expect(md).toContain('makes no claim'); // no false-confidence about runtime flows
        expect(md).toContain('## Accounts');
        expect(md).toContain('| Position | Name | Discloses | @Sensitive |');
        expect(md).toContain('value emitted');
        expect(md).toContain('redacted (default)');
    });

    it('renders the vetoed collision as its own row state', () => {
        @Contract()
        class C {
            login(@Sensitive() @Telemetry.value() password: string): boolean {
                return !!password;
            }
        }
        const md = serializeTelemetry(telemetryForClass(C));
        expect(md).toContain('opted-in, vetoed by @Sensitive');
    });

    it('an empty report never presents a clean sheet as a clean bill of health (DEC-007)', () => {
        const md = serializeTelemetry({classes: [], scanned: []});
        expect(md).toContain('No classes were scanned');
        expect(md).toMatch(/never imported|imported and evaluated/);
    });

    it('generateTelemetryReport walks the enumerable registry', () => {
        @Contract()
        class Invoice {
            issue(@Telemetry.value() @StringMinLength(3) reference: string): string {
                return reference;
            }
        }
        void Invoice;

        const md = generateTelemetryReport();
        expect(md).toContain('## Invoice');
        expect(md).toContain('value emitted');
    });

    it('telemetryForContracts reports across classes with a full denominator', () => {
        @Contract()
        class A {
            m(@Telemetry.value() x: number): number {
                return x;
            }
        }
        @Contract()
        class B {
            n(@GreaterThan(0) y: number): number {
                return y;
            }
        }
        void A;
        void B;

        const report = telemetryForContracts();
        expect(report.scanned).toEqual(expect.arrayContaining(['A', 'B']));
        expect(report.classes.map(c => c.name)).toEqual(expect.arrayContaining(['A', 'B']));
    });
});

// ---------------------------------------------------------------------------
// Layering (DEC-012)
// ---------------------------------------------------------------------------

describe('layering (DEC-012)', () => {
    it('imports from Core/ and Contracts/ only — never from a decorator adapter', () => {
        const source: string = require('fs').readFileSync(require.resolve('./telemetry.ts'), 'utf8');
        const imports = source.match(/^import[\s\S]*?from '([^']+)';/gm) || [];

        expect(imports.length).toBeGreaterThan(0);
        imports.forEach(statement => {
            const specifier = (statement.match(/from '([^']+)'/) as RegExpMatchArray)[1];
            expect(specifier).toMatch(/^\.\.\/(Core|Contracts)\//);
        });
    });

    it('never imports a decorator surface (@Telemetry / @Observe / ObservationBehavior) or ./docs', () => {
        const source: string = require('fs').readFileSync(require.resolve('./telemetry.ts'), 'utf8');
        // Checked on import *specifiers*, not bare words — the module header legitimately names these to
        // explain what it does NOT bind to (the adapter-side ObservationBehavior renders; this only reads).
        expect(source).not.toMatch(/from '\.\.\/Telemetry\//);
        expect(source).not.toMatch(/from '\.\.\/MethodDecorators\//);
        expect(source).not.toMatch(/from '[^']*ObservationBehavior'/);
        expect(source).not.toMatch(/from '\.\/docs'/);
    });
});
