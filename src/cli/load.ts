/**
 * The load-the-module-to-populate-the-registry step — the concrete answer to DEC-007.
 *
 * ## Why this exists
 *
 * `docs` / `schema` project the **runtime registry**, and the registry is only populated when a
 * decorated module is *imported and its decorators execute* (`@Contract()` installs and enumerates;
 * a parameter/field decorator records). A projection run therefore cannot be static: it must first
 * `require` the user's entry module(s) so the decorators fire, and only then walk the registry. This
 * is the "runtime-registry-first" consequence DEC-007 accepted in exchange for no build-tool lock-in,
 * and `docs.ts` / `schema.ts` both state the same limitation in their own headers.
 *
 * ## The honest limitation (DEC-007, stated to the user)
 *
 * `require`-ing a module **executes it**, top-level side effects and all. Pointing `adorn docs` at a
 * module that opens a database handle or starts a server on import will do exactly that. A static
 * analyser would not — that trade is DEC-007's, made deliberately; this loader is where it becomes
 * concrete, so the cost is named here rather than discovered. When an entry throws during load, the
 * error is wrapped with the entry name and re-raised as a {@link CliError} so the failure reads as
 * "your module failed to load", not an anonymous stack.
 *
 * ## A second, quieter hazard: module identity
 *
 * The projection reads the registry singleton in *this* copy of adorn's `Core/`. For an entry to be
 * visible, its decorators must write to the **same** singleton — i.e. the entry must import the same
 * physical adorn build the CLI is running from. An entry that imports a *different* copy of adorn
 * (a duplicate in a nested `node_modules`, or source while the CLI runs from `dist`) records into a
 * registry the CLI never reads, and projects as empty. The projections' own "imported and evaluated"
 * empty-state note is the visible symptom; this is its less obvious cause.
 *
 * ## TypeScript entries
 *
 * Entries are the user's decorated code, which is usually TypeScript. A compiled `.js` entry loads
 * through a plain `require`. A `.ts` entry needs on-the-fly transpilation, so — only when the host
 * does not already handle `.ts` (a jest run does; a plain `node dist/...` run does not) — `ts-node` is
 * registered lazily. `ts-node` is a devDependency, not a runtime dependency of the library (DEC-019):
 * the require stays lazy and behind a clear "install ts-node, or pass compiled .js" error, so the
 * library never inherits it.
 */

import * as path from 'path';
import {CliError, EXIT} from './errors';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.cts', '.mts']);

let tsNodeRegistered = false;

/**
 * Import every entry module in order, so its decorators execute and populate the registry. Returns
 * nothing — the effect is entirely on the shared registry the projections read next.
 *
 * @throws {CliError} if `ts-node` is needed but absent, or if any entry throws while loading.
 */
export function loadEntries(entries: string[]): void {
    for (const entry of entries) {
        const resolved = path.resolve(entry);
        if (needsTsNode(resolved)) ensureTsNode(entry);
        loadOne(entry, resolved);
    }
}

/** A `.ts`-family entry needs transpilation unless the surrounding host already installed a `.ts` hook. */
function needsTsNode(resolved: string): boolean {
    if (!TS_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return false;
    // A jest run transforms `.ts` through its own module system; registering ts-node on top would
    // fight it. A bare `node dist/...` run has neither, so we must register.
    if (process.env.JEST_WORKER_ID !== undefined) return false;
    const handlers = (require as unknown as {extensions?: Record<string, unknown>}).extensions;
    if (handlers && typeof handlers['.ts'] === 'function') return false;
    return true;
}

function ensureTsNode(entry: string): void {
    if (tsNodeRegistered) return;
    let register: (options: unknown) => void;
    try {
        // Lazy + guarded: ts-node is a dev tool, never a library runtime dependency (DEC-019).
        register = require('ts-node').register as (options: unknown) => void;
    } catch {
        throw new CliError(
            `Entry '${entry}' is TypeScript, but 'ts-node' is not installed.\n` +
                "Install it ('npm i -D ts-node'), or pass a compiled .js entry instead.",
            EXIT.RUNTIME,
        );
    }
    register({
        transpileOnly: true,
        compilerOptions: {
            // `module`/`moduleResolution` are pinned together (TS5110 requires they agree) to the
            // non-deprecated `node16` pair — the same one the repo's own tsconfig uses. With no
            // `"type": "module"` in scope this emits CommonJS, which is what `require` needs, while
            // avoiding the TS5107 deprecation that `node10`/`node` now raises on TypeScript 6.
            module: 'node16',
            moduleResolution: 'node16',
            esModuleInterop: true,
            // Inline the emit helpers rather than `require('tslib')`: the entry can live anywhere, and
            // its directory need not have tslib installed. (The consumer's tsconfig may set
            // importHelpers; the entry's location is the wrong place to assume tslib resolves from.)
            importHelpers: false,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
        },
    });
    tsNodeRegistered = true;
}

function loadOne(entry: string, resolved: string): void {
    try {
        require(resolved);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `Failed to load entry '${entry}': ${detail}\n` +
                'Loading an entry executes it (DEC-007) — a module that throws on import, or that ' +
                'imports a different copy of adorn than this CLI, will fail or project as empty here.',
            EXIT.RUNTIME,
        );
    }
}
