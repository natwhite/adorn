/**
 * SPIKE (third pass) — Question A.6 (cost) and the scaling behaviour of A.2/A.5.
 *
 * Measures:
 *   - per-field-read overhead: plain data property vs adorn accessor vs accessor + record
 *   - per-emit overhead: no store vs exact membership vs substring, at set sizes 1 .. 1000
 *   - false-positive rate as a function of observed-set size (the correlation problem's real
 *     shape: reads vastly outnumber emissions, so the set only ever grows within a scope)
 *
 * Run:  node spike/observe-bench.js
 */

'use strict';

const {Sensitive, decorateField, withScope, currentStore, renderRedacted, makeStore, CENSOR} = require('./observe');

function bench(label, iterations, fn) {
    fn(); // warm
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn();
    const t1 = process.hrtime.bigint();
    const ns = Number(t1 - t0) / iterations;
    return {label, ns};
}

// ---------------------------------------------------------------------------
// A.6a — the read path
// ---------------------------------------------------------------------------

class Plain {
    constructor() {
        this.ssn = '123-45-6789';
    }
}

class Accessor {
    constructor() {
        this.ssn = '123-45-6789';
    }
}
decorateField(Accessor.prototype, 'ssn', Sensitive());

const plain = new Plain();
const acc = new Accessor();

let sinkVar;

const readRows = [];
readRows.push(bench('plain data property read', 2e6, () => {
    sinkVar = plain.ssn;
}));

// accessor with NO scope open -> record() short-circuits on currentStore()
readRows.push(bench('adorn accessor read, no scope', 2e6, () => {
    sinkVar = acc.ssn;
}));

// accessor inside a scope -> record() runs the eligibility check and the Set.has
const POLICY = {minLength: 0, primitives: false, match: 'exact', cap: Infinity};
withScope(POLICY, () => {
    readRows.push(bench('adorn accessor read, scope open (value already recorded)', 2e6, () => {
        sinkVar = acc.ssn;
    }));
});

// worst case: every read returns a NEW value, so every read grows the Set.
// Values are pre-allocated so the figure is not inflated by string concatenation, and the
// paired setter call is measured separately below so it can be subtracted.
const FRESH = [];
for (let i = 0; i < 5e5; i++) FRESH.push('fresh-value-' + i);

{
    let n = 0;
    const setterOnly = bench('  (control) accessor WRITE only, no scope', 5e5, () => {
        acc.ssn = FRESH[n++ % FRESH.length];
    });

    n = 0;
    withScope(POLICY, () => {
        readRows.push(
            bench('adorn accessor write+read, scope open, NEW value each time', 5e5, () => {
                acc.ssn = FRESH[n++ % FRESH.length];
                sinkVar = acc.ssn;
            }),
        );
    });
    readRows.push(setterOnly);
}

console.log('');
console.log('=== A.6a — per-field-read cost ===');
console.log('');
const baseRead = readRows[0].ns;
for (const r of readRows) {
    console.log(
        '  ' + r.label.padEnd(56) + r.ns.toFixed(1).padStart(8) + ' ns   ' + (r.ns / baseRead).toFixed(1) + 'x baseline',
    );
}

// ---------------------------------------------------------------------------
// A.6b — the emit path
// ---------------------------------------------------------------------------

function storeWith(nValues, policy) {
    const s = makeStore(policy);
    for (let i = 0; i < nValues; i++) {
        const v = 'secret-value-' + String(i).padStart(6, '0');
        s.observed.add(v);
        s.order.push(v);
    }
    return s;
}

const PAYLOAD = {
    orderId: 'ord_88213',
    status: 'captured',
    amount: 4200,
    currency: 'USD',
    customer: {id: 'cus_0002', region: 'US', vip: true},
    message: 'payment captured for order ord_88213 in region US',
};

console.log('');
console.log('=== A.6b — per-emit cost (one realistic payload, 12 leaves) ===');
console.log('');
console.log('  observed-set size     no store      exact        substring     substring/exact');
console.log('  ' + '-'.repeat(76));

const emitRows = [];
for (const n of [0, 1, 10, 100, 1000]) {
    const stats = () => ({leaves: 0, redacted: 0, comparisons: 0});

    const none = bench('none', 2e5, () => renderRedacted(PAYLOAD, null, stats()));
    const exactStore = storeWith(n, {minLength: 0, primitives: false, match: 'exact', cap: Infinity});
    const ex = bench('exact', 2e5, () => renderRedacted(PAYLOAD, exactStore, stats()));
    const subStore = storeWith(n, {minLength: 0, primitives: false, match: 'substring', cap: Infinity});
    const iters = n >= 1000 ? 2e3 : n >= 100 ? 2e4 : 1e5;
    const sub = bench('substring', iters, () => renderRedacted(PAYLOAD, subStore, stats()));

    emitRows.push({n, none: none.ns, ex: ex.ns, sub: sub.ns});
    console.log(
        '  ' +
            String(n).padEnd(22) +
            none.ns.toFixed(0).padStart(6) +
            ' ns' +
            ex.ns.toFixed(0).padStart(11) +
            ' ns' +
            sub.ns.toFixed(0).padStart(13) +
            ' ns' +
            (sub.ns / ex.ns).toFixed(1).padStart(14) +
            'x',
    );
}

// ---------------------------------------------------------------------------
// A.2b — false positives as the observed set grows
//
// This is the correlation problem's real shape. A read is not an emission, but every read arms
// the set for the remainder of the scope. A request that reads 100 records has a set of ~800
// values against which every subsequent emission is matched.
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.2b — false-positive rate vs. observed-set size ===');
console.log('');

const BENIGN_LEAVES = [];
{
    const pools = [
        [true, false],
        [0, 1, 2, 3, 200, 404, 500],
        ['ok', 'A', 'B', 'US', 'GB', 'EUR', 'USD', 'GET', 'POST'],
        ['ord_88213', 'req_ab12cd34', 'txn_99f0'],
        ['payment captured', 'retry scheduled', 'cache miss'],
        ['2024-01-15', '2026-07-20', '1981-04-02'],
        [''],
    ];
    let seed = 0x9e3779b9;
    const rnd = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
        const pool = pools[Math.floor(rnd() * pools.length)];
        BENIGN_LEAVES.push(pool[Math.floor(rnd() * pool.length)]);
    }
}

/**
 * Simulate reading `records` customer records. Each record contributes a unique long value (an
 * SSN) plus the SAME short/primitive values every record has — which is the realistic shape:
 * long identifiers are unique per subject, booleans and enums are not.
 */
function simulatedStore(records, policy) {
    const s = makeStore(policy);
    const add = v => {
        const t = typeof v;
        const ok = t === 'string' ? v.length >= policy.minLength : policy.primitives;
        if (!ok) return;
        if (!s.observed.has(v)) {
            s.observed.add(v);
            s.order.push(v);
        }
    };
    for (let i = 0; i < records; i++) {
        add('9' + String(i).padStart(2, '0') + '-45-6789'); // unique per record
        add('1981-04-02'); // a DOB, date-shaped
        add('US'); // countryCode
        add('A'); // tier
        add(''); // empty middle name
        add(true); // consent flag
        add(0); // failed logins
    }
    return s;
}

for (const policy of [
    {label: 'record everything', minLength: 0, primitives: true, match: 'exact', cap: Infinity},
    {label: 'strings only, minLen 8', minLength: 8, primitives: false, match: 'exact', cap: Infinity},
]) {
    console.log('  policy: ' + policy.label);
    for (const records of [1, 10, 100, 1000]) {
        const store = simulatedStore(records, policy);
        let fp = 0;
        for (const leaf of BENIGN_LEAVES) {
            const st = {leaves: 0, redacted: 0, comparisons: 0};
            const out = renderRedacted(leaf, store, st);
            if (out.indexOf(CENSOR) !== -1) fp++;
        }
        console.log(
            '    records read ' +
                String(records).padStart(5) +
                '   set size ' +
                String(store.observed.size).padStart(5) +
                '   false positives ' +
                String(fp).padStart(4) +
                '/500  (' +
                ((100 * fp) / 500).toFixed(1) +
                '%)',
        );
    }
    console.log('');
}

// ---------------------------------------------------------------------------
// A.2c — WHICH sensitive value drives the residual false positives?
//
// The point of a length guard is to remove short colliding values. What survives it is the
// finding: a date of birth is a sensitive value shaped exactly like an ordinary timestamp, so
// no length threshold can separate them.
// ---------------------------------------------------------------------------

console.log('=== A.2c — residual false positives at minLen 8, attributed ===');
console.log('');
{
    const policy = {minLength: 8, primitives: false, match: 'exact', cap: Infinity};
    const store = simulatedStore(100, policy);
    const attribution = new Map();
    for (const leaf of BENIGN_LEAVES) {
        if (typeof leaf === 'string' && store.observed.has(leaf)) {
            attribution.set(leaf, (attribution.get(leaf) || 0) + 1);
        }
    }
    let total = 0;
    for (const [v, n] of attribution) {
        total += n;
        console.log(
            '  ' + JSON.stringify(v).padEnd(16) + String(n).padStart(4) + ' of 500 benign leaves wrongly redacted',
        );
    }
    console.log('  ' + '-'.repeat(60));
    console.log('  total ' + total + '/500 — every one of them a DATE, which a length guard cannot exclude');
}

// ---------------------------------------------------------------------------
// A.6c — memory: the observed set IS a plaintext index of sensitive values
// ---------------------------------------------------------------------------

console.log('=== A.6c — what the scope retains ===');
console.log('');
for (const records of [1, 100, 10000]) {
    const store = simulatedStore(records, {minLength: 0, primitives: true, match: 'exact', cap: Infinity});
    let bytes = 0;
    for (const v of store.observed) bytes += typeof v === 'string' ? v.length * 2 + 16 : 8;
    console.log(
        '  ' +
            String(records).padStart(6) +
            ' records read -> ' +
            String(store.observed.size).padStart(6) +
            ' values retained, ~' +
            (bytes / 1024).toFixed(1) +
            ' KiB of PLAINTEXT sensitive values held for the scope lifetime',
    );
}
