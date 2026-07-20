/**
 * SPIKE — drive the typescript-eslint rule over a fixture worktree with the real ESLint API,
 * so the answer to "can an ESLint rule do this" is measured rather than asserted.
 *
 * NOT SHIPPED.
 */
'use strict';

const {ESLint} = require('eslint');
const tseslint = require('typescript-eslint');
const fs = require('fs');
const path = require('path');
const os = require('os');
const rule = require('./eslint-rule');

const FIXTURES = path.join(__dirname, 'fixtures');

function makeWorkTree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorn-spike-eslint-'));
    for (const f of fs.readdirSync(FIXTURES)) {
        fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
    }
    fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'es2019',
                    module: 'commonjs',
                    moduleResolution: 'node10',
                    experimentalDecorators: true,
                    emitDecoratorMetadata: true,
                    strict: false,
                    noEmit: true,
                    lib: ['es2019', 'dom'],
                },
                include: ['*.ts'],
            },
            null,
            2
        )
    );
    return dir;
}

async function main() {
    const dir = makeWorkTree();

    const eslint = new ESLint({
        cwd: dir,
        overrideConfigFile: true,
        fix: process.argv.includes('--fix'),
        overrideConfig: tseslint.config({
            files: ['**/*.ts'],
            languageOptions: {
                parser: tseslint.parser,
                parserOptions: {project: './tsconfig.json', tsconfigRootDir: dir},
            },
            plugins: {spike: {rules: {'no-unmarked-sensitive-flow': rule}}},
            rules: {'spike/no-unmarked-sensitive-flow': 'error'},
        }),
    });

    const t0 = process.hrtime.bigint();
    const results = await eslint.lintFiles([path.join(dir, '*.ts')]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    if (process.argv.includes('--fix')) await ESLint.outputFixes(results);

    let total = 0;
    let fixable = 0;
    const byMsg = {};
    for (const r of results) {
        for (const m of r.messages) {
            total++;
            if (m.fix) fixable++;
            byMsg[m.messageId] = (byMsg[m.messageId] || 0) + 1;
            console.log(
                `  ${path.basename(r.filePath)}:${m.line}:${m.column}  [${m.messageId}]  ${m.message}`
            );
        }
    }
    console.log(`\n  total findings ${total}   with an autofix ${fixable}`);
    console.log(`  by message ${JSON.stringify(byMsg)}`);
    console.log(`  ESLint wall ${ms.toFixed(0)} ms (one pass, ${results.length} files)`);
    console.log(`  worktree ${dir}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
