/**
 * String formats — `@Uuid` / `@DateTime` / `@Ipv4` / `@Format` (IDEA-23).
 *
 * These are **validating** formats (not annotate-only): each descriptor pairs a total, strict predicate
 * with `{type:'string', format:'<name>'}`. The load-bearing property is the S3 fix — the predicate is
 * **at least as strict as the `format` keyword** (predicate-accepts ⊆ format-accepts), so the emitted
 * `format` never rejects a value enforcement accepts (the DEC-029 over-claim). Each format therefore
 * carries an over-claim-direction test below.
 *
 * Descriptor-level, driven through the `StringContracts` namespace (where the format factories ride) and
 * the parameter decorators — no `resetRegistry` needed (each class is a fresh constructor).
 */

import {Uuid, DateTime, Ipv4, Format} from '../src/ParameterDecorators/Constraints';
import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {toolSchemaForMethod} from '../src/Projections/schema';
import * as StringContracts from '../src/Contracts/string';
import {JsonObject} from '../src/Core/Descriptor';

// A canonical UUID and a few valid RFC 3339 date-times, reused across the accept assertions.
const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';
const VALID_DATE_TIMES = [
    '2020-01-02T03:04:05Z',
    '2020-01-02t03:04:05z', // RFC 3339 permits lowercase 't'/'z'
    '2020-06-15T12:30:00.123Z', // fractional seconds
    '2020-06-15T12:30:00+02:00', // numeric offset
    '2020-02-29T00:00:00Z', // a real leap day
    '1985-12-31T23:59:60Z', // a leap second (RFC 3339 §5.6)
];

// ---------------------------------------------------------------------------
// Predicate totality (BUG-4) — a non-string is `false`, never a thrown TypeError
// ---------------------------------------------------------------------------

describe('format predicates are total (BUG-4)', () => {
    const NON_STRINGS: unknown[] = [null, undefined, 42, NaN, true, {}, [], Symbol('x') as unknown];

    it.each([
        ['uuid', StringContracts.Uuid()],
        ['date-time', StringContracts.DateTime()],
        ['ipv4', StringContracts.Ipv4()],
    ])('%s rejects every non-string without throwing', (_name, descriptor) => {
        for (const value of NON_STRINGS) {
            expect(() => descriptor.predicate(value)).not.toThrow();
            expect(descriptor.predicate(value)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// @Uuid
// ---------------------------------------------------------------------------

describe('@Uuid (validating)', () => {
    const uuid = StringContracts.Uuid();

    it('accepts a canonical UUID (upper or lower hex) and emits {type:string, format:uuid}', () => {
        expect(uuid.predicate(VALID_UUID)).toBe(true);
        expect(uuid.predicate(VALID_UUID.toUpperCase())).toBe(true);
        expect(uuid.schema!()).toEqual({type: 'string', format: 'uuid'});
    });

    it('S3 over-claim direction: rejects strings the `format:uuid` keyword rejects (predicate ⊆ format)', () => {
        // Each of these is NOT a canonical UUID, so a validator asserting `format:uuid` rejects it. The
        // strict predicate rejects it too, so the emitted `format` never rejects a value enforcement
        // accepts — the direction DEC-029 requires.
        for (const bad of [
            '123e4567e89b12d3a456426614174000', // no hyphens
            '123e4567-e89b-12d3-a456', // too short
            'zzze4567-e89b-12d3-a456-426614174000', // non-hex
            '123e4567-e89b-12d3-a456-4266141740000', // last group too long
            ' 123e4567-e89b-12d3-a456-426614174000', // leading space
        ]) {
            expect(uuid.predicate(bad)).toBe(false);
        }
    });

    it('under-claim safety: rejects a plain string that a `format`-IGNORING validator ({type:string}) accepts', () => {
        // The safe direction — enforcement is stricter than the published `{type:string}` floor.
        expect(uuid.predicate('hello')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// @DateTime — the S3 headline (strict RFC 3339, not Date.parse)
// ---------------------------------------------------------------------------

describe('@DateTime (validating, strict RFC 3339)', () => {
    const dt = StringContracts.DateTime();

    it('accepts valid RFC 3339 date-times and emits {type:string, format:date-time}', () => {
        for (const s of VALID_DATE_TIMES) expect(dt.predicate(s)).toBe(true);
        expect(dt.schema!()).toEqual({type: 'string', format: 'date-time'});
    });

    it('S3 over-claim direction: rejects the Date.parse SUPERSET (the DEC-029 over-claim avoided)', () => {
        // A `Date.parse`-based predicate — the obvious wrong reading of "parse" — ACCEPTS these while a
        // validator asserting `format:date-time` REJECTS them. That mismatch is the exact over-claim S3
        // forbids. Document the direction: Date.parse accepts them, our strict predicate does not.
        const dateParseAcceptsButNotRfc3339 = ['2020', '2020-01-01', 'Wed Jul 29 2026'];
        for (const s of dateParseAcceptsButNotRfc3339) {
            expect(Number.isNaN(Date.parse(s))).toBe(false); // Date.parse is looser — accepts it
            expect(dt.predicate(s)).toBe(false); // the strict predicate rejects it — no over-claim
        }
    });

    it('rejects out-of-range / non-calendar components a strict `format:date-time` rejects', () => {
        for (const bad of [
            '2020-13-01T00:00:00Z', // month 13
            '2020-00-01T00:00:00Z', // month 0
            '2021-02-30T00:00:00Z', // Feb 30 — not a real day
            '2021-02-29T00:00:00Z', // 2021 is not a leap year
            '2020-01-01T25:00:00Z', // hour 25
            '2020-01-01T00:60:00Z', // minute 60
            '2020-01-01T00:00:00', // no offset / Z
            '2020-01-01 00:00:00Z', // space instead of 'T'
            '2020-01-01T00:00:00+25:00', // offset hour out of range
        ]) {
            expect(dt.predicate(bad)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// @Ipv4
// ---------------------------------------------------------------------------

describe('@Ipv4 (validating)', () => {
    const ipv4 = StringContracts.Ipv4();

    it('accepts a dotted quad in range and emits {type:string, format:ipv4}', () => {
        for (const s of ['0.0.0.0', '255.255.255.255', '192.168.1.1', '8.8.8.8']) {
            expect(ipv4.predicate(s)).toBe(true);
        }
        expect(ipv4.schema!()).toEqual({type: 'string', format: 'ipv4'});
    });

    it('S3 over-claim direction: rejects strings the `format:ipv4` keyword rejects (predicate ⊆ format)', () => {
        for (const bad of [
            '256.0.0.1', // octet > 255
            '1.2.3', // too few octets
            '1.2.3.4.5', // too many octets
            '1.2.3.4 ', // trailing space
            'a.b.c.d', // non-numeric
            '1.2.3.-1', // negative
        ]) {
            expect(ipv4.predicate(bad)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// @Format — the keyed alias, and its loud refusal of unknown names
// ---------------------------------------------------------------------------

describe('@Format (keyed alias over the validating formats)', () => {
    it('@Format(name) ≡ the named descriptor for each supported format', () => {
        expect(StringContracts.Format('uuid').constraint).toBe('uuid');
        expect(StringContracts.Format('date-time').constraint).toBe('dateTime');
        expect(StringContracts.Format('ipv4').constraint).toBe('ipv4');
        // Same schema as the named factory — one rule, two spellings.
        expect(StringContracts.Format('uuid').schema!()).toEqual(StringContracts.Uuid().schema!());
        expect(StringContracts.Format('date-time').schema!()).toEqual(StringContracts.DateTime().schema!());
    });

    it('refuses an unknown name LOUDLY at decoration, listing the supported names (no unbacked format)', () => {
        expect(() => StringContracts.Format('int32')).toThrow(TypeError);
        expect(() => StringContracts.Format('int32')).toThrow(/unknown format 'int32'/);
        expect(() => StringContracts.Format('int32')).toThrow(/uuid, date-time, ipv4/);
        // The parameter-decorator form throws just as eagerly (the descriptor is built at decoration).
        expect(() => Format('email-ish')).toThrow(/unknown format/);
    });
});

// ---------------------------------------------------------------------------
// The decorators flow the format fragment into the tool schema
// ---------------------------------------------------------------------------

describe('the format decorators project their fragment (DEC-010 — one descriptor, both artifacts)', () => {
    it('@Uuid / @DateTime / @Ipv4 / @Format each emit {type:string, format:…} into the tool schema', () => {
        @Contract()
        class Api {
            call(
                @Uuid() id: string,
                @DateTime() at: string,
                @Ipv4() host: string,
                @Format('uuid') alt: string,
            ): void {
                void id;
                void at;
                void host;
                void alt;
            }
        }

        const props = toolSchemaForMethod(Api, 'call').properties as Record<string, JsonObject>;
        expect(props.id).toEqual({type: 'string', format: 'uuid'});
        expect(props.at).toEqual({type: 'string', format: 'date-time'});
        expect(props.host).toEqual({type: 'string', format: 'ipv4'});
        expect(props.alt).toEqual({type: 'string', format: 'uuid'}); // @Format('uuid') ≡ @Uuid()
        // All carry a constraint, so all are required.
        expect(toolSchemaForMethod(Api, 'call').required).toEqual(['id', 'at', 'host', 'alt']);
    });
});
