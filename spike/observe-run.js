/**
 * SPIKE (third pass) — Question A.1: does runtime observation actually catch the 17?
 *
 * Runs every shape from `spike/fixtures/blindspots-sink.ts` (transcribed in observe-fixtures.js)
 * against the runtime prototype and checks the EMITTED TEXT for the secret.
 *
 * A case is CAUGHT when the sensitive value does not appear in what the emitter rendered.
 * A case is MISSED when the emitter printed the secret.
 *
 * Run:  node spike/observe-run.js
 */

'use strict';

const {withScope, emissions, resetEmissions} = require('./observe');
const {Subject, CASES, SSN} = require('./observe-fixtures');

function runCase(c, policy) {
    resetEmissions();
    const s = new Subject();
    withScope(policy, () => c.run(s));

    const printed = emissions.map(e => e.rendered.join(' | ')).join(' || ');
    const emitted = emissions.length > 0;

    // did the whole secret escape?
    const leakedWhole = printed.indexOf(SSN) !== -1;
    // bs11 only ever hands over a derived fragment
    const leakedDerived = printed.indexOf(SSN.slice(-4)) !== -1;

    return {printed, emitted, leakedWhole, leakedDerived};
}

function report(title, policy) {
    console.log('');
    console.log('=== ' + title + ' ===');
    console.log(
        '    policy: minLength=' +
            policy.minLength +
            ' primitives=' +
            policy.primitives +
            " match='" +
            policy.match +
            "'",
    );
    console.log('');

    let inScope = 0;
    let caught = 0;
    let missed = 0;
    const missedIds = [];
    const rescued = [];

    for (const c of CASES) {
        const r = runCase(c, policy);
        if (c.scope !== 'IN') continue;
        inScope++;

        const leaked = c.secretShape === 'derived' ? r.leakedDerived : r.leakedWhole;
        const verdict = !r.emitted ? 'NO-EMIT' : leaked ? 'MISS' : 'CAUGHT';

        if (verdict === 'CAUGHT') {
            caught++;
            if (!c.staticSeen) rescued.push(c.id);
        } else {
            missed++;
            missedIds.push(c.id);
        }

        console.log(
            '  ' +
                c.id.padEnd(22) +
                ' static=' +
                (c.staticSeen ? 'SEEN ' : 'MISS ') +
                ' runtime=' +
                verdict.padEnd(8) +
                ' emitted: ' +
                r.printed.slice(0, 60),
        );
    }

    console.log('');
    console.log('  in-scope cases        ' + inScope);
    console.log('  runtime CAUGHT        ' + caught);
    console.log('  runtime MISSED        ' + missed + (missedIds.length ? '  -> ' + missedIds.join(', ') : ''));
    console.log('  of the 17 static blind spots, rescued at runtime: ' + rescued.length);
    return {inScope, caught, missed, missedIds, rescued};
}

const base = {minLength: 0, primitives: true, match: 'exact', cap: Infinity};

const exact = report('A.1 — exact value membership', base);
const sub = report('A.1b — substring matching', Object.assign({}, base, {match: 'substring'}));
const guarded = report(
    'A.1c — exact, strings of length >= 8 only (collision guard)',
    Object.assign({}, base, {minLength: 8, primitives: false}),
);

console.log('');
console.log('=== SUMMARY ===');
console.log('  exact        caught ' + exact.caught + '/' + exact.inScope + '  rescued ' + exact.rescued.length + '/17');
console.log('  substring    caught ' + sub.caught + '/' + sub.inScope + '  rescued ' + sub.rescued.length + '/17');
console.log(
    '  len>=8 exact  caught ' + guarded.caught + '/' + guarded.inScope + '  rescued ' + guarded.rescued.length + '/17',
);
