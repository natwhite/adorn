/**
 * SPIKE — re-run behaviour, which brief question 7 asks about directly.
 *
 *   1. does a converged tree produce zero edits on re-run?  (no churn)
 *   2. what happens to a parameter that is ALREADY annotated, differently?
 *   3. what happens to a parameter annotated by hand in the *other* notation?
 *
 * NOT SHIPPED.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('typescript');
const {analyzeProgram, planFixes, applyFixes} = require('./core');
const {build} = require('./run');

function scratch(name, src) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorn-spike-idem-'));
    fs.writeFileSync(path.join(dir, 'marker.ts'), fs.readFileSync(path.join(__dirname, 'fixtures', 'marker.ts')));
    const f = path.join(dir, name);
    fs.writeFileSync(f, src);
    return {dir, files: [f, path.join(dir, 'marker.ts')]};
}

function rounds(files, mode, cap) {
    const log = [];
    for (let r = 0; r < (cap || 12); r++) {
        const program = build(files);
        const findings = analyzeProgram(program, files);
        const {edits} = planFixes(findings, mode);
        const n = edits.reduce((a, e) => a + e.positions.length, 0);
        log.push(n);
        if (n === 0) break;
        applyFixes(edits, fs, mode);
    }
    return log;
}

/* ---------------------------------------------------------------- */
console.log('=== 1. no churn on a converged tree ===');
{
    const src = `import {Sensitive} from './marker';
export class C { @Sensitive() ssn: string = ''; }
export function a(v: string): void { b(v); }
export function b(w: string): void { console.log(w); }
export function entry(c: C): void { a(c.ssn); }
`;
    const {files} = scratch('t1.ts', src);
    const first = rounds(files, 'jsdoc');
    const second = rounds(files, 'jsdoc');
    const third = rounds(files, 'jsdoc');
    console.log(`  edits per round, run 1: [${first.join(', ')}]`);
    console.log(`  edits per round, run 2: [${second.join(', ')}]   <- must be [0]`);
    console.log(`  edits per round, run 3: [${third.join(', ')}]   <- must be [0]`);
    const txt = fs.readFileSync(files[0], 'utf8');
    const dupes = (txt.match(/@sensitive/g) || []).length;
    console.log(`  total @sensitive tags in file: ${dupes} (expect 2 — a(v) and b(w))`);
    console.log(`  IDEMPOTENT: ${second.join() === '0' && third.join() === '0' && dupes === 2}\n`);
}

/* ---------------------------------------------------------------- */
console.log('=== 2. a parameter already annotated DIFFERENTLY ===');
{
    const src = `import {Sensitive} from './marker';
export class C { @Sensitive() ssn: string = ''; }
export class Svc {
    // already annotated with a stricter marking than the tool would write
    take(@Sensitive({never: true}) v: string): void { console.log(v); }
    // annotated with something else entirely
    also(/** @internal */ w: string): void { console.log(w); }
}
export function entry(c: C, s: Svc): void { s.take(c.ssn); s.also(c.ssn); }
`;
    const {files} = scratch('t2.ts', src);
    const program = build(files);
    const findings = analyzeProgram(program, files);
    console.log(`  findings: ${findings.length}`);
    for (const f of findings) {
        console.log(`    [${f.type}] ${f.site} ${f.source} -> ${f.target ? f.target.label : '?'}`);
    }
    console.log(
        `  -> the {never: true} parameter is correctly LEFT ALONE (isMarked ignores arguments),`
    );
    console.log(`     which also means the tool can never UPGRADE or reconcile a marking.\n`);
}

/* ---------------------------------------------------------------- */
console.log('=== 3. mixed notation: hand-written decorator, tool writes JSDoc ===');
{
    const src = `import {Sensitive} from './marker';
export class C { @Sensitive() ssn: string = ''; }
export class Svc { hop(@Sensitive() v: string): void { onward(v); } }
export function onward(w: string): void { console.log(w); }
export function entry(c: C, s: Svc): void { s.hop(c.ssn); }
`;
    const {files} = scratch('t3.ts', src);
    const log = rounds(files, 'jsdoc');
    const txt = fs.readFileSync(files[0], 'utf8');
    console.log(`  edits per round: [${log.join(', ')}]`);
    console.log(`  decorator markings: ${(txt.match(/@Sensitive\(/g) || []).length}`);
    console.log(`  jsdoc markings:     ${(txt.match(/@sensitive/g) || []).length}`);
    console.log(`  -> two notations now coexist in one file for the same concept.\n`);
}

/* ---------------------------------------------------------------- */
console.log('=== 4. does the fixed tree still compile? ===');
{
    const src = `import {Sensitive} from './marker';
export class C { @Sensitive() ssn: string = ''; }
export interface I { m(v: string): void; }
export type Fn = (v: string) => void;
export function entry(c: C, i: I, f: Fn): void { i.m(c.ssn); f(c.ssn); }
`;
    const {files} = scratch('t4.ts', src);
    const log = rounds(files, 'jsdoc');
    const p = build(files);
    const sf = p.getSourceFile(files[0]);
    const diags = [...p.getSyntacticDiagnostics(sf), ...p.getSemanticDiagnostics(sf)];
    console.log(`  edits per round: [${log.join(', ')}]`);
    console.log(`  diagnostics after fix: ${diags.length}`);
    for (const d of diags.slice(0, 4)) {
        console.log(`    TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    console.log(`  fixed source:\n${fs.readFileSync(files[0], 'utf8').split('\n').map((l) => '    ' + l).join('\n')}`);
}
