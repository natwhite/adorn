/**
 * SPIKE — the iteration driver.
 *
 * Copies a fixture set into a scratch working tree, then runs analyse -> --fix -> analyse
 * until a round produces zero fixes (convergence) or a hard round cap trips (divergence).
 *
 * Usage:  node spike/run.js <fixture...> [--rounds N] [--keep] [--quiet]
 *
 * NOT SHIPPED.
 */
'use strict';

const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {analyzeProgram, planFixes, applyFixes} = require('./core');

const FIXTURES = path.join(__dirname, 'fixtures');

const COMPILER_OPTIONS = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: false,
    noEmit: true,
    lib: ['lib.es2019.d.ts', 'lib.dom.d.ts'],
};

function makeWorkTree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorn-spike-'));
    for (const f of fs.readdirSync(FIXTURES)) {
        fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
    }
    return dir;
}

function build(files) {
    return ts.createProgram(files, COMPILER_OPTIONS);
}

function run(fixtureNames, opts) {
    const work = makeWorkTree();
    const files = fixtureNames.map((n) => path.join(work, n));
    const mode = opts.mode || 'decorator';

    const rounds = [];
    const cap = opts.rounds || 25;
    let totalFixes = 0;
    let converged = false;

    const t0 = process.hrtime.bigint();
    for (let r = 1; r <= cap; r++) {
        const program = build(files);
        const findings = analyzeProgram(program, files);
        const {edits, skipped} = planFixes(findings, mode);
        const fixable = edits.reduce((n, e) => n + e.positions.length, 0);

        rounds.push({
            round: r,
            findings: findings.length,
            fixesApplied: fixable,
            skipped: skipped.length,
            detail: findings,
            skippedDetail: skipped,
        });

        if (fixable === 0) {
            converged = true;
            break;
        }
        totalFixes += applyFixes(edits, fs, mode);
    }
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // Does the fixed tree still compile? The single most important check, and the one the
    // first version of this spike omitted — which is how a "converged" run produced 7
    // TS1206s.
    const check = build(files);
    const diags = files.flatMap((f) => {
        const sf = check.getSourceFile(f);
        return sf
            ? [...check.getSyntacticDiagnostics(sf), ...check.getSemanticDiagnostics(sf)]
            : [];
    });

    return {work, rounds, converged, totalFixes, elapsedMs, files, mode, diags};
}

function summarize(name, result, opts) {
    console.log(`\n=== ${name}   [--fix mode: ${result.mode}] ===`);
    for (const r of result.rounds) {
        const byType = {};
        for (const f of r.detail) byType[f.type] = (byType[f.type] || 0) + 1;
        const types = Object.entries(byType)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        console.log(
            `  round ${String(r.round).padStart(2)}  findings=${String(r.findings).padStart(3)}` +
                `  written=${String(r.fixesApplied).padStart(3)}` +
                `  unfixable=${String(r.skipped).padStart(3)}   ${types}`
        );
        if (!opts.quiet) {
            for (const f of r.detail) {
                const tgt = f.target ? ` -> ${f.target.label}` : ` -> [${f.calleeText || '?'}]`;
                const h = f.host ? ` {${f.host}${f.decoratorLegal ? '' : ' DECO-ILLEGAL'}}` : '';
                console.log(`        [${f.type}] ${f.site}  ${f.source}${tgt}${h}`);
            }
        }
    }
    const last = result.rounds[result.rounds.length - 1];
    console.log(
        `  CONVERGED=${result.converged}  rounds-to-fixpoint=${result.rounds.length}` +
            `  total-annotations=${result.totalFixes}  wall=${result.elapsedMs.toFixed(0)}ms`
    );
    console.log(`  PERSISTENT UNFIXABLE FINDINGS AT FIXPOINT: ${last ? last.skipped : 0}`);
    console.log(
        `  FIXED TREE COMPILES: ${result.diags.length === 0 ? 'YES' : 'NO — ' + result.diags.length + ' diagnostics'}`
    );
    for (const d of result.diags.slice(0, 6)) {
        const sf = d.file;
        const pos = sf ? sf.getLineAndCharacterOfPosition(d.start) : {line: 0, character: 0};
        console.log(
            `      ${sf ? path.basename(sf.fileName) : '?'}(${pos.line + 1},${pos.character + 1}): ` +
                `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
        );
    }
    console.log(`  worktree: ${result.work}`);
}

function main() {
    const argv = process.argv.slice(2);
    const opts = {
        rounds: 25,
        keep: argv.includes('--keep'),
        quiet: argv.includes('--quiet'),
        mode: argv.includes('--jsdoc') ? 'jsdoc' : argv.includes('--auto') ? 'auto' : 'decorator',
    };
    const ri = argv.indexOf('--rounds');
    if (ri >= 0) opts.rounds = Number(argv[ri + 1]);

    const names = argv.filter((a) => a.endsWith('.ts'));
    if (names.length === 0) {
        console.error('usage: node spike/run.js <fixture.ts...> [--rounds N] [--keep] [--quiet]');
        process.exit(1);
    }

    const result = run(names, opts);
    summarize(names.join(' + '), result, opts);

    if (!opts.keep) {
        // leave it — inspecting the fixed source is the point
    }
    return result;
}

if (require.main === module) main();
module.exports = {run, summarize, build, COMPILER_OPTIONS, makeWorkTree};
