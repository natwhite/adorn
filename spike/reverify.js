/**
 * SPIKE (re-evaluation) — questions 3, 4 and 5 under the NARROWED threat model.
 *
 * NOT SHIPPED. See docs/sensitive-flow-spike.md §14.
 *
 *   Q3  Re-partition the 25 blind spots: OUT OF SCOPE (the value reaches a non-adorn sink)
 *       versus STILL A GENUINE MISS (it reaches an adorn sink invisibly).
 *   Q4  Does the false-positive rate improve when annotations only land where they affect an
 *       adorn emitter?
 *   Q5  How large is the population of real leaks the narrowing DECLARES out of scope? That is
 *       the false-confidence surface, and it should be counted rather than asserted.
 *
 * Usage: node spike/reverify.js
 */
'use strict';

const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const {analyzeSinkAware, planSinkFixes, classifySink} = require('./sinks');
const {applyFixes} = require('./core');
const {build, makeWorkTree} = require('./run');

function enclosingFunctionName(sf, line) {
    let best = null;
    const visit = (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
            const a = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
            const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
            if (line >= a && line <= b) best = n.name.text;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return best;
}

/** Read the `SCOPE-IN` / `SCOPE-OUT` ground truth out of the fixture's own comments. */
function readScopeTruth(file) {
    const text = fs.readFileSync(file, 'utf8');
    const truth = new Map();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\/\*\s*(SCOPE-IN|SCOPE-OUT)\s+(\w+)/);
        if (m) truth.set(m[2], m[1]);
    }
    return truth;
}

/* ================================================================== *
 * Q3 — re-partitioned blind spots                                     *
 * ================================================================== */

function q3() {
    console.log('='.repeat(96));
    console.log('Q3  BLIND SPOTS RE-PARTITIONED under the narrowed threat model');
    console.log('='.repeat(96));

    const work = makeWorkTree();
    const files = ['blindspots-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));
    const program = build(files);
    const sf = program.getSourceFile(files[0]);
    const truth = readScopeTruth(files[0]);

    // ONE round, first contact — and additionally a propagated run, so the number is not an
    // artifact of refusing to iterate.
    const direct = analyzeSinkAware(program, files, {mode: 'direct'});

    // propagated: iterate to a fixpoint in jsdoc mode (decorator mode cannot annotate the free
    // functions in between), then re-read which cases produced a leak at any point.
    const workP = makeWorkTree();
    const filesP = ['blindspots-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(workP, n));
    const leakingFunctionsPropagated = new Set();
    for (let r = 0; r < 15; r++) {
        const p = build(filesP);
        const f = analyzeSinkAware(p, filesP, {mode: 'propagate'});
        const spf = p.getSourceFile(filesP[0]);
        for (const finding of f) {
            if (finding.type !== 'leak') continue;
            const fn = enclosingFunctionName(spf, Number(finding.site.split(':')[1]));
            if (fn) leakingFunctionsPropagated.add(fn);
        }
        const {edits} = planSinkFixes(f, 'jsdoc');
        if (edits.reduce((n, e) => n + e.positions.length, 0) === 0) break;
        applyFixes(edits, fs, 'jsdoc');
    }

    const seenDirect = new Set();
    for (const f of direct) {
        if (f.type !== 'leak' && f.type !== 'leak-covered') continue;
        const fn = enclosingFunctionName(sf, Number(f.site.split(':')[1]));
        if (fn) seenDirect.add(fn);
    }

    const CASES = [
        'bs0_control', 'bs1_localVar', 'bs2_any', 'bs3_dynamic', 'bs4_jsonBoundary',
        'bs5_callback', 'bs5_hof', 'bs5_install', 'bs6_destructure', 'bs6_paramDestructure',
        'bs7_objectSpread', 'bs7_argSpread', 'bs8_template', 'bs8_direct', 'bs9_assign',
        'bs10_caller', 'bs11_transform', 'bs12_wrapped', 'bs13_rest', 'bs14_fieldWrite',
        'bs15_cast', 'bs16_directSink', 'bs17_iface', 'bs18_indexSig', 'bs19_optional',
    ];

    let outOfScope = 0;
    let inScopeSeen = 0;
    let inScopeMissed = 0;
    const missed = [];
    const rescuedByPropagation = [];

    const w = Math.max(...CASES.map((c) => c.length));
    console.log('\n' + 'case'.padEnd(w + 2) + 'scope'.padEnd(12) + 'one-pass'.padEnd(16) + 'with propagation');
    console.log('-'.repeat(96));

    for (const c of CASES) {
        const scope = truth.get(c) || 'SCOPE-IN';
        const seen = seenDirect.has(c);
        const seenP = leakingFunctionsPropagated.has(c);
        if (scope === 'SCOPE-OUT') {
            outOfScope++;
            console.log(c.padEnd(w + 2) + 'OUT'.padEnd(12) + 'n/a'.padEnd(16) + 'n/a');
            continue;
        }
        if (seen || seenP) {
            inScopeSeen++;
            if (!seen && seenP) rescuedByPropagation.push(c);
        } else {
            inScopeMissed++;
            missed.push(c);
        }
        console.log(
            c.padEnd(w + 2) +
                'IN'.padEnd(12) +
                (seen ? 'SEEN' : 'SILENT MISS').padEnd(16) +
                (seenP ? 'SEEN' : 'SILENT MISS')
        );
    }

    console.log('-'.repeat(96));
    console.log(`\n  total cases                                  ${CASES.length}`);
    console.log(`  OUT OF SCOPE under the narrowed model        ${outOfScope}`);
    console.log(`  IN SCOPE                                     ${CASES.length - outOfScope}`);
    console.log(`    of which SEEN                              ${inScopeSeen}`);
    console.log(`    of which STILL A GENUINE SILENT MISS       ${inScopeMissed}`);
    console.log(
        `\n  >>> genuine-miss rate: ${inScopeMissed}/${CASES.length - outOfScope} of in-scope cases ` +
            `(${((inScopeMissed / (CASES.length - outOfScope)) * 100).toFixed(0)}%)   ` +
            `${inScopeMissed}/${CASES.length} of the original inventory ` +
            `(${((inScopeMissed / CASES.length) * 100).toFixed(0)}%)`
    );
    console.log(`  still missed: ${missed.join(', ')}`);
    console.log(`  rescued only by propagation: ${rescuedByPropagation.length ? rescuedByPropagation.join(', ') : '(none)'}`);
    console.log(`  worktree: ${work}\n`);

    return {total: CASES.length, outOfScope, inScopeSeen, inScopeMissed, missed};
}

/* ================================================================== *
 * Q4 / Q5 — false positives, and the out-of-scope population          *
 * ================================================================== */

function readTruth(file) {
    const text = fs.readFileSync(file, 'utf8');
    const truth = new Map();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\/\*\s*(ADORN-SINK|REACHES|INERT|ESCAPES)/);
        if (!m) continue;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const fm = lines[j].match(/export function (\w+)/) || lines[j].match(/^\s*(\w+)\s*\(/);
            if (fm) {
                truth.set(fm[1], m[1]);
                break;
            }
        }
    }
    // in-class ADORN-SINK tags are on the line above the decorator or the method
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2019, true);
    const visit = (n) => {
        if (ts.isMethodDeclaration(n) && n.name) {
            for (const p of n.parameters) {
                if (classifySink(p).sink) truth.set(n.name.getText(), 'ADORN-SINK');
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return truth;
}

function countAnnotations(file) {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2019, true);
    const marked = [];
    const visit = (n) => {
        if (ts.isParameter(n)) {
            const lead = sf.text.slice(n.getFullStart(), n.getStart());
            const deco = (ts.getDecorators(n) || []).some((d) => d.getText().includes('Sensitive'));
            if (lead.includes('@sensitive') || deco) {
                const fn = n.parent;
                const fnName = fn && fn.name ? fn.name.getText() : '<anon>';
                marked.push({fn: fnName, param: n.name.getText(), isSink: classifySink(n).sink});
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return marked;
}

function q4(mode) {
    console.log('='.repeat(96));
    console.log(`Q4  FALSE-POSITIVE RATE  [design: ${mode === 'direct' ? 'ONE PASS, no propagation' : 'PROPAGATE to fixpoint'}]`);
    console.log('='.repeat(96));

    const work = makeWorkTree();
    const files = ['realistic-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));
    const writeMode = mode === 'direct' ? 'decorator' : 'jsdoc';

    for (let r = 0; r < 15; r++) {
        const program = build(files);
        const findings = analyzeSinkAware(program, files, {mode});
        const {edits} = planSinkFixes(findings, writeMode);
        if (edits.reduce((n, e) => n + e.positions.length, 0) === 0) break;
        applyFixes(edits, fs, writeMode);
        if (mode === 'direct') break; // one pass, by definition
    }

    const truth = readTruth(files[0]);
    const marked = countAnnotations(files[0]);

    let loadBearing = 0;
    let bookkeeping = 0;
    let inert = 0;
    console.log('');
    for (const m of marked) {
        const t = m.isSink ? 'ADORN-SINK' : truth.get(m.fn) || 'UNKNOWN';
        if (m.isSink) loadBearing++;
        else if (t === 'REACHES') bookkeeping++;
        else inert++;
        console.log(`  ${(m.fn + '(' + m.param + ')').padEnd(34)}  ${t}`);
    }

    const total = Math.max(marked.length, 1);
    console.log(`\n  annotations written                    ${marked.length}`);
    console.log(`    LOAD-BEARING (on an adorn sink)      ${loadBearing}`);
    console.log(`    bookkeeping (reaches a sink, is not) ${bookkeeping}`);
    console.log(`    INERT (reaches no adorn emitter)     ${inert}`);
    console.log(
        `\n  >>> inert rate ${((inert / total) * 100).toFixed(0)}%   ` +
            `non-load-bearing rate ${(((bookkeeping + inert) / total) * 100).toFixed(0)}%`
    );

    // Compile check — the omission that produced seven TS1206s the first time round.
    const after = build(files);
    const diags = files.flatMap((f) => {
        const s = after.getSourceFile(f);
        return s ? [...after.getSyntacticDiagnostics(s), ...after.getSemanticDiagnostics(s)] : [];
    });
    console.log(`  FIXED TREE COMPILES: ${diags.length === 0 ? 'YES' : 'NO — ' + diags.length + ' diagnostics'}`);
    for (const d of diags.slice(0, 5)) {
        const s = d.file;
        const pos = s ? s.getLineAndCharacterOfPosition(d.start) : {line: 0, character: 0};
        console.log(`      ${s ? path.basename(s.fileName) : '?'}(${pos.line + 1}): TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    console.log(`  worktree: ${work}\n`);
    return {total: marked.length, loadBearing, bookkeeping, inert};
}

function q5() {
    console.log('='.repeat(96));
    console.log('Q5  THE OUT-OF-SCOPE POPULATION — what the narrowing declares not-adorn\'s-problem');
    console.log('='.repeat(96));

    const work = makeWorkTree();
    const files = ['realistic-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));
    const program = build(files);
    const findings = analyzeSinkAware(program, files, {mode: 'direct'});

    const oos = findings.filter((f) => f.type === 'out-of-scope');
    console.log(`\n  findings classified OUT OF SCOPE: ${oos.length}`);
    for (const f of oos) {
        console.log(`      ${f.site}  ${f.source} -> [${f.calleeText}]   reason=${f.reason}`);
    }

    // How many of those are genuine leaks (tagged ESCAPES in the fixture)?
    const text = fs.readFileSync(files[0], 'utf8');
    const escapes = (text.match(/^\/\*\s*ESCAPES/gm) || []).length;
    console.log(`\n  of which tagged ESCAPES (a REAL leak the narrowed model will never report): ${escapes}`);
    console.log('  A developer who reads a clean report and concludes "no PII reaches a log" is wrong');
    console.log('  by exactly this population. The report must state its own scope, not its cleanliness.');
    console.log(`  worktree: ${work}\n`);
    return {outOfScope: oos.length, escapes};
}

if (require.main === module) {
    const a = q3();
    const b = q4('direct');
    const c = q4('propagate');
    const d = q5();
    console.log('='.repeat(96));
    console.log('SUMMARY');
    console.log('='.repeat(96));
    console.log(`  Q3 blind spots: ${a.outOfScope}/${a.total} out of scope, ${a.inScopeMissed}/${a.total - a.outOfScope} in-scope cases STILL silently missed`);
    console.log(`  Q4 one-pass:    ${b.total} annotations, ${b.loadBearing} load-bearing, ${b.inert} inert (${((b.inert / Math.max(b.total, 1)) * 100).toFixed(0)}%)`);
    console.log(`  Q4 propagated:  ${c.total} annotations, ${c.loadBearing} load-bearing, ${c.inert} inert (${((c.inert / Math.max(c.total, 1)) * 100).toFixed(0)}%)`);
    console.log(`  Q5 out-of-scope findings: ${d.outOfScope}, real leaks permanently unreported: ${d.escapes}`);
}

module.exports = {q3, q4, q5};
