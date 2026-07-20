/**
 * SPIKE — the two numbers that decide the design.
 *
 *   A. BLIND SPOTS.  Every `bs*` function in blindspots.ts genuinely leaks. Which does the
 *      analyser see, and does a miss fail loudly or SILENTLY?
 *   B. FALSE POSITIVES. In realistic.ts every receiving parameter is tagged REACHES-SINK or
 *      INERT in a comment. How many of the annotations the tool writes are INERT?
 *
 * NOT SHIPPED.
 */
'use strict';

const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const {analyzeProgram, planFixes, applyFixes} = require('./core');
const {build, makeWorkTree} = require('./run');

/* ------------------------------------------------------------------ *
 * A. blind spots                                                      *
 * ------------------------------------------------------------------ */

/** ground truth: every case, what it exercises, and whether it truly leaks (all do). */
const CASES = {
    bs0_control: 'CONTROL — marked field passed directly',
    bs1_localVar: 'local variable assignment',
    bs2_any: '`any`-typed holder',
    bs3_dynamic: 'dynamic property access s[key]',
    bs4_jsonBoundary: 'JSON.stringify/parse round trip (with `as` cast)',
    bs5_callback: 'array literal + .forEach callback',
    bs5_hof: 'higher-order function parameter',
    bs5_install: 'callback passed into a HOF',
    bs6_destructure: 'destructuring in a body',
    bs6_paramDestructure: 'destructuring in the parameter list',
    bs7_objectSpread: 'object spread {...s}',
    bs7_argSpread: 'argument spread f(...args)',
    bs8_template: 'template-literal interpolation',
    bs8_direct: 'template literal straight into console.log',
    bs9_assign: 'Object.assign copy',
    bs10_caller: 'value returned from a function',
    bs11_transform: 'transformation (.slice)',
    bs12_wrapped: 'wrapped in an object literal',
    bs13_rest: 'passed into a rest parameter',
    bs14_fieldWrite: 'written to an unmarked class field',
    bs15_cast: '`as unknown as` cast',
    bs16_directSink: 'straight into console.log',
    bs17_iface: 'dispatched through an interface method',
    bs18_indexSig: 'index-signature bag',
    bs19_optional: 'optional chaining + ??',
};

function enclosingFunctionName(sf, line) {
    // walk the file, find the innermost function declaration containing this 1-based line
    let best = null;
    const visit = (n) => {
        if (
            (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
            n.name &&
            ts.isIdentifier(n.name)
        ) {
            const a = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
            const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
            if (line >= a && line <= b) best = n.name.text;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return best;
}

function blindSpots() {
    const work = makeWorkTree();
    const files = ['blindspots.ts', 'marker.ts'].map((n) => path.join(work, n));

    // ONE round only — we want first-contact visibility, not post-propagation.
    const program = build(files);
    const findings = analyzeProgram(program, files);
    const sf = program.getSourceFile(files[0]);

    const seenBy = new Map();
    for (const f of findings) {
        const line = Number(f.site.split(':')[1]);
        const fn = enclosingFunctionName(sf, line);
        if (!fn) continue;
        if (!seenBy.has(fn)) seenBy.set(fn, []);
        seenBy.get(fn).push(f.type);
    }

    console.log('=== A. BLIND-SPOT INVENTORY ===');
    console.log('   every case below genuinely leaks a @Sensitive value to console output\n');
    const w = Math.max(...Object.keys(CASES).map((k) => k.length));
    let detected = 0;
    let silent = 0;
    const silentList = [];
    for (const [fn, desc] of Object.entries(CASES)) {
        const hits = seenBy.get(fn);
        const verdict = hits ? `SEEN (${[...new Set(hits)].join(',')})` : 'SILENT MISS';
        if (hits) detected++;
        else {
            silent++;
            silentList.push(fn);
        }
        console.log(`  ${fn.padEnd(w)}  ${verdict.padEnd(26)}  ${desc}`);
    }
    console.log(
        `\n  detected ${detected}/${Object.keys(CASES).length}` +
            `   SILENTLY MISSED ${silent}/${Object.keys(CASES).length}` +
            `  (${((silent / Object.keys(CASES).length) * 100).toFixed(0)}%)`
    );
    console.log(`  silent: ${silentList.join(', ')}\n`);
    return {detected, silent, total: Object.keys(CASES).length};
}

/* ------------------------------------------------------------------ *
 * B. false positives                                                  *
 * ------------------------------------------------------------------ */

function falsePositives() {
    const work = makeWorkTree();
    const files = ['realistic.ts', 'marker.ts'].map((n) => path.join(work, n));

    for (let r = 0; r < 15; r++) {
        const program = build(files);
        const findings = analyzeProgram(program, files);
        const {edits} = planFixes(findings, 'jsdoc');
        if (edits.reduce((n, e) => n + e.positions.length, 0) === 0) break;
        applyFixes(edits, fs, 'jsdoc');
    }

    // read ground truth out of the source comments, then read back which params got marked
    const text = fs.readFileSync(files[0], 'utf8');
    const sf = ts.createSourceFile(files[0], text, ts.ScriptTarget.ES2019, /*setParentNodes*/ true);

    const truth = new Map(); // function name -> 'REACHES-SINK' | 'INERT'
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\/\*\s*(REACHES-SINK|INERT)/);
        if (!m) continue;
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const fm = lines[j].match(/export function (\w+)/);
            if (fm) {
                truth.set(fm[1], m[1]);
                break;
            }
        }
    }

    const marked = [];
    const visit = (n) => {
        if (ts.isFunctionDeclaration(n) && n.name) {
            for (const p of n.parameters) {
                const full = sf.text.slice(p.getFullStart(), p.getStart());
                if (full.includes('@sensitive')) {
                    marked.push({fn: n.name.text, param: p.name.getText()});
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);

    console.log('=== B. FALSE-POSITIVE / ANNOTATION-SPAM RATE (realistic.ts) ===\n');
    let reaching = 0;
    let inert = 0;
    for (const m of marked) {
        const t = truth.get(m.fn) || 'UNKNOWN';
        if (t === 'REACHES-SINK') reaching++;
        else if (t === 'INERT') inert++;
        console.log(`  ${(m.fn + '(' + m.param + ')').padEnd(32)}  ${t}`);
    }
    console.log(
        `\n  annotations written ${marked.length}` +
            `   reach a sink ${reaching}` +
            `   INERT ${inert}` +
            `   spam rate ${((inert / Math.max(marked.length, 1)) * 100).toFixed(0)}%`
    );
    console.log(`  worktree: ${work}\n`);
    return {total: marked.length, reaching, inert};
}

blindSpots();
falsePositives();
