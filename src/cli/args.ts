/**
 * A tiny hand-rolled argument parser (DEC-019's ethic — a CLI must not drag a dependency into the
 * library for something this small). The whole grammar is:
 *
 *   adorn docs   [--out <file>] <entry...>
 *   adorn schema [--out <file>] <entry...>
 *   adorn check  <tsconfig-or-globs...>
 *   adorn --help | --version
 *
 * There are no short-option clusters, no `=`-vs-space ambiguity to speak of (both `--out x` and
 * `--out=x` are accepted), and no interspersed flags a full parser library would earn its weight on.
 * A dependency here would be exactly the reflex DEC-019 warns against.
 *
 * Parsing is total and side-effect-free: it returns a discriminated {@link ParsedCommand} or throws a
 * {@link CliError} with a usage message. It never reads a file, imports a module, or touches the
 * registry — those are the command handlers' jobs, kept out of here so the parser stays unit-testable
 * in isolation.
 */

import {CliError, EXIT} from './errors';

/** A projection command (`docs` / `schema`): entry modules to load, plus an optional output file. */
export interface ProjectionCommand {
    readonly kind: 'docs' | 'schema';
    /** Entry module(s) to import so the runtime registry fills before projecting (DEC-007). */
    readonly entries: string[];
    /** `--out <file>`; when absent the artifact is written to stdout. */
    readonly out?: string;
}

/** The static detector command (`check`): tsconfig path(s) or source globs to analyse. */
export interface CheckCommand {
    readonly kind: 'check';
    /** A single `tsconfig.json` / directory, or one-or-more source globs. */
    readonly targets: string[];
}

export type ParsedCommand =
    {readonly kind: 'help'} | {readonly kind: 'version'} | ProjectionCommand | CheckCommand;

const KNOWN_COMMANDS = ['docs', 'schema', 'check'];

/**
 * Parse `argv` (already stripped of `node` and the script path). Throws {@link CliError} on any
 * malformed invocation so the dispatcher can print usage and exit non-zero uniformly.
 */
export function parseArgs(argv: string[]): ParsedCommand {
    // `--help` / `--version` win wherever they appear, so `adorn docs --help` still prints help rather
    // than complaining about a missing entry.
    if (argv.some(a => a === '--help' || a === '-h')) return {kind: 'help'};
    if (argv.some(a => a === '--version' || a === '-v')) return {kind: 'version'};

    const [command, ...rest] = argv;
    if (command === undefined) return {kind: 'help'};

    if (command === 'docs' || command === 'schema') return parseProjection(command, rest);
    if (command === 'check') return parseCheck(rest);

    throw new CliError(
        `Unknown command '${command}'. Expected one of: ${KNOWN_COMMANDS.join(', ')}.\n` +
            "Run 'adorn --help' for usage.",
        EXIT.USAGE,
    );
}

function parseProjection(kind: 'docs' | 'schema', rest: string[]): ProjectionCommand {
    let out: string | undefined;
    const entries: string[] = [];

    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token === '--out' || token === '-o') {
            const value = rest[i + 1];
            if (value === undefined || value.startsWith('-')) {
                throw new CliError(`'${token}' requires a file path.`, EXIT.USAGE);
            }
            out = value;
            i++; // consume the value
            continue;
        }
        if (token.startsWith('--out=')) {
            out = token.slice('--out='.length);
            if (out.length === 0) throw new CliError("'--out=' requires a file path.", EXIT.USAGE);
            continue;
        }
        if (token.startsWith('-')) {
            throw new CliError(`Unknown option '${token}' for '${kind}'.`, EXIT.USAGE);
        }
        entries.push(token);
    }

    if (entries.length === 0) {
        throw new CliError(
            `'adorn ${kind}' needs at least one entry module to load.\n` +
                `  usage: adorn ${kind} [--out <file>] <entry...>\n` +
                'The entry is imported so its decorators run and populate the registry (DEC-007).',
            EXIT.USAGE,
        );
    }

    return out === undefined ? {kind, entries} : {kind, entries, out};
}

function parseCheck(rest: string[]): CheckCommand {
    const targets: string[] = [];
    for (const token of rest) {
        if (token.startsWith('-')) {
            throw new CliError(`Unknown option '${token}' for 'check'.`, EXIT.USAGE);
        }
        targets.push(token);
    }

    if (targets.length === 0) {
        throw new CliError(
            "'adorn check' needs a tsconfig.json or one or more source globs.\n" +
                '  usage: adorn check <tsconfig-or-globs...>',
            EXIT.USAGE,
        );
    }

    return {kind: 'check', targets};
}
