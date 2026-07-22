/**
 * Unit tests for the hand-rolled argument parser. Pure input → `ParsedCommand` (or a thrown
 * `CliError`); no files, no registry, no process exit — so every grammar branch is exercised here in
 * isolation, and the command handlers are tested separately.
 */

import {parseArgs} from './args';
import {CliError, EXIT} from './errors';

describe('parseArgs — projection commands', () => {
    it('parses docs with a single entry', () => {
        expect(parseArgs(['docs', 'entry.ts'])).toEqual({kind: 'docs', entries: ['entry.ts']});
    });

    it('parses schema with several entries', () => {
        expect(parseArgs(['schema', 'a.ts', 'b.ts'])).toEqual({
            kind: 'schema',
            entries: ['a.ts', 'b.ts'],
        });
    });

    it('parses --out <file> before the entries', () => {
        expect(parseArgs(['docs', '--out', 'out.md', 'a.ts'])).toEqual({
            kind: 'docs',
            entries: ['a.ts'],
            out: 'out.md',
        });
    });

    it('parses --out=<file> and -o interchangeably', () => {
        expect(parseArgs(['schema', '--out=s.json', 'a.ts'])).toMatchObject({out: 's.json'});
        expect(parseArgs(['docs', '-o', 'd.md', 'a.ts'])).toMatchObject({out: 'd.md'});
    });

    it('rejects --out with no following value', () => {
        expect(() => parseArgs(['docs', '--out'])).toThrow(/requires a file path/);
    });

    it('rejects an unknown option', () => {
        expect(() => parseArgs(['docs', '--nope', 'a.ts'])).toThrow(/Unknown option/);
    });

    it('requires at least one entry', () => {
        try {
            parseArgs(['docs']);
            throw new Error('expected a throw');
        } catch (error) {
            expect(error).toBeInstanceOf(CliError);
            expect((error as CliError).exitCode).toBe(EXIT.USAGE);
            expect((error as CliError).message).toMatch(/at least one entry/);
        }
    });
});

describe('parseArgs — check', () => {
    it('parses a single tsconfig/target', () => {
        expect(parseArgs(['check', 'tsconfig.json'])).toEqual({
            kind: 'check',
            targets: ['tsconfig.json'],
        });
    });

    it('parses several globs', () => {
        expect(parseArgs(['check', 'src/**/*.ts', 'lib/**/*.ts'])).toEqual({
            kind: 'check',
            targets: ['src/**/*.ts', 'lib/**/*.ts'],
        });
    });

    it('requires at least one target', () => {
        expect(() => parseArgs(['check'])).toThrow(/needs a tsconfig/);
    });
});

describe('parseArgs — help, version, and misuse', () => {
    it('treats no arguments as help', () => {
        expect(parseArgs([])).toEqual({kind: 'help'});
    });

    it('recognises --help / -h anywhere, even after a command', () => {
        expect(parseArgs(['--help'])).toEqual({kind: 'help'});
        expect(parseArgs(['docs', '--help'])).toEqual({kind: 'help'});
    });

    it('recognises --version / -v', () => {
        expect(parseArgs(['--version'])).toEqual({kind: 'version'});
        expect(parseArgs(['-v'])).toEqual({kind: 'version'});
    });

    it('rejects an unknown command with a usage exit code', () => {
        try {
            parseArgs(['frobnicate']);
            throw new Error('expected a throw');
        } catch (error) {
            expect(error).toBeInstanceOf(CliError);
            expect((error as CliError).exitCode).toBe(EXIT.USAGE);
            expect((error as CliError).message).toMatch(/Unknown command/);
        }
    });
});
