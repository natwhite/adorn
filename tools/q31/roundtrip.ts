/**
 * Q-31 — round-trip adorn's tool-schema output through a real OpenAI provider.
 *
 * This is NOT a unit test. It needs the network, a secret, and it costs (a few gpt-4o-mini calls).
 * The hermetic jest suite must never do any of those, so this lives under `tools/` (excluded from the
 * build and from `dist`, per tsconfig) and is named `*.ts` — jest's testMatch never picks it up.
 *
 * What it proves (the Q-31 claim, tracked in docs/ISSUES.md): one adorn declaration produces BOTH the
 * JSON Schema a model reads AND the runtime validator for the model's untrusted reply, and the two
 * agree end-to-end against a real provider. For each case it:
 *   1. builds a tool schema with `toolSchemaFrom` (the descriptor-first path the README recommends),
 *   2. sends it to OpenAI as a function tool and forces the call,
 *   3. validates the model's returned arguments with `Verify.check` against the SAME descriptors,
 *   4. records the verdict — including, as first-class evidence, any case the provider REJECTS or
 *      mis-fills. A failure here is a legitimate, valuable outcome to write down.
 *
 * Run it:   npx ts-node tools/q31/roundtrip.ts
 * Key:      read from the repo-root `.env` (gitignored) as OPENAI_API_KEY, else from the environment.
 *           With no key it still runs the OFFLINE self-check (schemas + local validation) and skips
 *           the live calls.
 * Model:    OPENAI_MODEL env override, default gpt-4o-mini. temperature 0 for determinism.
 *
 * Strict vs non-strict is deliberate. OpenAI's `strict: true` function mode requires
 * `additionalProperties:false` (adorn always emits it) AND that `required` list EVERY property — which
 * collides with adorn's optional params — and supports only a subset of JSON-Schema keywords
 * (`minItems`/`format`/`minimum`/… are historically unsupported). Those collisions are exactly what
 * this harness exists to surface, so cases run in both modes where a mode probes something.
 */
import {readFileSync, writeFileSync} from 'fs';
import {resolve} from 'path';

import {Verify} from '../../src/Validation/Verify';
import type {CheckResult} from '../../src/Validation/Verify';
import {toolSchemaFrom} from '../../src/Projections/schema';
import {OneOf} from '../../src/Contracts/enum';
import {ArrayOf} from '../../src/Contracts/array';
import {Integer, Between} from '../../src/Contracts/number';
import {Uuid, DateTime, NotEmpty} from '../../src/Contracts/string';
import type {ConstraintDescriptor} from '../../src/Core/Descriptor';

// --------------------------------------------------------------------------------------------------
// Secret + config
// --------------------------------------------------------------------------------------------------

/** Read one key from the repo-root `.env` (KEY=VALUE, optional quotes), falling back to the process env. */
function readEnvKey(key: string): string | undefined {
    try {
        const raw = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
            if (m && m[1] === key) {
                let v = m[2];
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                    v = v.slice(1, -1);
                }
                if (v.length > 0) return v;
            }
        }
    } catch {
        /* no .env on disk — fall through to the environment */
    }
    return process.env[key];
}

const API_KEY = readEnvKey('OPENAI_API_KEY');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// --------------------------------------------------------------------------------------------------
// Cases — descriptors are built ONCE and referenced by both the schema (params) and the validator,
// so the two literally cannot drift. That identity is the whole point of the round-trip.
// --------------------------------------------------------------------------------------------------

interface ParamValidator {
    readonly param: string;
    readonly descriptor: ConstraintDescriptor;
    /** Optional params are validated only when the model actually returned them. */
    readonly optional?: boolean;
}

/** The `ok:false` arm of `CheckResult`. Since DEC-079 (strict) the ternary narrows `r` for us — no cast. */
interface CheckFail {
    readonly ok: false;
    readonly message: string;
    readonly constraint: string;
    readonly kind: unknown;
    readonly path?: ReadonlyArray<string | number>;
}
const failOf = (r: CheckResult<unknown>): CheckFail | null => (r.ok ? null : r);

interface Case {
    readonly name: string;
    readonly description: string;
    /** The `toolSchemaFrom` input — named descriptors or ToolParamSpecs. */
    readonly params: {readonly [k: string]: unknown};
    /** The user turn that should induce a well-formed call. */
    readonly prompt: string;
    readonly validators: ReadonlyArray<ParamValidator>;
    /** Which provider modes to exercise. 'strict' probes OpenAI structured-output constraints. */
    readonly modes: ReadonlyArray<'lax' | 'strict'>;
    /** What we expect, so the writeup can flag a surprise vs a known collision. */
    readonly note?: string;
}

const ROSTER = ['alice', 'bob', 'carol', 'dave'];
const SUBJECT = OneOf(ROSTER);
const SUBJECTS = ArrayOf(SUBJECT, {minItems: 1});

const PATIENT_UUID = '3f7c1e94-2a8b-4d6f-9c11-5b0e2a7d8f34'; // synthetic; handed to the model to echo
const PATIENT = Uuid();
const STARTS_AT = DateTime();
const DURATION = Between(15, 120);
const NOTE = NotEmpty();

const CASES: ReadonlyArray<Case> = [
    {
        // The consumer's real example (round-4 §"Six for six"): a per-session enum, arrayed.
        name: 'splitFor',
        description: 'Record which roster members affirmed the plan and which denied it on this call.',
        params: {affirmed: SUBJECTS, denied: SUBJECTS},
        prompt:
            `The roster on this call is: ${ROSTER.join(', ')}. ` +
            `alice and bob affirmed the plan; carol denied it; dave did not respond. ` +
            `Record who affirmed and who denied.`,
        validators: [
            {param: 'affirmed', descriptor: SUBJECTS},
            {param: 'denied', descriptor: SUBJECTS},
        ],
        modes: ['lax', 'strict'],
        note: 'strict may reject `minItems` (unsupported keyword) — a provider-quirk finding.',
    },
    {
        // Validating string formats + a numeric range, all required.
        name: 'bookAppointment',
        description: 'Book an appointment for a patient at a start time for a duration in minutes.',
        params: {patientId: PATIENT, startsAt: STARTS_AT, durationMinutes: DURATION},
        prompt: `Book patient ${PATIENT_UUID} an appointment starting 2026-08-12T14:30:00Z for 45 minutes.`,
        validators: [
            {param: 'patientId', descriptor: PATIENT},
            {param: 'startsAt', descriptor: STARTS_AT},
            {param: 'durationMinutes', descriptor: DURATION},
        ],
        modes: ['lax', 'strict'],
        note: 'strict may reject `format`/`minimum`/`maximum` — provider-quirk finding.',
    },
    {
        // The headline strict-mode collision: an OPTIONAL param drops out of `required`, which strict
        // mode forbids. Non-strict should accept; strict is EXPECTED to 400. This is the interaction
        // that ties Q-31 to the P1 Fields/optional work.
        name: 'scheduleReminder',
        description: 'Schedule a reminder for a patient, optionally with a free-text note.',
        params: {patientId: PATIENT, note: {descriptor: NOTE, optional: true}},
        prompt: `Schedule a reminder for patient ${PATIENT_UUID}. No note is needed.`,
        validators: [
            {param: 'patientId', descriptor: PATIENT},
            {param: 'note', descriptor: NOTE, optional: true},
        ],
        modes: ['lax', 'strict'],
        note: 'strict EXPECTED to reject: adorn drops an optional param from `required`, which strict forbids.',
    },
];

// --------------------------------------------------------------------------------------------------
// Offline self-check — prove the harness itself before spending a single call.
// --------------------------------------------------------------------------------------------------

interface SelfCheck {
    readonly name: string;
    readonly schema: unknown;
    readonly positive: string;
    readonly negative: string;
}

/** A crafted good/bad payload per case, to confirm the validators behave locally. */
const SELF_PAYLOADS: {[name: string]: {good: unknown; bad: unknown; via: ParamValidator}} = {
    splitFor: {good: ['alice', 'bob'], bad: ['alice', 'zzz'], via: {param: 'affirmed', descriptor: SUBJECTS}},
    bookAppointment: {good: PATIENT_UUID, bad: 'not-a-uuid', via: {param: 'patientId', descriptor: PATIENT}},
    scheduleReminder: {good: 'call back re: labs', bad: '', via: {param: 'note', descriptor: NOTE}},
};

function runSelfChecks(): SelfCheck[] {
    const out: SelfCheck[] = [];
    for (const c of CASES) {
        const schema = toolSchemaFrom({name: c.name, description: c.description, params: c.params as never});
        const p = SELF_PAYLOADS[c.name];
        const goodFail = failOf(Verify.check(p.via.descriptor, p.via.param, p.good));
        const badFail = failOf(Verify.check(p.via.descriptor, p.via.param, p.bad));
        const positive = goodFail
            ? `UNEXPECTED FAIL: ${goodFail.message}`
            : `PASS (accepts ${JSON.stringify(p.good)})`;
        const negative = badFail
            ? `PASS (rejects ${JSON.stringify(p.bad)}: ${badFail.message}${badFail.path ? ` @${JSON.stringify(badFail.path)}` : ''})`
            : `UNEXPECTED PASS on ${JSON.stringify(p.bad)}`;
        out.push({name: c.name, schema, positive, negative});
        console.log(`\n[self-check] ${c.name}`);
        console.log('  schema:', JSON.stringify(schema));
        console.log('  positive:', positive);
        console.log('  negative:', negative);
    }
    return out;
}

// --------------------------------------------------------------------------------------------------
// Live round-trip
// --------------------------------------------------------------------------------------------------

interface RoundTrip {
    readonly name: string;
    readonly mode: 'lax' | 'strict';
    readonly httpStatus: number | 'error';
    readonly schemaAccepted: boolean;
    readonly toolCallReturned: boolean;
    readonly argsValid: boolean | 'n/a';
    readonly verdict: 'ROUND-TRIP OK' | 'SCHEMA REJECTED' | 'NO TOOL CALL' | 'ARGS INVALID' | 'ERROR';
    readonly detail: string;
}

async function callProvider(c: Case, mode: 'lax' | 'strict'): Promise<RoundTrip> {
    const parameters = toolSchemaFrom({name: c.name, description: c.description, params: c.params as never});
    const fn: {name: string; description: string; parameters: unknown; strict?: boolean} = {
        name: c.name,
        description: c.description,
        parameters,
    };
    if (mode === 'strict') fn.strict = true;

    let httpStatus: number | 'error' = 'error';
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`},
            body: JSON.stringify({
                model: MODEL,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content: 'You call the provided tool with correct arguments. Do not ask questions.',
                    },
                    {role: 'user', content: c.prompt},
                ],
                tools: [{type: 'function', function: fn}],
                tool_choice: {type: 'function', function: {name: c.name}},
            }),
        });
        httpStatus = res.status;
        const json: any = await res.json();

        if (!res.ok) {
            const msg = json?.error?.message ?? JSON.stringify(json).slice(0, 400);
            return {
                name: c.name,
                mode,
                httpStatus,
                schemaAccepted: false,
                toolCallReturned: false,
                argsValid: 'n/a',
                verdict: 'SCHEMA REJECTED',
                detail: msg,
            };
        }

        const call = json?.choices?.[0]?.message?.tool_calls?.[0];
        const argsRaw: string | undefined = call?.function?.arguments;
        if (typeof argsRaw !== 'string') {
            return {
                name: c.name,
                mode,
                httpStatus,
                schemaAccepted: true,
                toolCallReturned: false,
                argsValid: 'n/a',
                verdict: 'NO TOOL CALL',
                detail: `no tool_call in reply: ${JSON.stringify(json?.choices?.[0]?.message ?? json).slice(0, 300)}`,
            };
        }

        const args = JSON.parse(argsRaw);
        const failures: string[] = [];
        for (const v of c.validators) {
            const present =
                Object.prototype.hasOwnProperty.call(args, v.param) && args[v.param] !== undefined;
            if (!present) {
                if (v.optional) continue;
                failures.push(`${v.param}: missing (required)`);
                continue;
            }
            const rf = failOf(Verify.check(v.descriptor, v.param, args[v.param]));
            if (rf) {
                const at = rf.path && rf.path.length ? ` @${JSON.stringify(rf.path)}` : '';
                failures.push(`${v.param}${at}: ${rf.message}`);
            }
        }
        const argsValid = failures.length === 0;
        return {
            name: c.name,
            mode,
            httpStatus,
            schemaAccepted: true,
            toolCallReturned: true,
            argsValid,
            verdict: argsValid ? 'ROUND-TRIP OK' : 'ARGS INVALID',
            detail: `args=${argsRaw}${argsValid ? '' : ` | failures: ${failures.join('; ')}`}`,
        };
    } catch (e) {
        return {
            name: c.name,
            mode,
            httpStatus,
            schemaAccepted: false,
            toolCallReturned: false,
            argsValid: 'n/a',
            verdict: 'ERROR',
            detail: String((e as Error)?.message ?? e),
        };
    }
}

// --------------------------------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------------------------------

function writeReport(selfChecks: SelfCheck[], trips: RoundTrip[]): void {
    const lines: string[] = [];
    lines.push('# Q-31 — tool-schema round-trip through a real provider');
    lines.push('');
    lines.push(
        `**Provider:** OpenAI \`${MODEL}\` · **temperature:** 0 · this is the evidence artifact for Q-31.`,
    );
    lines.push('');
    lines.push(
        'Generated by `tools/q31/roundtrip.ts`. A schema below is emitted by `toolSchemaFrom` from the',
    );
    lines.push(
        'same descriptors used to validate the reply, so schema and validator cannot drift by construction.',
    );
    lines.push('');

    lines.push('## Round-trip results');
    lines.push('');
    if (trips.length === 0) {
        lines.push('_No live calls were made (OPENAI_API_KEY absent). Offline self-check only — see below._');
    } else {
        lines.push(
            '| Case | Mode | HTTP | Schema accepted | Tool call | Args valid (`Verify.check`) | Verdict |',
        );
        lines.push('| --- | --- | --- | --- | --- | --- | --- |');
        for (const t of trips) {
            lines.push(
                `| ${t.name} | ${t.mode} | ${t.httpStatus} | ${t.schemaAccepted ? 'yes' : 'NO'} | ` +
                    `${t.toolCallReturned ? 'yes' : 'no'} | ${t.argsValid} | ${t.verdict} |`,
            );
        }
        lines.push('');
        lines.push('### Detail');
        lines.push('');
        for (const t of trips) {
            lines.push(`- **${t.name} / ${t.mode}** — ${t.verdict}: ${t.detail}`);
        }
    }
    lines.push('');

    lines.push('## Offline self-check (no network)');
    lines.push('');
    lines.push(
        'Each case, before any call: the emitted schema, plus a local positive/negative `Verify.check`.',
    );
    lines.push('');
    for (const s of selfChecks) {
        lines.push(`### ${s.name}`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(s.schema, null, 2));
        lines.push('```');
        lines.push('');
        lines.push(`- positive: ${s.positive}`);
        lines.push(`- negative: ${s.negative}`);
        lines.push('');
    }

    const path = resolve(__dirname, '../../docs/q31-results.md');
    writeFileSync(path, lines.join('\n'), 'utf8');
    console.log(`\nwrote ${path}`);
}

// --------------------------------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
    console.log(`Q-31 round-trip — model=${MODEL}, key=${API_KEY ? 'present' : 'ABSENT'}`);
    const selfChecks = runSelfChecks();

    const offline = process.argv.includes('--offline') || process.env.Q31_OFFLINE === '1';

    const trips: RoundTrip[] = [];
    if (offline) {
        console.log('\n--offline: skipping live calls (schemas + local validation only).');
    } else if (!API_KEY) {
        console.log(
            '\nNo OPENAI_API_KEY (checked .env then environment). Ran the offline self-check only; ' +
                'set the key to make the live calls.',
        );
    } else {
        for (const c of CASES) {
            for (const mode of c.modes) {
                const t = await callProvider(c, mode);
                console.log(`\n[live] ${t.name} / ${t.mode}: ${t.verdict} (HTTP ${t.httpStatus})`);
                console.log('  ', t.detail);
                trips.push(t);
            }
        }
    }

    writeReport(selfChecks, trips);
}

void main();
