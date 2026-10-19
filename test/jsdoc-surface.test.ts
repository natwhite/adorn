/**
 * GAP-17 regression guard — consumer guidance must stay ON the source declarations, so it survives
 * declaration emit into `the per-module .d.ts under dist/src` and shows on hover (round-2 §1 / round-3).
 *
 * The prior JSDoc waves (DEC-051/052/056/057/059/060/061) already document ~97% of the root surface; this
 * guard prevents a backslide — a declaration silently losing its doc block during an unrelated edit.
 *
 * Design (per the GAP-17 plan + its adversarial review):
 *  - Layer 1 (source, build-independent): a JSDoc block **immediately precedes** each sampled declaration.
 *    Declaration-ANCHORED, not "the file contains a /** somewhere" — every `.d.ts` opens with a module
 *    header, so a per-file check would be vacuous and miss a bare declaration (e.g. a bare class).
 *  - Layer 2 (dist emit): the same anchored check on the shipped `.d.ts` for the canonical trap
 *    (`NumberContracts.Between(min, max)`), proving the pipeline. Skipped-with-warning if `dist/` is not
 *    built, so a bare local `npm test` has no friction; CI builds before test, so it always runs there.
 *  - Presence of a block, never wording or counts (guidance moves between line comments and JSDoc blocks).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

/** The JSDoc block immediately above the first line matching `decl`, or `null` if none is attached. */
function jsdocBlockAbove(source: string, decl: RegExp): string | null {
    const lines = source.split('\n');
    const i = lines.findIndex(line => decl.test(line));
    if (i < 0) throw new Error(`jsdoc guard: no declaration matched ${decl}`);
    let end = i - 1;
    while (end >= 0 && lines[end].trim() === '') end--; // skip blank lines between block and decl
    if (end < 0 || !lines[end].trim().endsWith('*/')) return null; // nearest non-blank line must close a block
    let start = end;
    while (start >= 0 && !lines[start].trim().startsWith('/**')) start--;
    return start < 0 ? null : lines.slice(start, end + 1).join('\n');
}
const hasJsdocAbove = (source: string, decl: RegExp): boolean => jsdocBlockAbove(source, decl) !== null;

// A representative handful across every consumer-facing group — NOT exhaustive (an exhaustive list would
// recreate the maintenance burden `public-surface.test.ts` warns against). Includes the three round-3 P1
// class/setter fixes so they cannot silently regress.
const SOURCE_SAMPLE: ReadonlyArray<readonly [string, RegExp]> = [
    ['src/Contracts/number.ts', /^export function Between\(/],
    ['src/Contracts/object.ts', /^export function Dictionary</],
    ['src/Contracts/object.ts', /^export function Shape</],
    ['src/Contracts/enum.ts', /^export function OneOf</],
    ['src/ParameterDecorators/Constraints.ts', /^const Between = /],
    ['src/Projections/schema.ts', /^export function toolSchemaForMethod\(/],
    ['src/Projections/schema.ts', /^export function toolSchemaFrom\(/],
    ['src/Validation/Verify.ts', /^export class Verify \{/], // P1
    ['src/FieldDecorators/Enforce.ts', /^export class Enforce \{/], // P1
    ['src/FieldDecorators/Enforce.ts', /^ {4}static greaterThan = /],
    ['src/Core/Configuration.ts', /^export function setViolationPolicy/], // P1
];

describe('GAP-17 — consumer JSDoc lives on the source declarations (Layer 1, build-independent)', () => {
    it.each(SOURCE_SAMPLE.map(([file, decl]) => [file, decl] as const))(
        'a JSDoc block immediately precedes %s :: %s',
        (file, decl) => {
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            expect(hasJsdocAbove(source, decl)).toBe(true);
        },
    );

    it('the Between descriptor factory documents its (min, max) argument shape', () => {
        const source = fs.readFileSync(path.join(ROOT, 'src/Contracts/number.ts'), 'utf8');
        const block = jsdocBlockAbove(source, /^export function Between\(/);
        expect(block).toBeTruthy();
        expect(block!.toLowerCase()).toMatch(/min/);
        expect(block!.toLowerCase()).toMatch(/max/);
    });
});

describe('GAP-17 — the guidance actually ships in dist/*.d.ts (Layer 2, emit-level)', () => {
    it('dist/src/Contracts/number.d.ts carries the Between doc block (the canonical trap) — or is unbuilt', () => {
        const distNumber = path.join(ROOT, 'dist/src/Contracts/number.d.ts');
        if (!fs.existsSync(distNumber)) {
            // No local friction: a bare `npm test` (adorn has no prebuild) skips this proof. CI builds first.
            console.warn(
                '[GAP-17 guard] dist/ not built — skipping the emit-level check (run `npm run build`).',
            );
            return;
        }
        const dts = fs.readFileSync(distNumber, 'utf8');
        const block = jsdocBlockAbove(dts, /function Between\b/);
        expect(block).toBeTruthy(); // declaration-anchored: the block must precede `function Between`, not just exist
        expect(block!.toLowerCase()).toMatch(/min/);
        expect(block!.toLowerCase()).toMatch(/max/);
    });
});
