/**
 * SPIKE (re-evaluation) — questions 1 and 2 under the NARROWED threat model.
 *
 * NOT SHIPPED. See docs/sensitive-flow-spike.md §14.
 *
 *   Q1  Does the fixpoint carry signal once propagation terminates AT a known sink?
 *   Q2  Is chain propagation necessary at all, or does the design collapse to a single
 *       report-at-the-sink pass — and is TS1206 therefore moot?
 *
 * Usage: node spike/reeval.js
 */
'use strict';

const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const {analyzeSinkAware, planSinkFixes, classifySink} = require('./sinks');
const {applyFixes} = require('./core');
const {build, makeWorkTree} = require('./run');

function line(char) {
    console.log((char || '-').repeat(78));
}

function diagnosticsFor(program, files) {
    return files.flatMap((f) => {
        const sf = program.getSourceFile(f);
        return sf ? [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)] : [];
    });
}

function printDiags(diags) {
    if (diags.length === 0) {
        console.log('  FIXED TREE COMPILES: YES');
        return;
    }
    console.log(`  FIXED TREE COMPILES: NO — ${diags.length} diagnostics`);
    for (const d of diags.slice(0, 8)) {
        const sf = d.file;
        const pos = sf ? sf.getLineAndCharacterOfPosition(d.start) : {line: 0, character: 0};
        console.log(
            `      ${sf ? path.basename(sf.fileName) : '?'}(${pos.line + 1},${pos.character + 1}): ` +
                `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
        );
    }
}

/* ================================================================== *
 * Q1 — propagation that terminates at a sink                          *
 * ================================================================== */

function q1(fixMode) {
    line('=');
    console.log(`Q1  5-hop chain, SINK-AWARE propagation   [--fix mode: ${fixMode}]`);
    line('=');

    const work = makeWorkTree();
    const files = ['chain-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));

    let converged = false;
    let total = 0;
    const t0 = process.hrtime.bigint();
    const leakLog = [];

    for (let r = 1; r <= 25; r++) {
        const program = build(files);
        const findings = analyzeSinkAware(program, files, {mode: 'propagate'});
        const {edits, skipped} = planSinkFixes(findings, fixMode);
        const writable = edits.reduce((n, e) => n + e.positions.length, 0);

        const byType = {};
        for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;

        console.log(
            `  round ${String(r).padStart(2)}  findings=${String(findings.length).padStart(3)}` +
                `  written=${String(writable).padStart(3)}  unfixable=${String(skipped.length).padStart(3)}` +
                `   ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')}`
        );
        for (const f of findings) {
            if (f.type === 'out-of-scope') {
                console.log(`        [out-of-scope:${f.reason}] ${f.site}  ${f.source} -> [${f.calleeText}]`);
                continue;
            }
            const legal = f.decoratorLegal ? 'deco-LEGAL' : 'deco-ILLEGAL';
            const tag = f.type === 'leak' ? `LEAK via ${f.via} (${f.emitter})` : f.type;
            console.log(`        [${tag}] ${f.site}  ${f.source} -> ${f.target.label}  {${f.host}, ${legal}}`);
            if (f.type === 'leak') leakLog.push({round: r, ...f});
        }

        if (writable === 0) {
            converged = true;
            break;
        }
        total += applyFixes(edits, fs, fixMode);
    }
    const wall = Number(process.hrtime.bigint() - t0) / 1e6;

    const check = build(files);
    console.log(`\n  CONVERGED=${converged}  total-annotations=${total}  wall=${wall.toFixed(0)}ms`);
    printDiags(diagnosticsFor(check, files));

    console.log('\n  --- WHERE THE TERMINAL ANNOTATIONS LANDED ---');
    const sinkParams = [];
    const nonSinkParams = [];
    const sf = check.getSourceFile(files[0]);
    const walk = (n) => {
        if (ts.isParameter(n)) {
            const full = sf.text.slice(n.getFullStart(), n.getStart());
            const decorated = (ts.getDecorators(n) || []).some((d) => d.getText().includes('Sensitive'));
            if (full.includes('@sensitive') || decorated) {
                const s = classifySink(n);
                const label = `${n.parent && n.parent.name ? n.parent.name.getText() : '<anon>'}(${n.name.getText()})`;
                (s.sink ? sinkParams : nonSinkParams).push(s.sink ? `${label}  <- ADORN SINK via ${s.via}` : label);
            }
        }
        ts.forEachChild(n, walk);
    };
    walk(sf);
    console.log(`  on an ADORN SINK parameter (load-bearing for redaction): ${sinkParams.length}`);
    for (const s of sinkParams) console.log(`      ${s}`);
    console.log(`  on an intermediate NON-sink parameter (bookkeeping only): ${nonSinkParams.length}`);
    for (const s of nonSinkParams) console.log(`      ${s}`);

    console.log(`\n  LEAKS REPORTED (the signal): ${leakLog.length}`);
    for (const l of leakLog) console.log(`      round ${l.round}: ${l.source} -> ${l.target.label} via ${l.via}`);
    console.log(`  worktree: ${work}\n`);
    return {converged, total, leaks: leakLog.length, sinkParams: sinkParams.length, nonSinkParams: nonSinkParams.length};
}

/* ================================================================== *
 * Q2 — is propagation necessary at all?                               *
 * ================================================================== */

function q2() {
    line('=');
    console.log('Q2  ONE PASS, NO ITERATION — direct source -> adorn-sink detection');
    line('=');

    const work = makeWorkTree();
    const files = ['chain-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));
    const program = build(files);
    const findings = analyzeSinkAware(program, files, {mode: 'direct'});

    const leaks = findings.filter((f) => f.type === 'leak');
    const covered = findings.filter((f) => f.type === 'leak-covered');
    const oos = findings.filter((f) => f.type === 'out-of-scope');

    console.log(`  leaks reported          ${leaks.length}`);
    for (const f of leaks) {
        console.log(
            `      ${f.site}  ${f.source} -> ${f.target.label}  via ${f.via}  {${f.host}, ` +
                `${f.decoratorLegal ? 'deco-LEGAL' : 'deco-ILLEGAL'}}`
        );
    }
    console.log(`  already covered         ${covered.length}`);
    console.log(`  out of scope (narrowed) ${oos.length}`);

    console.log('\n  --- THE CRUX: is the annotation target always decorator-legal? ---');
    const illegal = leaks.filter((f) => !f.decoratorLegal);
    console.log(`  leak targets total: ${leaks.length}   decorator-ILLEGAL: ${illegal.length}`);
    for (const f of illegal) console.log(`      ILLEGAL: ${f.target.label} host=${f.host}`);

    // Now actually WRITE the decorator at every leak target and compile it. This is the test the
    // original spike omitted and which is how it reported convergence over seven TS1206s.
    console.log('\n  --- writing @Sensitive() at every leak target, in DECORATOR mode ---');
    const {edits, skipped} = planSinkFixes(findings, 'decorator');
    const writable = edits.reduce((n, e) => n + e.positions.length, 0);
    console.log(`  annotations writable: ${writable}   skipped-as-illegal: ${skipped.length}`);
    for (const s of skipped) console.log(`      skipped: ${s.target.label} — ${s.why}`);
    applyFixes(edits, fs, 'decorator');

    const after = build(files);
    printDiags(diagnosticsFor(after, files));

    // Re-run: is the leak now covered, and does a second pass find anything new?
    const findings2 = analyzeSinkAware(after, files, {mode: 'direct'});
    const leaks2 = findings2.filter((f) => f.type === 'leak');
    const covered2 = findings2.filter((f) => f.type === 'leak-covered');
    console.log(`\n  SECOND PASS after annotating: leaks=${leaks2.length}  covered=${covered2.length}`);
    console.log(`  => a single report-annotate-confirm cycle ${leaks2.length === 0 ? 'CLOSES' : 'does NOT close'} the direct case`);
    console.log(`  worktree: ${work}\n`);

    return {leaks: leaks.length, illegal: illegal.length, writable, skipped: skipped.length, leaksAfter: leaks2.length};
}

if (require.main === module) {
    const a = q1('decorator');
    const b = q1('jsdoc');
    const c = q2();
    line('=');
    console.log('SUMMARY');
    line('=');
    console.log(`  Q1 decorator-mode: converged=${a.converged} annotations=${a.total} leaks-reported=${a.leaks}`);
    console.log(`  Q1 jsdoc-mode:     converged=${b.converged} annotations=${b.total} leaks-reported=${b.leaks}`);
    console.log(`     terminal annotations on a SINK parameter: ${b.sinkParams}; on an intermediate: ${b.nonSinkParams}`);
    console.log(`  Q2 one-pass:       leaks=${c.leaks} decorator-illegal=${c.illegal} writable=${c.writable} leaks-after=${c.leaksAfter}`);
}

module.exports = {q1, q2};
