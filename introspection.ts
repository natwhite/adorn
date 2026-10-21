/**
 * `adorn/introspection` — the registry read surface + the shared evaluators (DEC-097).
 *
 * "What is declared / what is in force here", plus the oracles a fuzzer or stateful-sequence driver runs —
 * the SAME functions enforcement runs, so an oracle flags an input exactly when the enforced wrapper would (no
 * drift). This is advanced / tooling surface, moved off the package root in the DEC-097 curation. The registry
 * WRITERS stay internal (Q-6): a caller with one could record a contract the enforcement path never sees.
 * Import from `adorn/introspection`.
 */

// prettier-ignore
export {
    getContracts, getContract, getContractedClasses, getContractsForClass,
    getFieldContract, getFieldContracts, getFieldContractsForClass,
    getEffectiveFieldConstraints, getEffectiveFieldContract,
    getEffectiveContract, getEffectiveParameterConstraints,
    getEffectivePostconditions, getEffectivePreconditions, getEffectiveEnablednessGuards,
} from './src/Core/ContractRegistry';
export type {EnablednessGuard, EnablednessPredicate} from './src/Core/ContractRegistry';

export {evaluatePostconditions} from './src/Core/Postconditions';
export type {PostconditionResult} from './src/Core/Postconditions';
export {evaluatePreconditions} from './src/Core/Preconditions';
export type {PreconditionResult} from './src/Core/Preconditions';
export {evaluateEnabledness} from './src/Core/Enabledness';
export type {EnablednessResult} from './src/Core/Enabledness';
