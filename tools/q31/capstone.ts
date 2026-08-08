/**
 * Q-31 / Q-32 CAPSTONE — round-trip the ACTUAL generated schemas through OpenAI.
 *
 * Q-31 (`roundtrip.ts`) proved `toolSchemaFrom` output round-trips; `strict-fix-probe.ts` proved the strict
 * ENCODINGS are accepted (hand-crafted). This closes the loop with the REAL code paths shipped in the round-4
 * buildout — `Fields`, `Nullable`, and `toolSchemaFrom({providerStrict})` — so the schema a consumer actually
 * gets is emitted by adorn, filled by a real model, and validated by the SAME descriptors via `Verify.check`.
 * It also probes the ONE known boundary (a nested `Fields` optional under `providerStrict`, deferred in DEC-068)
 * so the deferral is documented with evidence rather than assumed.
 *
 * Run:  npx ts-node tools/q31/capstone.ts   ·   Key: OPENAI_API_KEY from .env or env   ·   Model: OPENAI_MODEL || gpt-4o-mini
 * Writes docs/q31-capstone-results.md.
 */
import {readFileSync, writeFileSync} from 'fs';
import {resolve} from 'path';

import {Verify} from '../../src/Validation/Verify';
import type {CheckResult} from '../../src/Validation/Verify';
import {toolSchemaFrom} from '../../src/Projections/schema';
import {Uuid, DateTime, NotEmpty} from '../../src/Contracts/string';
import {Integer} from '../../src/Contracts/number';
import {Nullable} from '../../src/Contracts/nullable';
import {Fields} from '../../src/Contracts/object';
import type {ConstraintDescriptor} from '../../src/Core/Descriptor';

// --------------------------------------------------------------------------------------------------
// Secret + config (same convention as roundtrip.ts)
// --------------------------------------------------------------------------------------------------
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
        /* fall through */
    }
    return process.env[key];
}
const API_KEY = readEnvKey('OPENAI_API_KEY');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// The `ok:false` arm — the union doesn't narrow under this repo's strict:false, so read failures via a cast.
interface CheckFail {
    readonly ok: false;
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
    readonly expected?: string;
}
const failOf = (r: CheckResult<unknown>): CheckFail | null => (r.ok ? null : (r as unknown as CheckFail));

// --------------------------------------------------------------------------------------------------
// Descriptors + schemas — built by the REAL code, once, and REUSED as the validators (so nothing can drift)
// --------------------------------------------------------------------------------------------------
const PATIENT = Uuid();
const NOTE = Nullable(NotEmpty()); // "may be null" — the declaration that makes an optional strict-compatible
const PATIENT_UUID = '3f7c1e94-2a8b-4d6f-9c11-5b0e2a7d8f34';

const SLOT_LAX = Fields({when: DateTime(), label: {descriptor: NotEmpty(), optional: true}});
const SLOT_STRICT_ALL = Fields({when: DateTime(), duration: Integer()});
// DEC-069: a NULLABLE optional field — strict-compatible once providerStrict promotes it into the nested required.
const SLOT_STRICT_OPT = Fields({
    when: DateTime(),
    label: {descriptor: Nullable(NotEmpty()), optional: true, default: 'untitled'},
});

interface Validator {
    readonly param: string;
    readonly descriptor: ConstraintDescriptor;
    readonly optional?: boolean;
}
interface Case {
    readonly name: string;
    readonly expectation: string;
    readonly schema: unknown;
    readonly strict: boolean;
    readonly prompt: string;
    readonly validators: ReadonlyArray<Validator>;
}

const CASES: ReadonlyArray<Case> = [
    {
        name: 'reminder — providerStrict + Nullable optional (the Slice-D headline)',
        expectation: 'accepted under strict; model sends note:null; the Nullable validator ACCEPTS null → no drift',
        schema: toolSchemaFrom(
            {
                name: 'scheduleReminder',
                description: 'Schedule a reminder for a patient, optionally with a free-text note.',
                params: {patientId: PATIENT, note: {descriptor: NOTE, optional: true}},
            },
            {providerStrict: true},
        ),
        strict: true,
        prompt: `Schedule a reminder for patient ${PATIENT_UUID}. No note is needed.`,
        validators: [
            {param: 'patientId', descriptor: PATIENT},
            {param: 'note', descriptor: NOTE},
        ],
    },
    {
        name: 'book — a Fields param with an optional field (non-strict)',
        expectation: 'Fields schema accepted; model fills the nested object; the Fields validator accepts it',
        schema: toolSchemaFrom({name: 'book', description: 'Book a slot.', params: {slot: SLOT_LAX}}),
        strict: false,
        prompt: 'Book a slot starting 2026-08-15T09:00:00Z (no particular label).',
        validators: [{param: 'slot', descriptor: SLOT_LAX}],
    },
    {
        name: 'bookStrict — a Fields param, ALL fields required (providerStrict)',
        expectation: 'accepted under strict (the nested object is fully closed); validator accepts',
        schema: toolSchemaFrom(
            {name: 'bookStrict', description: 'Book a slot with a duration in minutes.', params: {slot: SLOT_STRICT_ALL}},
            {providerStrict: true},
        ),
        strict: true,
        prompt: 'Book a slot starting 2026-08-15T09:00:00Z for 30 minutes.',
        validators: [{param: 'slot', descriptor: SLOT_STRICT_ALL}],
    },
    {
        name: 'bookStrictOpt — a Fields param with a NULLABLE optional field (providerStrict) — the DEC-069 FIX',
        expectation:
            'ROUND-TRIP OK (was the case-4 400 in the prior capstone): strictifyForProvider promotes the nullable ' +
            'optional `label` into the NESTED `required` with its null-union + default, so OpenAI strict accepts ' +
            'it; the model sends `label` as null or a string, and the Fields validator (whose label is Nullable) ' +
            'accepts either — closing the nested boundary DEC-068 had left open.',
        schema: toolSchemaFrom(
            {name: 'bookStrictOpt', description: 'Book a slot, with an optional label.', params: {slot: SLOT_STRICT_OPT}},
            {providerStrict: true},
        ),
        strict: true,
        prompt: 'Book a slot starting 2026-08-15T09:00:00Z (no particular label).',
        validators: [{param: 'slot', descriptor: SLOT_STRICT_OPT}],
    },
];

// --------------------------------------------------------------------------------------------------
// Live round-trip
// --------------------------------------------------------------------------------------------------
interface Result {
    readonly name: string;
    readonly httpStatus: number | 'error';
    readonly schemaAccepted: boolean;
    readonly toolCall: boolean;
    readonly argsValid: boolean | 'n/a';
    readonly verdict: string;
    readonly detail: string;
}

async function runCase(c: Case): Promise<Result> {
    const fn: {name: string; description: string; parameters: unknown; strict?: boolean} = {
        name: (c.schema as {title?: string}).title || 'tool',
        description: 'see schema',
        parameters: c.schema,
    };
    if (c.strict) fn.strict = true;
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`},
            body: JSON.stringify({
                model: MODEL,
                temperature: 0,
                messages: [
                    {role: 'system', content: 'Call the provided tool with correct arguments. Do not ask questions.'},
                    {role: 'user', content: c.prompt},
                ],
                tools: [{type: 'function', function: fn}],
                tool_choice: {type: 'function', function: {name: fn.name}},
            }),
        });
        const json: any = await res.json();
        if (!res.ok) {
            return {
                name: c.name,
                httpStatus: res.status,
                schemaAccepted: false,
                toolCall: false,
                argsValid: 'n/a',
                verdict: 'SCHEMA REJECTED',
                detail: json?.error?.message ?? JSON.stringify(json).slice(0, 300),
            };
        }
        const argsRaw: string | undefined = json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
        if (typeof argsRaw !== 'string') {
            return {
                name: c.name,
                httpStatus: res.status,
                schemaAccepted: true,
                toolCall: false,
                argsValid: 'n/a',
                verdict: 'NO TOOL CALL',
                detail: JSON.stringify(json?.choices?.[0]?.message ?? json).slice(0, 300),
            };
        }
        const args = JSON.parse(argsRaw);
        const failures: string[] = [];
        for (const v of c.validators) {
            const present = Object.prototype.hasOwnProperty.call(args, v.param) && args[v.param] !== undefined;
            if (!present) {
                if (v.optional) continue;
                failures.push(`${v.param}: missing`);
                continue;
            }
            const f = failOf(Verify.check(v.descriptor, v.param, args[v.param]));
            if (f) failures.push(`${v.param}${f.path ? ` @${JSON.stringify(f.path)}` : ''}: ${f.message}`);
        }
        const argsValid = failures.length === 0;
        return {
            name: c.name,
            httpStatus: res.status,
            schemaAccepted: true,
            toolCall: true,
            argsValid,
            verdict: argsValid ? 'ROUND-TRIP OK' : 'ARGS INVALID',
            detail: `args=${argsRaw}${argsValid ? '' : ` | ${failures.join('; ')}`}`,
        };
    } catch (e) {
        return {
            name: c.name,
            httpStatus: 'error',
            schemaAccepted: false,
            toolCall: false,
            argsValid: 'n/a',
            verdict: 'ERROR',
            detail: String((e as Error)?.message ?? e),
        };
    }
}

// --------------------------------------------------------------------------------------------------
// Local negative — the validator is the real guard (no network): a crafted bad reply is caught, with path+expected
// --------------------------------------------------------------------------------------------------
function localNegatives(): string[] {
    const lines: string[] = [];
    const badWhen = failOf(Verify.check(SLOT_LAX, 'slot', {when: 'not-a-datetime'}));
    lines.push(
        badWhen
            ? `- bad nested value \`{when:'not-a-datetime'}\` → REJECTED @${JSON.stringify(badWhen.path)}, expected: ${badWhen.expected}`
            : '- UNEXPECTED: bad nested value passed',
    );
    const missing = failOf(Verify.check(SLOT_LAX, 'slot', {}));
    lines.push(
        missing
            ? `- missing required \`when\` → REJECTED @${JSON.stringify(missing.path)}, expected: ${missing.expected}`
            : '- UNEXPECTED: missing required field passed',
    );
    const nullNote = Verify.check(NOTE, 'note', null);
    lines.push(`- Nullable(NotEmpty()) on \`null\` → ${nullNote.ok ? 'ACCEPTS (as designed — no drift)' : 'REJECTS (unexpected!)'}`);
    const emptyNote = failOf(Verify.check(NOTE, 'note', ''));
    lines.push(`- Nullable(NotEmpty()) on \`""\` → ${emptyNote ? 'REJECTS (still enforces non-empty)' : 'UNEXPECTED: accepted'}`);
    // DEC-069 refusal: a BARE (non-nullable) optional field under providerStrict throws at BUILD, not at the API.
    try {
        toolSchemaFrom(
            {params: {slot: Fields({when: DateTime(), label: {descriptor: NotEmpty(), optional: true}})}},
            {providerStrict: true},
        );
        lines.push('- UNEXPECTED: a bare non-nullable optional under providerStrict did NOT refuse');
    } catch (e) {
        lines.push(`- bare optional field under providerStrict → REFUSED at build (${String((e as Error).message).split(' — ')[0]})`);
    }
    return lines;
}

// --------------------------------------------------------------------------------------------------
function report(results: Result[], negatives: string[]): void {
    const lines: string[] = [];
    lines.push('# Q-31 / Q-32 capstone — real generated schemas round-tripped through OpenAI');
    lines.push('');
    lines.push(`**Provider:** OpenAI \`${MODEL}\` · **temperature:** 0. Schemas emitted by the REAL round-4 code`);
    lines.push('(`Fields`, `Nullable`, `toolSchemaFrom({providerStrict})`) and validated by the SAME descriptors.');
    lines.push('');
    if (results.length === 0) {
        lines.push('_No live calls (OPENAI_API_KEY absent). Local negatives only — see below._');
    } else {
        lines.push('| Case | HTTP | Schema accepted | Tool call | Args valid | Verdict |');
        lines.push('| --- | --- | --- | --- | --- | --- |');
        for (const r of results) {
            lines.push(
                `| ${r.name} | ${r.httpStatus} | ${r.schemaAccepted ? 'yes' : 'NO'} | ${r.toolCall ? 'yes' : 'no'} | ${r.argsValid} | ${r.verdict} |`,
            );
        }
        lines.push('');
        lines.push('### Detail');
        for (let i = 0; i < results.length; i++) {
            lines.push(`- **${results[i].name}**`);
            lines.push(`  - expectation: ${CASES[i].expectation}`);
            lines.push(`  - result: ${results[i].verdict} (HTTP ${results[i].httpStatus}) — ${results[i].detail}`);
        }
    }
    lines.push('');
    lines.push('## Local negative — the validator is the real guard (no network)');
    lines.push('');
    negatives.forEach(n => lines.push(n));
    lines.push('');
    lines.push('## The generated schemas (verbatim, from the real code)');
    for (let i = 0; i < CASES.length; i++) {
        lines.push('');
        lines.push(`### ${CASES[i].name}`);
        lines.push('```json');
        lines.push(JSON.stringify(CASES[i].schema, null, 2));
        lines.push('```');
    }
    const path = resolve(__dirname, '../../docs/q31-capstone-results.md');
    writeFileSync(path, lines.join('\n'), 'utf8');
    console.log(`\nwrote ${path}`);
}

async function main(): Promise<void> {
    console.log(`Q-31/Q-32 capstone — model=${MODEL}, key=${API_KEY ? 'present' : 'ABSENT'}`);
    const negatives = localNegatives();
    negatives.forEach(n => console.log('  ', n));

    const results: Result[] = [];
    if (!API_KEY) {
        console.log('\nNo OPENAI_API_KEY — local negatives only.');
    } else {
        for (const c of CASES) {
            const r = await runCase(c);
            console.log(`\n[${r.name}]\n  ${r.verdict} (HTTP ${r.httpStatus})\n  ${r.detail}`);
            results.push(r);
        }
    }
    report(results, negatives);
}

void main();
