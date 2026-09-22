/**
 * `@adorn/test` — contract-driven fuzzing for adorn (Fuzzing Phase A + B).
 *
 * ## What this is, and where it lives (DEC-019, foundation §6.2)
 *
 * A **separate, opt-in add-on** that takes `fast-check` as a real dependency and projects adorn's
 * constraint descriptors into property-based tests. It is the fast-check bridge the core deliberately
 * did not build: core keeps the shape-only `arbitrary` hook typed `unknown` and imports fast-check
 * **nowhere**, so `require('adorn')` never pulls it — the exact isolation DEC-019 established for
 * rxjs, verified here by `isolation.test.ts`.
 *
 * It lives in-repo under `addons/` and, since DEC-073, is BUILT into `dist` as the opt-in `adorn/test`
 * subpath export; it is covered by `npm test` and is **not re-exported from the root `index.ts`** — the
 * root runtime export surface is unchanged. `fast-check` is an OPTIONAL peerDependency.
 *
 * ## The division of labour (foundation §6.1)
 *
 * adorn contributes the **generators** (from descriptors) and the **oracle**. fast-check contributes
 * the property-checking loop, **shrinking**, **seeding**, and **replay** — adorn builds none of those.
 * Reproducibility is inherited for free: generators are pure functions of frozen params (DEC-010), so
 * the only randomness is fast-check's seed.
 *
 * ## Scope
 *
 *   - Sound generation from every built-in constraint, or an honest decline (`arbitraries.ts`).
 *   - The **contract oracle** (`oracle.ts`): Phase A's weak-invariant floor — doesn't-throw +
 *     field-invariant preservation (foundation §5.3) — PLUS Phase B's full postcondition oracle
 *     (DEC-034), which checks BOTH postcondition bands exactly as enforcement does (`@Ensures` closures
 *     via `evaluatePostconditions`, reified `@Returns` via `getEffectiveContract().post`), with async
 *     twins `fuzzMethodAsync`/`fuzzClassAsync`. No drift: the oracle checked is the oracle enforced.
 *   - A **boundary report** that always states what was and was not covered (`report.ts`, §3).
 *
 * @example
 *   import {fuzzClass, formatFuzzReport} from 'adorn/test';
 *   const results = fuzzClass(Account, {subject: () => new Account(100)});
 *   console.log(formatFuzzReport(results, {basis: 'Account'}));
 */

// The generation bridge — the single place `Arbitrary = unknown` is narrowed to `fc.Arbitrary`.
export {arbitraryForConstraint, arbitraryForParameter, STARVATION_THRESHOLD} from './arbitraries';
export type {Arbitrary, ConstraintArbitrary, ParameterArbitrary, GenerationStrategy} from './arbitraries';

// The contract oracle — the weak-invariant floor (Phase A) plus the full postcondition oracle
// (Phase B, DEC-034), consuming BOTH bands exactly as enforcement does. `fuzzMethodAsync`/`fuzzClassAsync`
// are the async twins (fc.asyncProperty) that await the settled value before checking. These live ONLY
// here — Phase B adds ZERO symbols to the root `index.ts` (fast-check isolation, DEC-019).
export {fuzzMethod, fuzzClass, fuzzMethodAsync, fuzzClassAsync} from './oracle';
// The free-function entry points (voice-agent L19): fuzz a `contract()`-wrapped function — the shape a
// zero-class codebase actually has — with the same oracle `fuzzMethod` runs, reading the spec the wrapper
// now exposes (`contractSpecOf`). `fuzzFunctionAsync` is the async twin.
export {fuzzFunction, fuzzFunctionAsync} from './oracle';
export type {
    FuzzOptions,
    FuzzFunctionOptions,
    FuzzResult,
    FuzzFinding,
    FindingType,
    OracleMode,
} from './oracle';

// The stateful call-sequence tester (DEC-090) — the payoff of `@EnabledWhen` (DEC-089). Drives sequences
// of ENABLED method calls against one evolving instance and checks invariants survive every transition;
// a not-enabled call is skipped (not a false positive), a throwing guard is a finding. `fuzzSequenceAsync`
// is the async twin. Add-on-only, fast-check-gated — ZERO new root exports (DEC-019).
export {fuzzSequence, fuzzSequenceAsync} from './sequence';
export type {
    SequenceOptions,
    SequenceResult,
    SequenceFinding,
    SequenceStep,
    SequenceCommandReport,
} from './sequence';

// The boundary report — a condition of shipping, not a nicety (§3). `formatSequenceReport` renders a
// sequence result (its command set + coverage, and on a finding the shrunk enabled sequence).
export {formatFuzzReport, formatSequenceReport} from './report';
export type {FuzzReportOptions} from './report';
