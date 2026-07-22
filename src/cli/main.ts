#!/usr/bin/env node
/**
 * `adorn` — the CLI entry point (IDEA-9).
 *
 * The delivery vehicle for adorn's projections and its detector, which until now could only be run by
 * writing a script: `generateMarkdown()` / `generateSchema()` are functions, and the sensitive-flow
 * detector was built CLI-ready but never wrapped. This file is the wrapper for all three.
 *
 * ## Two paths, kept apart on purpose
 *
 *   - `docs` / `schema` **load then project** (DEC-007): they `require` the user's entry modules so the
 *     decorators execute and populate the runtime registry, then walk it. See `./commands` + `./load`.
 *   - `check` is **static**: it builds a `ts.Program` over source and runs the detector without
 *     executing anything. See `./check`.
 *
 * ## Placement in the package
 *
 * This is a separate entry point, **not** part of the library's runtime export surface — `index.ts`
 * does not import or re-export any of it. It is reachable only through the `bin` field, which points
 * at the compiled `dist/src/cli/main.js`. `run` is exported for tests; the shebang and the
 * `require.main` guard below make the same file executable as the binary.
 */

import * as fs from 'fs';
import * as path from 'path';
import {parseArgs, ParsedCommand} from './args';
import {renderDocs, renderSchema} from './commands';
import {runCheck} from './check';
import {CliError, EXIT} from './errors';

/**
 * Run the CLI and resolve to the process exit code. Never rejects: a {@link CliError} prints its
 * message to stderr and maps to its own exit code; any other throw prints a stack (an unexpected bug,
 * not a user error) and maps to {@link EXIT.RUNTIME}. Returning the code rather than calling
 * `process.exit` keeps `run` testable and lets the caller decide when to exit.
 */
export async function run(argv: string[]): Promise<number> {
    let parsed: ParsedCommand;
    try {
        parsed = parseArgs(argv);
    } catch (error) {
        return fail(error);
    }

    try {
        switch (parsed.kind) {
            case 'help':
                process.stdout.write(HELP);
                return EXIT.OK;
            case 'version':
                process.stdout.write(`${readVersion()}\n`);
                return EXIT.OK;
            case 'docs':
                writeArtifact(renderDocs(parsed.entries), parsed.out);
                return EXIT.OK;
            case 'schema':
                writeArtifact(renderSchema(parsed.entries), parsed.out);
                return EXIT.OK;
            case 'check': {
                const outcome = runCheck(parsed.targets);
                process.stdout.write(`${outcome.report}\n`);
                return outcome.exitCode;
            }
        }
    } catch (error) {
        return fail(error);
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Write a projection artifact to `--out <file>` (with a short stderr note) or to stdout. */
function writeArtifact(content: string, out?: string): void {
    if (out === undefined) {
        process.stdout.write(content);
        return;
    }
    try {
        fs.writeFileSync(out, content);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(`Could not write '${out}': ${detail}`, EXIT.RUNTIME);
    }
    process.stderr.write(`Wrote ${out}\n`);
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

function fail(error: unknown): number {
    if (error instanceof CliError) {
        process.stderr.write(`${error.message}\n`);
        return error.exitCode;
    }
    // Not a handled error — surface the stack, because this is a bug rather than a bad invocation.
    process.stderr.write(`${error instanceof Error && error.stack ? error.stack : String(error)}\n`);
    return EXIT.RUNTIME;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const HELP = `adorn — contract projections and sensitive-flow analysis

Usage:
  adorn docs   [--out <file>] <entry...>   Generate the markdown documentation projection.
  adorn schema [--out <file>] <entry...>   Generate the JSON Schema projection (draft 2020-12).
  adorn check  <tsconfig-or-globs...>      Report @Sensitive values reaching an adorn emitter.

Options:
  --out, -o <file>   Write the artifact to <file> instead of stdout (docs / schema).
  --help, -h         Show this help.
  --version, -v      Show the adorn version.

Notes:
  docs / schema import each <entry> so its decorators run and populate the registry (DEC-007) — this
  executes the module, including any import side effects. An entry may be compiled .js, or .ts when
  ts-node is installed. check is static: it never executes your code, and exits non-zero on any leak.
`;

/** Read this package's version by walking up to the nearest adorn `package.json`. Cosmetic; never throws. */
function readVersion(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'package.json');
        try {
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {name?: string; version?: string};
            if (pkg.name === 'adorn' && typeof pkg.version === 'string') return pkg.version;
        } catch {
            /* keep walking up */
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return 'unknown';
}

// Executed as the binary (`bin` → dist/src/cli/main.js), not when imported by a test. Kept at the
// bottom so every declaration it touches already exists.
if (require.main === module) {
    void run(process.argv.slice(2)).then(code => {
        process.exitCode = code;
    });
}
