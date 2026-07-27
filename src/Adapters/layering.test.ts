/**
 * Layering guard (DEC-012 / GAP-8) — the decorator-adapter modules were physically separated out
 * of `Core/` into `src/Adapters/` (`legacy/` today, a `stage3/` sibling later), so the boundary
 * DEC-012 mandates is now enforced by *structure* rather than only by convention.
 *
 * This test makes that boundary **mechanical**: no module under `Core/`, `Contracts/`, or
 * `Projections/` — the three decorator-agnostic bands — may import from `Adapters/`. The reverse
 * direction is legal and unchecked (an adapter imports Core/Contracts freely), as are the
 * composition root (`index.ts`) and the decorator bands (`MethodDecorators/`, `ParameterDecorators/`,
 * `FieldDecorators/`), which are *entitled* to bind to an adapter.
 *
 * It mirrors the per-file imports-regex guard in `src/Projections/docs.test.ts`, widened to a sweep
 * over every module in the three guarded bands so a newly added file cannot quietly reintroduce the
 * coupling GAP-8 removed. A projection binding to the legacy adapter, for instance, would silently
 * lose documentation for the standard-decorator authoring path — exactly what DEC-012 exists to stop.
 */
import * as fs from 'fs';
import * as path from 'path';

const ADAPTERS_DIR = __dirname; // src/Adapters
const SRC_DIR = path.resolve(__dirname, '..'); // src
const GUARDED_BANDS = ['Core', 'Contracts', 'Projections'];

/** Every non-test `.ts` module under `dir`, recursively. */
function collectModules(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectModules(full));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Every `import`/`export ... from '<specifier>'` specifier in `source`. Anchored at the start of a
 * line so prose in a doc comment cannot register as an import, and `[\s\S]*?` so a multi-line
 * (brace-wrapped) import whose `from` sits on a later line is still captured.
 */
function importSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const re = /^\s*(?:import|export)\b[\s\S]*?\bfrom\s*'([^']+)'/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

describe('layering (DEC-012 / GAP-8): the decorator-agnostic bands never import an adapter', () => {
    const guardedModules = GUARDED_BANDS.flatMap(band => collectModules(path.join(SRC_DIR, band)));

    it('actually scans the guarded bands (guard against a globbing regression)', () => {
        // If this ever collapses to a handful, the sweep below is silently checking almost nothing.
        expect(guardedModules.length).toBeGreaterThan(10);
    });

    it.each(guardedModules.map(file => [path.relative(SRC_DIR, file), file] as const))(
        '%s imports nothing from Adapters/',
        (_label, file) => {
            const source = fs.readFileSync(file, 'utf8');
            const fromDir = path.dirname(file);

            for (const specifier of importSpecifiers(source)) {
                // Bare/package specifiers cannot reach a sibling source directory.
                if (!specifier.startsWith('.')) continue;
                const resolved = path.resolve(fromDir, specifier);
                expect(resolved.startsWith(ADAPTERS_DIR + path.sep)).toBe(false);
            }
        },
    );
});
