/**
 * `@adorn/test` — contract-driven fuzzing for adorn (Fuzzing Phase A).
 *
 * ## What this is, and where it lives (DEC-019, foundation §6.2)
 *
 * A **separate, opt-in add-on** that takes `fast-check` as a real dependency and projects adorn's
 * constraint descriptors into property-based tests. It is the fast-check bridge the core deliberately
 * did not build: core keeps the shape-only `arbitrary` hook typed `unknown` and imports fast-check
 * **nowhere**, so `require('adorn')` never pulls it — the exact isolation DEC-019 established for
 * rxjs, verified here by `isolation.test.ts`.
 *
 * It lives in-repo under `addons/` (excluded from the library build, like `tools/sensitive-flow`),
 * is covered by `npm test`, and is **not re-exported from the root `index.ts`** — the runtime export
 * surface is unchanged. It is a future `@adorn/test` package (IDEA-8's `@adorn/rx` shape reused).
 *
 * ## The division of labour (foundation §6.1)
 *
 * adorn contributes the **generators** (from descriptors) and the **oracle**. fast-check contributes
 * the property-checking loop, **shrinking**, **seeding**, and **replay** — adorn builds none of those.
 * Reproducibility is inherited for free: generators are pure functions of frozen params (DEC-010), so
 * the only randomness is fast-check's seed.
 *
 * ## Phase A scope
 *
 *   - Sound generation from every built-in constraint, or an honest decline (`arbitraries.ts`).
 *   - A **weak invariant oracle** — doesn't-throw + field-invariant preservation — that blocks on
 *     nothing (`oracle.ts`, foundation §5.3). The full postcondition oracle is Phase B (Q-11).
 *   - A **boundary report** that always states what was and was not covered (`report.ts`, §3).
 *
 * @example
 *   import {fuzzClass, formatFuzzReport} from '../../addons/test';
 *   const results = fuzzClass(Account, {subject: () => new Account(100)});
 *   console.log(formatFuzzReport(results, {basis: 'Account'}));
 */

// The generation bridge — the single place `Arbitrary = unknown` is narrowed to `fc.Arbitrary`.
export {arbitraryForConstraint, arbitraryForParameter, STARVATION_THRESHOLD} from './arbitraries';
export type {Arbitrary, ConstraintArbitrary, ParameterArbitrary, GenerationStrategy} from './arbitraries';

// The weak invariant oracle.
export {fuzzMethod, fuzzClass} from './oracle';
export type {FuzzOptions, FuzzResult, FuzzFinding, FindingType, OracleMode} from './oracle';

// The boundary report — a condition of shipping, not a nicety (§3).
export {formatFuzzReport} from './report';
export type {FuzzReportOptions} from './report';
