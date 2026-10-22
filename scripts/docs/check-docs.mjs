// Executable-docs check (dogfood). Every `import ... from 'adorn...'` in the README and the published
// guides must resolve to a REAL export of the named entry point — verified against the PACKED artifact
// (`npm pack`), not source aliases — under three consumer module modes: ESM/NodeNext, CJS/Node16, and
// bundler. This is what stops a doc example from importing a symbol off the wrong entry point (exactly
// the DEC-097 subpath move that broke the 0.1.0 README hero import).
//
//   node scripts/docs/check-docs.mjs            # build, pack, build 3 fixtures, typecheck the imports
//   TGZ=/abs/path.tgz node scripts/docs/check-docs.mjs   # reuse an existing tarball (skip build+pack)
//
// It extracts only the IMPORT statements (not the illustrative bodies, which use stub placeholders), and
// typechecks each as its own module against the installed package's types. A moved/renamed/removed export,
// or an exports-map that forgets a subpath's types under one resolution mode, fails the build.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {encoding: 'utf8', ...opts});
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm ships as a .cmd shim on Windows, and Node 22 refuses to spawnSync a .cmd without a shell.
const runNpm = (args, opts = {}) => run(npm, args, {shell: process.platform === 'win32', ...opts});

// The published, reader-facing docs whose imports must stay runnable.
const DOC_FILES = [
    'README.md',
    'docs/decorators.md',
    'docs/schemas.md',
    'docs/functional-api.md',
    'docs/observability.md',
    'docs/add-ons.md',
];

// 1. Extract every adorn import statement from fenced ts/typescript code blocks (handles multi-line
//    import lists and `import type`).
const blockRe = /```(?:ts|typescript)\r?\n([\s\S]*?)```/g;
const importRe = /^[ \t]*import\s+(?:type\s+)?[\s\S]*?from\s*['"](adorn(?:\/[\w-]+)?)['"];?/gm;
const imports = [];
for (const rel of DOC_FILES) {
    const text = readFileSync(join(repo, rel), 'utf8');
    for (let bm; (bm = blockRe.exec(text));) {
        const block = bm[1];
        for (let im; (im = importRe.exec(block));) {
            imports.push({file: rel, specifier: im[1], statement: im[0].trim()});
        }
    }
}
if (imports.length === 0) {
    console.error('No adorn imports found in the docs — extraction is broken, failing loudly.');
    process.exit(1);
}
const specifiers = [...new Set(imports.map(i => i.specifier))].sort();
console.log(
    `Extracted ${imports.length} adorn import statement(s) across entry points: ${specifiers.join(', ')}`,
);

// 2. Build dist (so `prepare` is a no-op during pack and pack's stdout stays clean JSON), then pack.
let tgz = process.env.TGZ;
if (!tgz) {
    console.log('Building dist and packing the artifact...');
    runNpm(['run', 'build'], {cwd: repo, stdio: 'ignore'});
    // --ignore-scripts: dist is already built above, so skip the `prepare` lifecycle whose stdout would
    // otherwise pollute the --json output we parse.
    const out = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', tmpdir()], {cwd: repo});
    tgz = join(tmpdir(), JSON.parse(out)[0].filename);
}
tgz = resolve(tgz);
console.log('Artifact:', tgz, '\n');

// 3. Three consumer fixtures, each installing the packed artifact and typechecking the extracted imports.
const fixtures = [
    {name: 'esm-nodenext', type: 'module', module: 'NodeNext', moduleResolution: 'NodeNext'},
    {name: 'cjs-node16', type: 'commonjs', module: 'Node16', moduleResolution: 'Node16'},
    {name: 'bundler', type: 'module', module: 'ESNext', moduleResolution: 'Bundler'},
];
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const workRoot = mkdtempSync(join(tmpdir(), 'adorn-docs-'));
let failed = false;
for (const fx of fixtures) {
    const dir = join(workRoot, fx.name);
    mkdirSync(join(dir, 'src'), {recursive: true});
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({name: `fx-${fx.name}`, private: true, version: '0.0.0', type: fx.type}, null, 2),
    );
    writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    module: fx.module,
                    moduleResolution: fx.moduleResolution,
                    target: 'ES2020',
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                    esModuleInterop: true,
                    types: [],
                },
                include: ['src'],
            },
            null,
            2,
        ),
    );
    // One module per import statement, so identical symbols across blocks never collide as duplicates.
    imports.forEach((imp, i) =>
        writeFileSync(join(dir, 'src', `b${i}.ts`), `${imp.statement}\nexport {};\n`),
    );
    runNpm(['install', '--no-audit', '--no-fund', '--silent', tgz], {cwd: dir, stdio: 'ignore'});
    try {
        run(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], {cwd: dir});
        console.log(
            `PASS  ${fx.name.padEnd(12)} — ${imports.length} imports resolve (${fx.moduleResolution})`,
        );
    } catch (e) {
        failed = true;
        console.log(`FAIL  ${fx.name} (${fx.moduleResolution})`);
        console.log((e.stdout || '') + (e.stderr || ''));
    }
}
rmSync(workRoot, {recursive: true, force: true});

if (failed) {
    console.error(
        '\nDocs import check FAILED — a documented import does not resolve against the packed artifact.',
    );
    process.exit(1);
}
console.log(
    '\nDocs import check OK — every documented import resolves under ESM/NodeNext, CJS/Node16, and bundler.',
);
