/**
 * The DEC-019 isolation guarantee, asserted — the rxjs lesson applied to fast-check.
 *
 * DEC-019 recorded that an eager import of an optional dependency (`rxjs`, via `@Memoize`) made
 * `require('adorn')` fail with `MODULE_NOT_FOUND`, and GAP-4 added a CI step asserting rxjs is
 * absent from the runtime tree. fast-check gets the same treatment: it is confined to this add-on and
 * core imports it nowhere. Since DEC-073 ships the add-on as the opt-in `adorn/test` subpath, the CORE
 * of the built library (`dist/index.js` + `dist/src/**`) and the root export surface must show no trace
 * of it — the add-on's own `dist/addons/test/**` is where fast-check legitimately appears. Executable here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as adorn from '../../index';

const ROOT = path.resolve(__dirname, '..', '..');

/** Recursively collect files with a given extension, skipping node_modules. */
function walk(dir: string, ext: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, ext, out);
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

describe('fast-check stays out of core (DEC-019, the rxjs lesson)', () => {
    // Matches an actual import/require of fast-check — NOT a comment mentioning it (Descriptor.ts
    // legitimately references the name in prose while importing nothing).
    const IMPORT_RE = /(from\s+['"]fast-check['"]|require\(\s*['"]fast-check['"]\s*\))/;

    it('is installed as a devDependency (sanity — otherwise the add-on could not run)', () => {
        expect(() => require.resolve('fast-check')).not.toThrow();
    });

    it('no file under src/ and not index.ts imports fast-check', () => {
        const files = [path.join(ROOT, 'index.ts'), ...walk(path.join(ROOT, 'src'), '.ts')];
        const offenders = files.filter(file => IMPORT_RE.test(fs.readFileSync(file, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the built CORE (dist/index.js + dist/src) contains no require("fast-check") — dist/addons/test may (DEC-073)', () => {
        const distIndex = path.join(ROOT, 'dist', 'index.js');
        if (!fs.existsSync(distIndex)) {
            // Not built in this run; the source scan above is the build-independent guarantee, and
            // CI builds before testing. Nothing to scan here.
            return;
        }
        const REQUIRE_RE = /require\(\s*['"]fast-check['"]\s*\)/;
        // Scope to the CORE only. `dist/addons/test/**` is the shipped opt-in subpath (DEC-073) and is
        // ALLOWED to require fast-check; the invariant is that the root graph (`require('adorn')`) never does.
        const coreFiles = [distIndex, ...walk(path.join(ROOT, 'dist', 'src'), '.js')];
        const offenders = coreFiles.filter(file => REQUIRE_RE.test(fs.readFileSync(file, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the add-on IS built into dist as the adorn/test subpath export (DEC-073)', () => {
        if (!fs.existsSync(path.join(ROOT, 'dist', 'index.js'))) return; // not built in this run
        expect(fs.existsSync(path.join(ROOT, 'dist', 'addons', 'test', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, 'dist', 'addons', 'test', 'index.d.ts'))).toBe(true);
    });
});

describe('the runtime export surface is unchanged by the add-on', () => {
    it('the add-on is NOT re-exported from the root index (it is the adorn/test subpath, not a root re-export)', () => {
        const addonNames = [
            'fuzzMethod',
            'fuzzClass',
            // Phase B's async twins (DEC-034) live ONLY in addons/test — the root surface is unchanged.
            'fuzzMethodAsync',
            'fuzzClassAsync',
            'formatFuzzReport',
            'arbitraryForConstraint',
            'arbitraryForParameter',
        ];
        for (const name of addonNames) {
            expect(adorn).not.toHaveProperty(name);
        }
    });

    it('no add-on-shaped export leaks through the root index', () => {
        // Intent: nothing from the add-on reaches the library surface. The count is deliberately
        // NOT pinned to an absolute number — legitimate core exports grow over time (@Ensures,
        // getEffectivePostconditions, …), and a magic count would fail loudly on every honest
        // addition instead of on an actual leak. A substring guard catches ALL of the add-on's
        // exports (fuzzMethod/fuzzClass/formatFuzzReport/arbitrary*) and any future ones, while
        // core names (which contain neither token) pass.
        const leaked = Object.keys(adorn).filter(name => /fuzz|arbitrary/i.test(name));
        expect(leaked).toEqual([]);
    });
});
