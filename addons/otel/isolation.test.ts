/**
 * The DEC-019/DEC-044 isolation guarantee for `@adorn/otel` — the rxjs/fast-check lesson applied to
 * `@opentelemetry/*`, made executable (the OTel twin of `addons/test/isolation.test.ts`).
 *
 * `@opentelemetry/api` is the add-on's declared **peer** and a devDependency of this repo (for building
 * and testing only). It must be reachable from NO file under `src/` and NOT from `index.ts`; the built
 * runtime library (`dist/`) must contain no `@opentelemetry` require; and no OTel/span-shaped symbol may
 * leak onto `require('../../index')`. The core runtime dependency set stays `{tslib}`. This file is that
 * guarantee, asserted.
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

describe('@opentelemetry stays out of core (DEC-019/DEC-044, the rxjs lesson)', () => {
    // Matches an actual import/require of ANY `@opentelemetry/*` package — NOT a comment mentioning the
    // name (Observation.ts/settle.ts legitimately reference `@opentelemetry` in prose, importing nothing).
    const IMPORT_RE =
        /(from\s+['"]@opentelemetry\/[^'"]+['"]|require\(\s*['"]@opentelemetry\/[^'"]+['"]\s*\))/;

    it('is installed as a devDependency (sanity — otherwise the add-on could not run)', () => {
        expect(() => require.resolve('@opentelemetry/api')).not.toThrow();
    });

    it('no file under src/ and not index.ts imports @opentelemetry/*', () => {
        const files = [path.join(ROOT, 'index.ts'), ...walk(path.join(ROOT, 'src'), '.ts')];
        const offenders = files.filter(file => IMPORT_RE.test(fs.readFileSync(file, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the built runtime library (dist) contains no require("@opentelemetry/*")', () => {
        const distIndex = path.join(ROOT, 'dist', 'index.js');
        if (!fs.existsSync(distIndex)) {
            // Not built in this run; the source scan above is the build-independent guarantee, and CI
            // builds before testing. Nothing to scan here.
            return;
        }
        const REQUIRE_RE = /require\(\s*['"]@opentelemetry\/[^'"]+['"]\s*\)/;
        const offenders = walk(path.join(ROOT, 'dist'), '.js').filter(file =>
            REQUIRE_RE.test(fs.readFileSync(file, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });

    it('the core runtime dependency set is unchanged — {tslib} only', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(Object.keys(pkg.dependencies || {})).toEqual(['tslib']);
        // @opentelemetry/* is a devDependency, never a runtime dependency or a peer of core.
        for (const name of Object.keys(pkg.dependencies || {})) {
            expect(name.startsWith('@opentelemetry/')).toBe(false);
        }
    });
});

describe('the runtime export surface is unchanged by the add-on', () => {
    it('the add-on is NOT re-exported from the root index (it is a separate @adorn/otel package)', () => {
        const addonNames = ['createOtelSink', 'mapSpanKind', 'attributesFromValues', 'violationAttributes'];
        for (const name of addonNames) {
            expect(adorn).not.toHaveProperty(name);
        }
    });

    it('no OTel/span-shaped export leaks through the root index', () => {
        // Intent: nothing from the add-on reaches the library surface. A substring guard (not a magic
        // count — cf. addons/test/isolation.test.ts) catches the add-on's exports and any future ones,
        // while core names pass. NB: `settle`/`ObservationSink` are legitimately core (the seam the
        // add-on CONSUMES), so the guard targets the OTel-specific tokens the add-on ADDS.
        const leaked = Object.keys(adorn).filter(name =>
            /otel|createOtelSink|spankind|recordexception/i.test(name),
        );
        expect(leaked).toEqual([]);
    });
});
