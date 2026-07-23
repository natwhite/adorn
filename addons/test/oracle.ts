/**
 * `@adorn/test` — the weak invariant oracle (Fuzzing Phase A).
 *
 * This is the oracle that ships *before* postconditions exist (foundation §5.3). It is not a
 * consolation prize: it exercises the generation foundation end-to-end at the lowest available risk,
 * the same move that made documentation the first projection built (IDEA-7). It blocks on nothing —
 * not Q-11, not IDEA-4 — because DEC-021 already established that **a field constraint is a class
 * invariant**, so a real invariant check is available today.
 *
 * ## What it actually checks — stated precisely, and not oversold (the task's explicit ask)
 *
 * For every generated, **precondition-valid** argument tuple it asserts three things, and it is worth
 * being exact about the delta each adds over what adorn already does:
 *
 *   1. **Robustness — the method does not throw unexpectedly.** This is classic crash-finding and is
 *      the oracle's *primary* value: a method whose contract admits an edge value (`min: 0` admits
 *      `0`, `notEmpty` admits a 10 000-char string) can still crash on it. Nothing else in adorn
 *      catches this.
 *   2. **No adorn contract violation on valid input.** We generated inputs the preconditions accept,
 *      so a raised violation means either a generation-soundness bug (there are none by §4.1) or a
 *      genuine enforcement surprise (e.g. an inherited bound resolving differently than expected).
 *   3. **Invariant preservation — every field contract still holds on the receiver afterwards.**
 *
 * **The honest delta of (3).** Field accessors already enforce their constraint on *every assignment*
 * (DEC-021), so an ordinary `this.x = bad` throws at the point of assignment — and is then caught by
 * (1) as a throw, not by (3). So the invariant re-check adds coverage over (1) only where state
 * reaches a contracted field **without passing through the validating accessor**: a mutation via
 * `Object.defineProperty`, a shared sub-object the constraint reasons about, a field recorded but not
 * installed, or state seeded before the accessor was attached. That is a real but *narrow* set, and
 * the re-check is here to catch exactly it — not to imply that "invariants preserved" is a strong
 * statement on its own. In the common case (1) does the catching and (3) is a belt.
 *
 * ## What it does NOT do (foundation §7, §8)
 *
 * It does not check *correctness* — without postconditions there is no "was the answer right?", only
 * "did it crash / break an invariant?". It samples; it does not prove. It runs the **real** method,
 * side effects and all — it does not sandbox, cap, or vet (foundation §7.3, DEC-025). Those limits
 * are surfaced by {@link module:report}, never hidden.
 */

import * as fc from 'fast-check';
import {ConstraintDescriptor} from '../../src/Core/Descriptor';
import {
    ClassFieldContract,
    ClassMethodContract,
    getContractsForClass,
    getFieldContractsForClass,
} from '../../src/Core/ContractRegistry';
import {arbitraryForParameter, Arbitrary, ParameterArbitrary} from './arbitraries';

/** Only one oracle mode exists in Phase A. Phase B adds `'postcondition'` (Q-11 / IDEA-4). */
export type OracleMode = 'weak-invariant';

export type FindingType = 'unexpected-throw' | 'contract-violation' | 'invariant-violation';

/** A reproducible counterexample. The seed is the whole point — a finding you cannot replay is noise. */
export interface FuzzFinding {
    readonly type: FindingType;
    readonly message: string;
    /** The (shrunk) argument tuple that triggered it. */
    readonly counterexample: ReadonlyArray<unknown>;
    /** fast-check's seed — replay with `fuzzMethod({..., seed})` to reproduce exactly. */
    readonly seed: number;
    readonly numShrinks: number;
    /** For an `invariant-violation`: which field, and which constraint on it, broke. */
    readonly field?: string;
    readonly constraint?: string;
}

export interface FuzzResult {
    readonly target: string;
    readonly method: string;
    readonly isStatic: boolean;
    readonly oracle: OracleMode;
    /** True when the method could not be fuzzed at all — see {@link reason}. */
    readonly declined: boolean;
    readonly reason?: string;
    readonly numRuns: number;
    /** The seed used, so a clean run is reproducible too. */
    readonly seed?: number;
    /** Per-parameter coverage — what was generated for, how, and what was gap-filled or declined. */
    readonly coverage: ReadonlyArray<ParameterArbitrary>;
    /** The field contracts re-checked as invariants after each call. */
    readonly invariantsChecked: ReadonlyArray<string>;
    /** True when the oracle ran and found nothing. Distinct from `declined` (never ran). */
    readonly passed: boolean;
    readonly finding?: FuzzFinding;
    /** Everything the developer cannot see: starvation, side effects, "fuzzed ≠ proved". */
    readonly warnings: ReadonlyArray<string>;
}

export interface FuzzOptions {
    /** The contracted class. */
    readonly target: Function;
    /** The method to fuzz. */
    readonly method: string | symbol;
    /**
     * A factory for a fresh receiver instance, called once per generated case so state never leaks
     * between runs. **Required for an instance method** — adorn cannot invent a constructor for an
     * arbitrary class, and says so rather than guessing (a declined result, not a silent skip).
     */
    readonly subject?: () => object;
    /** Cases to run. Defaults to 100. Not a nanny cap — raise it freely (foundation §7.3). */
    readonly numRuns?: number;
    /** Fix the seed to reproduce a run exactly. Omitted, fast-check picks one and it is reported. */
    readonly seed?: number;
    /** The arbitrary for undecorated positions. Defaults to `fc.anything()` — broad by design (§8). */
    readonly gapFill?: Arbitrary<unknown>;
}

/** The standing disclaimers every run carries — the warn-vs-trust line drawn in plain words (§7). */
const STANDING_WARNINGS: ReadonlyArray<string> = [
    'Fuzzing runs the REAL method with generated inputs, many times. If it sends email, charges a ' +
        'card, or writes to a database, those effects are real and irreversible (foundation §7.2).',
    'A clean run means "no generated input crashed it or broke a field invariant" — NOT "correct" ' +
        'and NOT "proved". Property-based testing samples; it does not verify (foundation §7.1).',
];

/**
 * Fuzz one contracted method with the weak invariant oracle.
 *
 * Never throws for an un-fuzzable method: it returns a `declined` result naming why, so "declined"
 * and "clean" are always distinguishable in the report — the report-own-boundary discipline (§3).
 */
export function fuzzMethod(options: FuzzOptions): FuzzResult {
    const {target, method, subject, numRuns = 100, seed, gapFill = fc.anything()} = options;
    const className = target.name || '(anonymous class)';
    const methodName = String(method);

    const entry = findMethodEntry(target, method);
    if (!entry) {
        return declinedResult(
            className,
            methodName,
            false,
            [],
            `no contract recorded for ${className}.${methodName}`,
        );
    }

    const isStatic = entry.isStatic;
    if (!isStatic && !subject) {
        return declinedResult(
            className,
            methodName,
            isStatic,
            buildCoverage(entry),
            `${className}.${methodName} is an instance method — pass \`subject: () => new ${className}(...)\``,
        );
    }

    const coverage = buildCoverage(entry);

    // A declined position means we cannot produce precondition-valid inputs for the whole tuple.
    const declinedPosition = coverage.find(plan => plan.declined);
    if (declinedPosition) {
        return declinedResult(
            className,
            methodName,
            isStatic,
            coverage,
            `parameter ${declinedPosition.index}` +
                `${declinedPosition.name ? ` ('${declinedPosition.name}')` : ''} could not be generated: ` +
                (declinedPosition.note || 'no sound generator'),
        );
    }

    const argsArbitrary = buildArgsArbitrary(coverage, gapFill);
    const fieldContracts = isStatic ? [] : instanceFieldContracts(target);
    const invariantsChecked = fieldContracts.map(f => String(f.key));

    const runOracle = (args: unknown[]): boolean =>
        oracleOutcome(args, isStatic, target, method, subject, fieldContracts) === null;

    let details: fc.RunDetails<[unknown[]]>;
    try {
        details = fc.check(
            fc.property(argsArbitrary, (args: unknown[]) => runOracle(args)),
            seed === undefined ? {numRuns} : {numRuns, seed},
        );
    } catch (error) {
        // A per-position filter that cannot produce a value makes fast-check throw. Report it as
        // starvation rather than letting the tool crash (foundation §7.2), and decline honestly.
        return declinedResult(
            className,
            methodName,
            isStatic,
            coverage,
            `generation starved: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const warnings = collectWarnings(coverage);

    if (!details.failed) {
        return {
            target: className,
            method: methodName,
            isStatic,
            oracle: 'weak-invariant',
            declined: false,
            numRuns: details.numRuns,
            seed: details.seed,
            coverage,
            invariantsChecked,
            passed: true,
            warnings,
        };
    }

    // Re-run the oracle once on the shrunk counterexample to classify the finding deterministically.
    const counterexampleArgs = (details.counterexample ? details.counterexample[0] : []) as unknown[];
    const outcome = oracleOutcome(counterexampleArgs, isStatic, target, method, subject, fieldContracts);
    const finding = describeFinding(outcome, counterexampleArgs, details);

    return {
        target: className,
        method: methodName,
        isStatic,
        oracle: 'weak-invariant',
        declined: false,
        numRuns: details.numRuns,
        seed: details.seed,
        coverage,
        invariantsChecked,
        passed: false,
        finding,
        warnings,
    };
}

/**
 * Fuzz every contracted method of a class (both bands, inheritance included — {@link getContractsForClass}).
 * Instance methods are skipped-as-declined unless a `subject` factory is supplied.
 */
export function fuzzClass(
    target: Function,
    options: Omit<FuzzOptions, 'target' | 'method'> = {},
): FuzzResult[] {
    return getContractsForClass(target).map(entry => fuzzMethod({...options, target, method: entry.key}));
}

// ---------------------------------------------------------------------------
// The oracle body
// ---------------------------------------------------------------------------

/**
 * Run the method once and evaluate the oracle. Returns `null` when the call is clean (no throw, every
 * field invariant preserved), or a structured outcome describing the first violation found. Used both
 * as the property body (via `=== null`) and, on the shrunk counterexample, to classify the finding.
 */
function oracleOutcome(
    args: unknown[],
    isStatic: boolean,
    target: Function,
    method: string | symbol,
    subject: (() => object) | undefined,
    fieldContracts: ReadonlyArray<ClassFieldContract>,
): OracleOutcome | null {
    const receiver: object = isStatic ? target : subject!();

    try {
        invoke(receiver, method, args);
    } catch (error) {
        return {
            type: isAdornViolation(error) ? 'contract-violation' : 'unexpected-throw',
            message: error instanceof Error ? error.message : String(error),
        };
    }

    if (!isStatic) {
        for (const field of fieldContracts) {
            const value = readField(receiver, field.key);
            for (const constraint of field.contract.constraints) {
                if (!constraint.predicate(value)) {
                    return {
                        type: 'invariant-violation',
                        message:
                            `field '${String(field.key)}' violates ${constraint.constraint} after the call ` +
                            `(${constraint.describe()})`,
                        field: String(field.key),
                        constraint: constraint.constraint,
                    };
                }
            }
        }
    }

    return null;
}

interface OracleOutcome {
    readonly type: FindingType;
    readonly message: string;
    readonly field?: string;
    readonly constraint?: string;
}

function describeFinding(
    outcome: OracleOutcome | null,
    counterexample: unknown[],
    details: fc.RunDetails<[unknown[]]>,
): FuzzFinding {
    // `outcome` can be null only if the method is nondeterministic and the failure did not reproduce.
    if (!outcome) {
        return {
            type: 'unexpected-throw',
            message:
                'a failure was found but did not reproduce on re-run — the method is likely ' +
                'nondeterministic (state, time, randomness). Fix the method to be deterministic to shrink it.',
            counterexample,
            seed: details.seed,
            numShrinks: details.numShrinks,
        };
    }
    return {
        type: outcome.type,
        message: outcome.message,
        counterexample,
        seed: details.seed,
        numShrinks: details.numShrinks,
        field: outcome.field,
        constraint: outcome.constraint,
    };
}

// ---------------------------------------------------------------------------
// Coverage & argument tuple construction
// ---------------------------------------------------------------------------

/**
 * Build the per-position coverage plan for a method. `entry.contract.params` describes every position
 * the registry knows — including undecorated ones the adapter named (BUG-14/Q-10) — so a position with
 * no constraints becomes a `gap-fill`, and one the registry never saw at all is filled positionally.
 */
function buildCoverage(entry: ClassMethodContract): ParameterArbitrary[] {
    const params = entry.contract.params;
    let highest = -1;
    params.forEach(p => {
        if (p.index > highest) highest = p.index;
    });

    const coverage: ParameterArbitrary[] = [];
    for (let index = 0; index <= highest; index++) {
        const match = params.filter(p => p.index === index)[0];
        const constraints: ReadonlyArray<ConstraintDescriptor> = match ? match.constraints : [];
        coverage.push(arbitraryForParameter(constraints, index, match ? match.name : undefined));
    }
    return coverage;
}

/** Compose the per-position arbitraries into the argument tuple, gap-filling positions with no generator. */
function buildArgsArbitrary(
    coverage: ReadonlyArray<ParameterArbitrary>,
    gapFill: Arbitrary<unknown>,
): Arbitrary<unknown[]> {
    if (coverage.length === 0) return fc.constant([] as unknown[]);
    const positions = coverage.map(plan => plan.arbitrary ?? gapFill);
    return fc.tuple(...positions);
}

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------

function findMethodEntry(target: Function, method: string | symbol): ClassMethodContract | undefined {
    return getContractsForClass(target).filter(e => e.key === method)[0];
}

function instanceFieldContracts(target: Function): ClassFieldContract[] {
    return getFieldContractsForClass(target).filter(f => !f.isStatic);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function invoke(receiver: object, method: string | symbol, args: unknown[]): void {
    (receiver as Record<string | symbol, (...a: unknown[]) => unknown>)[method](...args);
}

function readField(receiver: object, key: string | symbol): unknown {
    return (receiver as Record<string | symbol, unknown>)[key];
}

/**
 * Whether a thrown value is an adorn contract violation, as opposed to an error from the method body.
 * adorn's enforcement throws `new Error('Value Error: …')` (`Descriptor.formatMessage`), so the prefix
 * is the tell. Heuristic and tied to that message shape — noted here so it travels if the shape changes.
 */
function isAdornViolation(error: unknown): boolean {
    return (
        error instanceof Error &&
        typeof error.message === 'string' &&
        error.message.startsWith('Value Error:')
    );
}

function collectWarnings(coverage: ReadonlyArray<ParameterArbitrary>): string[] {
    const warnings: string[] = [...STANDING_WARNINGS];
    for (const plan of coverage) {
        if (plan.starved) {
            warnings.push(
                `parameter ${plan.index}${plan.name ? ` ('${plan.name}')` : ''}: generate-and-filter ` +
                    `accepts only ${Math.round((plan.acceptanceRate ?? 0) * 100)}% of candidates — the run ` +
                    'may cover far fewer distinct values than its case count suggests (foundation §7.2).',
            );
        }
    }
    return warnings;
}

function declinedResult(
    target: string,
    method: string,
    isStatic: boolean,
    coverage: ReadonlyArray<ParameterArbitrary>,
    reason: string,
): FuzzResult {
    return {
        target,
        method,
        isStatic,
        oracle: 'weak-invariant',
        declined: true,
        reason,
        numRuns: 0,
        coverage,
        invariantsChecked: [],
        passed: false,
        warnings: [],
    };
}
