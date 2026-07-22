/**
 * In-memory TypeScript program builder.
 *
 * Used in two places, and by nothing that ships:
 *   - {@link ./legality} compiles tiny probe snippets to determine, from the *compiler* rather than
 *     from AST node kinds, where an adorn decorator is legal (SMELL-19).
 *   - the detector's tests build fixture programs without touching disk.
 *
 * The analysis core ({@link ./analysis}) does NOT use this — it takes an already-built `ts.Program`,
 * which is exactly the shape a typescript-eslint rule holds via parser services and a future CLI holds
 * from `ts.createProgram`. That is what lets one core serve both (the ESLint rule and the CLI) as thin
 * wrappers.
 */

import * as ts from 'typescript';
import * as path from 'path';

export interface InMemoryProgram {
    program: ts.Program;
    checker: ts.TypeChecker;
    /** Absolute paths of the supplied files, in the shape `analyzeProgram` expects as its roots. */
    rootFiles: string[];
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS,
    // The decorator flags adorn is built on (DEC-003/DEC-013). Legality of a legacy decorator is
    // meaningless without `experimentalDecorators`, so it is not optional here.
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    // Mirrors the real tsconfig's `["es2019","dom"]` so `console` resolves to a declaration file —
    // which is exactly how a raw `console.log(sensitive)` is recognised as an out-of-scope receiver.
    lib: ['lib.es2019.d.ts', 'lib.dom.d.ts'],
};

/**
 * Build a program from a map of `{ fileName: sourceText }`. Lib files are served by the default
 * compiler host; the supplied files are served from memory.
 */
export function createInMemoryProgram(
    files: Record<string, string>,
    options: ts.CompilerOptions = {},
): InMemoryProgram {
    const opts: ts.CompilerOptions = {...DEFAULT_OPTIONS, ...options};

    const fileMap = new Map<string, string>();
    for (const [name, content] of Object.entries(files)) {
        fileMap.set(path.resolve(name), content);
    }
    const rootFiles = [...fileMap.keys()];

    const defaultHost = ts.createCompilerHost(opts, true);
    const host: ts.CompilerHost = {
        ...defaultHost,
        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const content = fileMap.get(path.resolve(fileName));
            if (content !== undefined) {
                return ts.createSourceFile(fileName, content, languageVersionOrOptions, true);
            }
            return defaultHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                shouldCreateNewSourceFile,
            );
        },
        fileExists(fileName) {
            return fileMap.has(path.resolve(fileName)) || defaultHost.fileExists(fileName);
        },
        readFile(fileName) {
            const inMemory = fileMap.get(path.resolve(fileName));
            return inMemory !== undefined ? inMemory : defaultHost.readFile(fileName);
        },
        writeFile() {
            /* noEmit — nothing is written */
        },
    };

    const program = ts.createProgram(rootFiles, opts, host);
    return {program, checker: program.getTypeChecker(), rootFiles};
}
