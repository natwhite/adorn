/**
 * Tests for the static `check` path.
 *
 * The detector core is injected (imported from `tools/` source, where importing it is fine) so this
 * exercises the real analysis without any compiled artifact — the same seam that lets `check` keep the
 * detector off the main build. Two program-construction routes are covered against real files on disk
 * (a glob and a tsconfig), plus the leak / clean exit-code contract.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import {createInMemoryProgram} from '../../tools/sensitive-flow/compilerHost';
import {analyzeProgram} from '../../tools/sensitive-flow/analysis';
import {formatScopeReport} from '../../tools/sensitive-flow/report';

import {analyzeAndReport, buildProgram, loadDetector, loadTypescript, BuiltProgram} from './check';
import {EXIT} from './errors';

const detector = {analyzeProgram, formatScopeReport};

const LEAK_SRC = `
function Sensitive(): any { return () => {}; }
function Log(): any { return () => {}; }
class Customer { @Sensitive() ssn: string = ''; name: string = ''; }
class AuditService { @Log() write(entry: string): void { void entry; } }
export function handle(c: Customer, a: AuditService): void { a.write(c.ssn); }
`;
const CLEAN_SRC = LEAK_SRC.replace('a.write(c.ssn)', 'a.write(c.name)');

function inMemory(source: string): BuiltProgram {
    const {program, rootFiles} = createInMemoryProgram({'fixture.ts': source});
    return {program, rootFiles, basis: 'fixture.ts'};
}

describe('analyzeAndReport — the leak/clean exit-code contract', () => {
    it('reports a leak and exits non-zero (LEAKS) when a @Sensitive value reaches @Log', () => {
        const outcome = analyzeAndReport(inMemory(LEAK_SRC), detector);

        expect(outcome.leakCount).toBe(1);
        expect(outcome.exitCode).toBe(EXIT.LEAKS);
        expect(outcome.exitCode).not.toBe(0);
        expect(outcome.report).toContain('Leaks: 1');
        expect(outcome.report).toContain('Customer.ssn');
    });

    it('exits zero on a clean program, and still prints the analysed denominator (clean != never-run)', () => {
        const outcome = analyzeAndReport(inMemory(CLEAN_SRC), detector);

        expect(outcome.leakCount).toBe(0);
        expect(outcome.exitCode).toBe(EXIT.OK);
        expect(outcome.report).toContain('Leaks: none');
        expect(outcome.report).toContain('Analysed 1 adorn emission position');
    });
});

describe('buildProgram — real files on disk', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adorn-cli-check-'));
        fs.writeFileSync(path.join(dir, 'leak.ts'), LEAK_SRC);
    });

    afterAll(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    it('builds a program from a glob and finds the leak', () => {
        const built = buildProgram([path.join(dir, '*.ts')], ts);
        expect(built.rootFiles.some(f => f.endsWith('leak.ts'))).toBe(true);

        const outcome = analyzeAndReport(built, detector);
        expect(outcome.exitCode).toBe(EXIT.LEAKS);
    });

    it('builds a program from a tsconfig.json and finds the leak', () => {
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {experimentalDecorators: true, strict: false, noEmit: true},
                include: ['leak.ts'],
            }),
        );

        const built = buildProgram([path.join(dir, 'tsconfig.json')], ts);
        expect(built.basis).toBe(path.join(dir, 'tsconfig.json'));

        const outcome = analyzeAndReport(built, detector);
        expect(outcome.exitCode).toBe(EXIT.LEAKS);
    });

    it('reports a clear error when nothing matches', () => {
        expect(() => buildProgram([path.join(dir, 'nope', '*.ts')], ts)).toThrow(/No input files matched/);
    });
});

describe('production dependency loaders', () => {
    it('loadTypescript resolves the compiler API', () => {
        expect(typeof loadTypescript().createProgram).toBe('function');
    });

    it('loadDetector resolves the analysis + report functions', () => {
        const loaded = loadDetector();
        expect(typeof loaded.analyzeProgram).toBe('function');
        expect(typeof loaded.formatScopeReport).toBe('function');
    });
});
