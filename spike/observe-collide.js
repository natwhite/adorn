/**
 * SPIKE (third pass) — Questions A.2 (correlation / false positives), A.4 (value collision)
 * and A.5 (substring matching).
 *
 * The design catches a copied value because a copied string IS the same string. The inverse of
 * that property is the hazard: an UNRELATED value that happens to equal a sensitive one is
 * indistinguishable from the sensitive one. `true` is `true`.
 *
 * This measures, over a realistic emission workload:
 *   - false-positive rate: benign leaves wrongly redacted
 *   - true-positive rate:  sensitive leaves correctly redacted
 *   - the containment trade: raising the eligibility threshold kills collisions AND protection
 *
 * Run:  node spike/observe-collide.js
 */

'use strict';

const {Sensitive, Log, decorateField, decorateMethod, withScope, emissions, resetEmissions, CENSOR} = require('./observe');

// ---------------------------------------------------------------------------
// A realistic sensitive record. The field SHAPES are the point: a design that only ever sees
// 11-character SSNs is not being tested.
// ---------------------------------------------------------------------------

class Customer {
    constructor() {
        this.ssn = '123-45-6789'; // 11 chars — the easy case
        this.email = 'a@b.com'; // 7 chars — below an 8-char guard
        this.dob = '1981-04-02'; // 10 chars, but DATE-SHAPED
        this.countryCode = 'US'; // 2 chars — a short enum
        this.tier = 'A'; // 1 char
        this.middleName = ''; // EMPTY STRING
        this.consentGiven = true; // BOOLEAN
        this.failedLogins = 0; // ZERO
        this.id = 'cus_0001'; // NOT sensitive
    }
}
for (const k of ['ssn', 'email', 'dob', 'countryCode', 'tier', 'middleName', 'consentGiven', 'failedLogins']) {
    decorateField(Customer.prototype, k, Sensitive());
}

const SENSITIVE_VALUES = ['123-45-6789', 'a@b.com', '1981-04-02', 'US', 'A', '', true, 0];

class Service {
    handle(payload) {
        void payload;
    }
}
decorateMethod(Service.prototype, 'handle', Log());
const SVC = new Service();

// ---------------------------------------------------------------------------
// A benign emission workload. Every leaf here is ground-truth NOT-SENSITIVE: it is an ordinary
// value an application logs. Some of them collide with a sensitive value by pure coincidence,
// and that is exactly what is being counted.
// ---------------------------------------------------------------------------

const BOOLS = [true, false];
const SMALL_INTS = [0, 1, 2, 3, 5, 10, 200, 404, 500];
const SHORT_ENUMS = ['ok', 'A', 'B', 'US', 'GB', 'EUR', 'USD', 'GET', 'POST', 'v1', 'ERROR', 'INFO'];
const IDS = ['ord_88213', 'req_ab12cd34', 'txn_99f0', 'sess_7712aa', 'cus_0002'];
const MESSAGES = ['payment captured', 'retry scheduled', 'cache miss', 'connection reset', 'user A signed in'];
const DATES = ['2024-01-15', '1981-04-02', '2026-07-20'];
const EMPTIES = ['', ' '];

/**
 * Build the benign corpus deterministically so the run is reproducible. `expectRedaction:false`
 * on every leaf — these are all values the emitter SHOULD print.
 */
function buildBenignLeaves(n) {
    const pools = [BOOLS, SMALL_INTS, SHORT_ENUMS, IDS, MESSAGES, DATES, EMPTIES];
    const weights = [18, 22, 20, 15, 12, 8, 5]; // rough shape of real log payloads
    const expanded = [];
    for (let i = 0; i < pools.length; i++) {
        for (let w = 0; w < weights[i]; w++) expanded.push(pools[i]);
    }
    const leaves = [];
    // mulberry32 — the LCG first used here had biased low bits, which under-sampled the short-enum
    // pool and understated the collision count. Taking high bits matters for this measurement.
    let seed = 0x9e3779b9;
    const rnd = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
        const pool = expanded[Math.floor(rnd() * expanded.length)];
        leaves.push(pool[Math.floor(rnd() * pool.length)]);
    }
    return leaves;
}

const BENIGN = buildBenignLeaves(500);

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

function measure(policy) {
    resetEmissions();

    let benignRedacted = 0;
    let sensitiveRedacted = 0;

    withScope(policy, () => {
        const c = new Customer();

        // A realistic handler reads its sensitive fields. This is what arms the scope.
        void c.ssn;
        void c.email;
        void c.dob;
        void c.countryCode;
        void c.tier;
        void c.middleName;
        void c.consentGiven;
        void c.failedLogins;

        // ...then the application logs a lot of ordinary things through adorn's emitter.
        for (const leaf of BENIGN) {
            resetEmissions();
            SVC.handle(leaf);
            const printed = emissions[0].rendered.join('');
            if (printed.indexOf(CENSOR) !== -1) benignRedacted++;
        }

        // ...and it also logs the sensitive values, which MUST be redacted.
        for (const v of SENSITIVE_VALUES) {
            resetEmissions();
            SVC.handle(v);
            const printed = emissions[0].rendered.join('');
            if (printed.indexOf(CENSOR) !== -1) sensitiveRedacted++;
        }
    });

    return {
        fp: benignRedacted,
        fpRate: benignRedacted / BENIGN.length,
        tp: sensitiveRedacted,
        tpRate: sensitiveRedacted / SENSITIVE_VALUES.length,
    };
}

const POLICIES = [
    {label: 'exact, everything (minLen 0, primitives ON)', p: {minLength: 0, primitives: true, match: 'exact', cap: Infinity}},
    {label: 'exact, strings only (minLen 0)', p: {minLength: 0, primitives: false, match: 'exact', cap: Infinity}},
    {label: 'exact, strings minLen 4', p: {minLength: 4, primitives: false, match: 'exact', cap: Infinity}},
    {label: 'exact, strings minLen 8', p: {minLength: 8, primitives: false, match: 'exact', cap: Infinity}},
    {label: 'exact, strings minLen 12', p: {minLength: 12, primitives: false, match: 'exact', cap: Infinity}},
    {
        label: 'SUBSTRING, everything (minLen 0, primitives ON)',
        p: {minLength: 0, primitives: true, match: 'substring', cap: Infinity},
    },
    {label: 'SUBSTRING, strings minLen 4', p: {minLength: 4, primitives: false, match: 'substring', cap: Infinity}},
    {label: 'SUBSTRING, strings minLen 8', p: {minLength: 8, primitives: false, match: 'substring', cap: Infinity}},
    {label: 'SUBSTRING, strings minLen 12', p: {minLength: 12, primitives: false, match: 'substring', cap: Infinity}},
];

console.log('');
console.log('=== A.2 / A.4 / A.5 — false positives, collision, substring ===');
console.log('  benign leaves: ' + BENIGN.length + '   sensitive values emitted: ' + SENSITIVE_VALUES.length);
console.log('');
console.log('  policy                                            FP      FP-rate   TP     TP-rate');
console.log('  ' + '-'.repeat(88));

const rows = [];
for (const {label, p} of POLICIES) {
    const r = measure(p);
    rows.push({label, r});
    console.log(
        '  ' +
            label.padEnd(48) +
            String(r.fp).padStart(4) +
            '   ' +
            (100 * r.fpRate).toFixed(1).padStart(6) +
            '%   ' +
            String(r.tp).padStart(2) +
            '/8  ' +
            (100 * r.tpRate).toFixed(1).padStart(6) +
            '%',
    );
}

// ---------------------------------------------------------------------------
// Which sensitive field is lost at each threshold — the containment trade, made explicit
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.4b — what a length guard costs in PROTECTION ===');
console.log('');
const FIELDS = [
    ['ssn', '123-45-6789'],
    ['dob', '1981-04-02'],
    ['id-like email', 'a@b.com'],
    ['countryCode', 'US'],
    ['tier', 'A'],
    ['middleName', ''],
    ['consentGiven', true],
    ['failedLogins', 0],
];
for (const min of [0, 4, 8, 12]) {
    const lost = FIELDS.filter(([, v]) => typeof v !== 'string' || v.length < min).map(([n]) => n);
    console.log(
        '  minLength=' +
            String(min).padEnd(3) +
            ' protects ' +
            (FIELDS.length - lost.length) +
            '/8 fields' +
            (lost.length ? '   UNPROTECTED: ' + lost.join(', ') : ''),
    );
}

// ---------------------------------------------------------------------------
// The specific collisions, named
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.4c — the individual collisions, counted over the benign corpus ===');
console.log('');
const counts = new Map();
for (const leaf of BENIGN) {
    for (const s of SENSITIVE_VALUES) {
        if (leaf === s) counts.set(s, (counts.get(s) || 0) + 1);
    }
}
for (const s of SENSITIVE_VALUES) {
    const n = counts.get(s) || 0;
    console.log(
        '  sensitive value ' +
            JSON.stringify(s).padEnd(16) +
            ' collides with ' +
            String(n).padStart(3) +
            ' of ' +
            BENIGN.length +
            ' benign leaves  (' +
            ((100 * n) / BENIGN.length).toFixed(1) +
            '%)',
    );
}

module.exports = {rows};
