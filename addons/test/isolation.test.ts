/**
 * The DEC-019 isolation guarantee, asserted — the rxjs lesson applied to fast-check.
 *
 * DEC-019 recorded that an eager import of an optional dependency (`rxjs`, via `@Memoize`) made
 * `require('adorn')` fail with `MODULE_NOT_FOUND`, and GAP-4 added a CI step asserting rxjs is
 * absent from the runtime tree. fast-check gets the same treatment: it is a devDependency confined
 * entirely to this add-on, core imports it nowhere, and the runtime library (`dist/`) and the runtime
 * export surface must show no trace of it. This file is that guarantee, executable.
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

    it('the built runtime library (dist) contains no require("fast-check")', () => {
        const distIndex = path.join(ROOT, 'dist', 'index.js');
        if (!fs.existsSync(distIndex)) {
            // Not built in this run; the source scan above is the build-independent guarantee, and
            // CI builds before testing. Nothing to scan here.
            return;
        }
        const REQUIRE_RE = /require\(\s*['"]fast-check['"]\s*\)/;
        const offenders = walk(path.join(ROOT, 'dist'), '.js').filter(file =>
            REQUIRE_RE.test(fs.readFileSync(file, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });
});

describe('the runtime export surface is unchanged by the add-on', () => {
    it('the add-on is NOT re-exported from the root index (it is a separate @adorn/test package)', () => {
        const addonNames = [
            'fuzzMethod',
            'fuzzClass',
            'formatFuzzReport',
            'arbitraryForConstraint',
            'arbitraryForParameter',
        ];
        for (const name of addonNames) {
            expect(adorn).not.toHaveProperty(name);
        }
    });

    it('the root export count is unchanged (56 runtime value exports, DEC-030 era)', () => {
        // Pinned so accidental leakage of an add-on export through `index.ts` fails loudly. The
        // add-on adds none — it is imported directly from `addons/test`, never re-exported.
        expect(Object.keys(adorn).length).toBe(56);
    });
});
