/**
 * The `check` command — the *static* path, deliberately nothing like `docs` / `schema`.
 *
 * `docs` / `schema` execute the user's code to fill a runtime registry (DEC-007). `check` does the
 * opposite: it builds a `ts.Program` over the user's **source** and never runs a line of it. It is a
 * thin wrapper over the sensitive-flow detector core (`tools/sensitive-flow`), exactly as the ESLint
 * rule is — the core takes an already-built `ts.Program`, so the rule and this CLI are the two thin
 * wrappers DEC-028 point 2 anticipated ("the same core with a different wrapper").
 *
 * ## Why nothing here imports `tools/` at compile time
 *
 * The detector is build-time tooling, excluded from the library build (DEC-028). A *static* import of
 * it from this file would pull it into the main `tsc` program and emit it beside the library. To keep
 * the main build clean, this module depends on the detector only through the small structural
 * {@link DetectorLike} contract and loads the compiled detector by path at runtime ({@link loadDetector}).
 * `buildProgram` / {@link analyzeAndReport} take their `typescript` module and detector as parameters,
 * so a test can inject the real core (imported from source, where importing `tools/` is fine) and
 * exercise this end to end without any compiled artifact.
 *
 * ## `typescript` is a peer, not a library dependency (DEC-019)
 *
 * The TypeScript compiler API is heavyweight and every consumer already has it at dev time, so it is
 * `require`d lazily behind a clear error ({@link loadTypescript}) rather than declared a runtime
 * dependency of the library — the same restraint DEC-019 applied to rxjs.
 */

import * as path from 'path';
import type * as ts from 'typescript';
import {CliError, EXIT} from './errors';

type TypeScriptModule = typeof import('typescript');

/** The subset of an `AnalysisResult` this command reads. Structural, so the real result satisfies it. */
interface AnalysisResultLike {
    readonly leaks: ReadonlyArray<unknown>;
    readonly outOfScope: ReadonlyArray<unknown>;
    readonly analyzedSinks: ReadonlyArray<unknown>;
}

/**
 * The two detector-core functions `check` needs, as a structural contract. The real
 * `analyzeProgram` / `formatScopeReport` from `tools/sensitive-flow` satisfy it, and so does a stub in
 * a test — which is the whole point of depending on the shape rather than the module.
 */
export interface DetectorLike {
    analyzeProgram(program: ts.Program, rootFiles: string[]): AnalysisResultLike;
    formatScopeReport(result: AnalysisResultLike, options?: {basis?: string}): string;
}

/** A built program plus the roots to scan and a human description of how they were chosen. */
export interface BuiltProgram {
    readonly program: ts.Program;
    /** The developer's own files — the scan is bounded to these; declaration files are always skipped. */
    readonly rootFiles: string[];
    /** The enumeration basis, printed by the scope report so it states its own limits (DEC-007). */
    readonly basis: string;
}

export interface CheckOutcome {
    readonly report: string;
    readonly exitCode: number;
    readonly leakCount: number;
}

/**
 * Build a `ts.Program` from either a single `tsconfig.json` (or a directory containing one) or one or
 * more source globs. A tsconfig contributes its own compiler options; globs get decorator-aware
 * defaults mirroring the detector's in-memory test host.
 */
export function buildProgram(targets: string[], tsModule: TypeScriptModule): BuiltProgram {
    const configPath = targets.length === 1 ? resolveConfigPath(targets[0], tsModule) : undefined;
    return configPath ? fromTsconfig(configPath, tsModule) : fromGlobs(targets, tsModule);
}

/** Run the detector over a built program and turn its result into a report plus an exit code. */
export function analyzeAndReport(built: BuiltProgram, detector: DetectorLike): CheckOutcome {
    const result = detector.analyzeProgram(built.program, built.rootFiles);
    const report = detector.formatScopeReport(result, {basis: built.basis});
    const leakCount = result.leaks.length;
    return {report, exitCode: leakCount > 0 ? EXIT.LEAKS : EXIT.OK, leakCount};
}

/** Production wiring: resolve `typescript` and the compiled detector, then build-and-analyse. */
export function runCheck(targets: string[]): CheckOutcome {
    const tsModule = loadTypescript();
    const detector = loadDetector();
    const built = buildProgram(targets, tsModule);
    return analyzeAndReport(built, detector);
}

// ---------------------------------------------------------------------------
// Program construction
// ---------------------------------------------------------------------------

function resolveConfigPath(target: string, tsModule: TypeScriptModule): string | undefined {
    const abs = path.resolve(target);
    if (tsModule.sys.fileExists(abs) && abs.toLowerCase().endsWith('.json')) return abs;
    if (tsModule.sys.directoryExists(abs)) {
        const candidate = path.join(abs, 'tsconfig.json');
        if (tsModule.sys.fileExists(candidate)) return candidate;
    }
    return undefined;
}

function fromTsconfig(configPath: string, tsModule: TypeScriptModule): BuiltProgram {
    const host: ts.ParseConfigFileHost = {
        ...tsModule.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new CliError(
                `Could not read '${configPath}': ${flatten(tsModule, diagnostic)}`,
                EXIT.RUNTIME,
            );
        },
    };
    const parsed = tsModule.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed) throw new CliError(`Could not parse '${configPath}'.`, EXIT.RUNTIME);
    if (parsed.fileNames.length === 0) {
        throw new CliError(`'${configPath}' matched no input files.`, EXIT.RUNTIME);
    }

    const options: ts.CompilerOptions = {...parsed.options, noEmit: true};
    const program = tsModule.createProgram({rootNames: parsed.fileNames, options});
    return {program, rootFiles: parsed.fileNames, basis: configPath};
}

function fromGlobs(targets: string[], tsModule: TypeScriptModule): BuiltProgram {
    const basePath = process.cwd();
    // TypeScript's include matcher works in forward slashes; a Windows path (or a `path.join`ed glob)
    // with backslashes silently matches nothing, so normalise before handing them over.
    const include = targets.map(target => target.replace(/\\/g, '/'));
    const parsed = tsModule.parseJsonConfigFileContent(
        {include, compilerOptions: defaultCompilerOptions()},
        tsModule.sys,
        basePath,
    );
    if (parsed.fileNames.length === 0) {
        throw new CliError(`No input files matched: ${targets.join(', ')}`, EXIT.RUNTIME);
    }

    const program = tsModule.createProgram({rootNames: parsed.fileNames, options: parsed.options});
    return {program, rootFiles: parsed.fileNames, basis: targets.join(', ')};
}

/**
 * Decorator-aware defaults for the globs path, mirroring the detector's own in-memory host
 * (`tools/sensitive-flow/compilerHost.ts`). `experimentalDecorators` is mandatory — a `@Sensitive`
 * field is a compile error without it and the AST the detector walks would differ. Expressed as raw
 * JSON option values because `parseJsonConfigFileContent` reads a tsconfig-shaped object.
 */
function defaultCompilerOptions(): Record<string, unknown> {
    return {
        target: 'es2019',
        module: 'commonjs',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        lib: ['es2019', 'dom'],
    };
}

function flatten(tsModule: TypeScriptModule, diagnostic: ts.Diagnostic): string {
    return tsModule.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

// ---------------------------------------------------------------------------
// Lazy, guarded dependency loading (production only; tests inject instead)
// ---------------------------------------------------------------------------

/** Resolve the TypeScript compiler API, or fail with an actionable message (DEC-019 — lazy, not a dep). */
export function loadTypescript(): TypeScriptModule {
    try {
        return require('typescript') as TypeScriptModule;
    } catch {
        throw new CliError(
            "'adorn check' requires the 'typescript' package to build a program.\n" +
                "Install it ('npm i -D typescript') to run static analysis.",
            EXIT.RUNTIME,
        );
    }
}

/**
 * Load the compiled detector core from `dist/tools/sensitive-flow`, resolved relative to this file
 * (`dist/src/cli`). The detector's *source* stays out of the library build (DEC-028); a compiled copy
 * is emitted under `dist/tools` purely so this wrapper can require it — see `tsconfig.cli.json`.
 */
export function loadDetector(): DetectorLike {
    const base = path.join(__dirname, '..', '..', 'tools', 'sensitive-flow');
    try {
        const analysis = require(path.join(base, 'analysis')) as {
            analyzeProgram: DetectorLike['analyzeProgram'];
        };
        const report = require(path.join(base, 'report')) as {
            formatScopeReport: DetectorLike['formatScopeReport'];
        };
        return {analyzeProgram: analysis.analyzeProgram, formatScopeReport: report.formatScopeReport};
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `Could not load the sensitive-flow detector: ${detail}\n` +
                "Expected the compiled detector at 'dist/tools/sensitive-flow' — run 'npm run build'.",
            EXIT.RUNTIME,
        );
    }
}
