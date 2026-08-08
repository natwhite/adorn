/**
 * Q-32(b) empirical probe — does OpenAI `strict:true` actually ACCEPT the nullable-but-required
 * encoding Slice D proposes for an optional param?
 *
 * Q-31 proved the FAILURE (an optional prop dropped from `required` → HTTP 400). It never tested the
 * FIX. This probe hand-crafts the candidate encodings (no need to build Slice D to test its schema)
 * and reports which the provider accepts, so the design rests on evidence, not assumption. The
 * trickiest are the enum forms — `@OneOf` emits `{enum:[…]}` with no `type`, so "add null" has two
 * candidate spellings and we don't know a priori which strict mode tolerates.
 *
 * Run:  npx ts-node tools/q31/strict-fix-probe.ts
 * Key:  OPENAI_API_KEY from repo-root .env (gitignored) or the environment. Model: OPENAI_MODEL or gpt-4o-mini.
 */
import {readFileSync} from 'fs';
import {resolve} from 'path';

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

interface Probe {
    readonly name: string;
    readonly why: string;
    readonly parameters: unknown; // the hand-crafted strict schema
    readonly prompt: string;
}

const PROBES: ReadonlyArray<Probe> = [
    {
        name: 'nullable-required string (the core Slice-D encoding)',
        why: 'optional `note` kept in required, type widened to include null',
        parameters: {
            type: 'object',
            properties: {
                patientId: {type: 'string'},
                note: {type: ['string', 'null']},
            },
            required: ['patientId', 'note'],
            additionalProperties: false,
        },
        prompt: 'Schedule a reminder for patient p-123. No note is needed.',
    },
    {
        name: 'nullable-required string WITH minLength (keyword coexistence)',
        why: 'does a bound keyword survive alongside the null union under strict?',
        parameters: {
            type: 'object',
            properties: {
                patientId: {type: 'string'},
                note: {type: ['string', 'null'], minLength: 1},
            },
            required: ['patientId', 'note'],
            additionalProperties: false,
        },
        prompt: 'Schedule a reminder for patient p-123. No note is needed.',
    },
    {
        name: 'optional enum via null-in-enum members',
        why: '@OneOf emits {enum:[…]} with no type; candidate A = append null to members',
        parameters: {
            type: 'object',
            properties: {
                patientId: {type: 'string'},
                subject: {enum: ['alice', 'bob', 'carol', null]},
            },
            required: ['patientId', 'subject'],
            additionalProperties: false,
        },
        prompt: 'Schedule a reminder for patient p-123. No subject in particular.',
    },
    {
        name: 'optional enum via anyOf(enum, null)',
        why: 'candidate B = anyOf of the enum and a null type',
        parameters: {
            type: 'object',
            properties: {
                patientId: {type: 'string'},
                subject: {anyOf: [{type: 'string', enum: ['alice', 'bob', 'carol']}, {type: 'null'}]},
            },
            required: ['patientId', 'subject'],
            additionalProperties: false,
        },
        prompt: 'Schedule a reminder for patient p-123. No subject in particular.',
    },
    {
        name: 'nullable-required nested OBJECT (Fields/Shape optional field)',
        why: 'an optional object-typed field: type widened to [object,null]',
        parameters: {
            type: 'object',
            properties: {
                patientId: {type: 'string'},
                slot: {
                    type: ['object', 'null'],
                    properties: {when: {type: 'string'}, kind: {type: 'string'}},
                    required: ['when', 'kind'],
                    additionalProperties: false,
                },
            },
            required: ['patientId', 'slot'],
            additionalProperties: false,
        },
        prompt: 'Schedule a reminder for patient p-123. No specific slot.',
    },
];

async function run(p: Probe): Promise<void> {
    const fn = {name: 'schedule', description: 'schedule a reminder', parameters: p.parameters, strict: true};
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`},
            body: JSON.stringify({
                model: MODEL,
                temperature: 0,
                messages: [
                    {role: 'system', content: 'Call the tool with correct arguments. Do not ask questions.'},
                    {role: 'user', content: p.prompt},
                ],
                tools: [{type: 'function', function: fn}],
                tool_choice: {type: 'function', function: {name: 'schedule'}},
            }),
        });
        const json: any = await res.json();
        if (!res.ok) {
            console.log(`\n[${p.name}]\n  strict-accepted: NO (HTTP ${res.status})`);
            console.log('  reason:', json?.error?.message ?? JSON.stringify(json).slice(0, 300));
            return;
        }
        const args = json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
        console.log(`\n[${p.name}]\n  strict-accepted: YES (HTTP 200)`);
        console.log('  model args:', args);
    } catch (e) {
        console.log(`\n[${p.name}]\n  ERROR:`, String((e as Error)?.message ?? e));
    }
}

async function main(): Promise<void> {
    console.log(`Q-32(b) strict-fix probe — model=${MODEL}, key=${API_KEY ? 'present' : 'ABSENT'}`);
    if (!API_KEY) {
        console.log('No OPENAI_API_KEY — set it to run the probe.');
        return;
    }
    for (const p of PROBES) {
        console.log(`\n--- ${p.why}`);
        await run(p);
    }
}

void main();
