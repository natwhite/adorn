/**
 * SPIKE — cost measurement.
 *
 * Separates the two costs, because they scale completely differently:
 *   - program construction (parse + bind + type-check setup): dominated by file count and lib
 *   - the single-hop walk itself: dominated by call-expression count
 *
 * Reported per round, because the iterative design pays BOTH costs on EVERY round.
 *
 * NOT SHIPPED.
 */
'use strict';

const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const {analyzeProgram} = require('./core');

const REPO = path.join(__dirname, '..');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (['node_modules', 'dist', '.git', '.idea', 'spike', 'coverage'].includes(e.name)) continue;
            walk(p, out);
        } else if (e.name.endsWith('.ts')) {
            out.push(p);
        }
    }
    return out;
}

function countCalls(program, files) {
    const roots = new Set(files.map((f) => path.resolve(f).toLowerCase()));
    let calls = 0;
    let nodes = 0;
    for (const sf of program.getSourceFiles()) {
        if (!roots.has(path.resolve(sf.fileName).toLowerCase())) continue;
        const v = (n) => {
            nodes++;
            if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls++;
            ts.forEachChild(n, v);
        };
        v(sf);
    }
    return {calls, nodes};
}

function bench(label, files, options) {
    const t0 = process.hrtime.bigint();
    const program = ts.createProgram(files, options);
    program.getTypeChecker();
    const t1 = process.hrtime.bigint();
    const findings = analyzeProgram(program, files);
    const t2 = process.hrtime.bigint();

    const {calls, nodes} = countCalls(program, files);
    const buildMs = Number(t1 - t0) / 1e6;
    const walkMs = Number(t2 - t1) / 1e6;
    const loc = files.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0);

    console.log(`\n${label}`);
    console.log(`  root files       ${files.length}`);
    console.log(`  total LOC        ${loc}`);
    console.log(`  program files    ${program.getSourceFiles().length} (incl. lib.d.ts)`);
    console.log(`  call expressions ${calls}   AST nodes ${nodes}`);
    console.log(`  program build    ${buildMs.toFixed(0)} ms`);
    console.log(`  single-hop walk  ${walkMs.toFixed(1)} ms`);
    console.log(`  TOTAL PER ROUND  ${(buildMs + walkMs).toFixed(0)} ms`);
    console.log(`  per-call cost    ${((walkMs * 1000) / Math.max(calls, 1)).toFixed(1)} us`);
    console.log(`  findings         ${findings.length}`);
    return {buildMs, walkMs, calls, loc, files: files.length};
}

const OPTS = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: false,
    noEmit: true,
    lib: ['lib.es2019.d.ts', 'lib.dom.d.ts'],
    types: ['node', 'jest'],
};

const all = walk(REPO);
const src = all.filter((f) => f.includes(`${path.sep}src${path.sep}`) && !f.endsWith('.test.ts'));

console.log('=== cost on the adorn repo ===');
const a = bench('src/ only (no tests)', src, OPTS);
const b = bench('whole repo (src + test + examples + index)', all, OPTS);

// warm second run — the iterative design re-builds the program every round, so measure
// whether anything is amortised across rounds in a single process.
console.log('\n--- second run, same process (is anything warm?) ---');
const c = bench('whole repo, run 2', all, OPTS);

console.log('\n=== extrapolation ===');
const perKLoc = (b.buildMs + b.walkMs) / (b.loc / 1000);
console.log(`  measured: ${(b.buildMs + b.walkMs).toFixed(0)} ms for ${b.loc} LOC`);
console.log(`  => ${perKLoc.toFixed(1)} ms per 1k LOC per round (this repo, small-program regime)`);
console.log(`  NOTE: program build is superlinear in cross-file type resolution; treat the`);
console.log(`  per-kLOC figure as a floor, not a projection. See the doc.`);
void a;
void c;
