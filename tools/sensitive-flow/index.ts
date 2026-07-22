/**
 * `tools/sensitive-flow` — the build-time sensitive-flow detector.
 *
 * BUILD-TIME TOOLING, NOT library code. This directory is excluded from the library build
 * (`tsconfig.json` `exclude`), so nothing here reaches `dist/` or the runtime export surface; it is
 * typechecked by `tsconfig.test.json` and exercised by `npm test` (jest picks up `*.test.ts` here).
 * See `docs/sensitive.md` and `docs/sensitive-flow-spike.md` §15.
 *
 * This barrel is the package's public shape — what a future `adorn` CLI (`adorn check`, IDEA-9) or an
 * adorn ESLint plugin imports. Both are thin wrappers over {@link analyzeProgram} / the rule:
 *
 *   - **CLI**:  build a `ts.Program` (`ts.createProgram(...)`), call {@link analyzeProgram}, print
 *     {@link formatScopeReport}, and exit non-zero on any leak.
 *   - **ESLint plugin**: register {@link noSensitiveToAdornSink} under a plugin namespace.
 */

export {analyzeProgram, findCallFindings, classifySource, classifySink} from './analysis';
export type {
    AnalysisResult,
    CallFinding,
    EmissionPosition,
    Leak,
    OutOfScopeFlow,
    SensitiveSource,
    SourceKind,
    Emitter,
    SinkClassification,
} from './analysis';

export {formatScopeReport} from './report';
export type {ScopeReportOptions} from './report';

export {noSensitiveToAdornSink} from './rule';

export {
    getLegalityTable,
    classifyHostCategory,
    isLegalMethodDecoratorHost,
    isLegalParameterDecoratorHost,
} from './legality';
export type {HostCategory} from './legality';
