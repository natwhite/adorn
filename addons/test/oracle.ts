/**
 * `@adorn/test` — the contract oracle (Fuzzing Phase B), built on Phase A's weak invariant floor.
 *
 * Phase A shipped a **weak invariant oracle** (foundation §5.3): generate precondition-valid inputs,
 * run the method, assert it does not throw and that every field invariant still holds. It could not
 * ask "was the answer right?" because no postcondition existed to compare against.
 *
 * Phase B (DEC-034) adds the missing half. For every generated, accepted input it now also checks the
 * method's **postconditions**, consuming BOTH postcondition bands exactly as the runtime wrapper does
 * (`ContractInstaller.enforcementBehavior`), through the SAME functions enforcement runs — so the
 * oracle the fuzzer *checks* is byte-for-byte the oracle enforcement *enforces* (DEC-032, no drift):
 *
 *   - **Reified `@Returns` descriptor band** (DEC-033): `getEffectiveContract(target, key).post` →
 *     `descriptor.predicate(result)` per descriptor, the reified band checked **first** (mirroring the
 *     wrapper's cross-band order). A `false` is a counterexample; the descriptor's own `message()`
 *     describes it.
 *   - **`@Ensures` closure band** (DEC-032): `getEffectivePostconditions(target, key)` →
 *     `evaluatePostconditions(posts, result, args)` — the exact evaluator the wrapper calls. `!ok` is a
 *     counterexample. A postcondition that *throws* is reported as an oracle bug, not mistaken for the
 *     method bug it hunts (foundation §5.2 pt 1) — `evaluatePostconditions` already carries the throw.
 *
 * These three functions are imported from **`adorn` (the package root)**, not reached out of `src/`,
 * so the add-on consumes the public surface exactly as a real downstream consumer would.
 *
 * ## How the settled value is obtained (the one subtlety)
 *
 * The fuzzer runs the REAL, `@Contract()`-installed method. Under the default policy the installed
 * wrapper *itself* throws on a postcondition violation — which would deny the driver the return value
 * it needs to check independently, and would surface a postcondition break as an opaque throw. So in
 * postcondition mode the driver suppresses **assert-trust** enforcement for the duration of the run
 * (`setAssertEnforcement(false)` — postconditions are fixed at `assert`, `POSTCONDITION_TRUST`), which
 * makes the wrapper return the raw settled value un-post-checked, and the driver then evaluates BOTH
 * bands itself on that value. Precondition **guard** enforcement is untouched, so a generation-soundness
 * surprise still surfaces as a `contract-violation` (the Phase A floor is preserved verbatim). This is
 * why "a throw skips postconditions" holds here exactly as in the wrapper: a throw during a suppressed
 * run is a genuine method crash, never a post-check throw. Weak-invariant-mode runs suppress nothing —
 * Phase A behaviour is bit-for-bit unchanged for methods with no postcondition.
 *
 * ## The floor still stands (IDEA-4 / Q-3)
 *
 * A method with NO postconditions of either band still gets Phase A's generation + doesn't-throw +
 * field-invariant re-check, and nothing more. Auto oracle-mode keys purely on "any effective
 * postcondition (either band) present". Phase B *adds* the postcondition oracle; it does not replace
 * the floor, and it does not — per scope — attempt cross-parameter constraint generation (IDEA-6).
 *
 * ## What it still does NOT do (foundation §7, §8)
 *
 * It samples; it does not prove. It runs the **real** method, side effects and all — no sandbox, no cap
 * (foundation §7.3, DEC-025). A green postcondition run means "the checked postconditions held over N
 * sampled inputs", which is why {@link FuzzResult.oraclesChecked} names *what* was checked — a green
 * result that cannot say what it verified over-claims (foundation §5.2 pt 3). These limits are surfaced
 * by {@link module:report}, never hidden.
 */

import * as fc from 'fast-check';
import {ConstraintDescriptor} from '../../src/Core/Descriptor';
import {
    ClassFieldContract,
    ClassMethodContract,
    getContractsForClass,
    getFieldContractsForClass,
    Postcondition,
} from '../../src/Core/ContractRegistry';
// The postcondition oracle — consumed from adorn's PUBLIC surface (the package root), so the add-on
// checks postconditions through the SAME functions the runtime wrapper runs (DEC-032/DEC-034 no drift):
// the `@Ensures` closure band via getEffectivePostconditions + evaluatePostconditions, and the reified
// `@Returns` descriptor band via getEffectiveContract().post. Reaching into `src/` for these would make
// the add-on a privileged consumer; it is not — it depends on exactly what a downstream package sees.
import {evaluatePostconditions, getEffectiveContract, getEffectivePostconditions} from '../../index';
// The same disclosure discipline core uses for its own emissions (DEC-030) — imported, not
// re-implemented, so a fuzz report redacts by exactly the rule enforcement redacts by. Not on the root
// surface (Q-6 keeps it internal), so read from its module, as the add-on already does for descriptors.
import {REDACTED, shouldDiscloseValue} from '../../src/Core/redaction';
// The assert-trust gate — read/restored around a postcondition-mode run so the driver can obtain the
// settled return value to check it independently. See the header note ("How the settled value ...").
import {getAssertEnforcement, setAssertEnforcement} from '../../src/Core/Configuration';
import {arbitraryForParameter, Arbitrary, ParameterArbitrary} from './arbitraries';

/**
 * The oracle in force for a run.
 *
 * - `'weak-invariant'` — Phase A: doesn't-throw + field-invariant preservation (the floor, IDEA-4).
 * - `'postcondition'` — Phase B: the floor PLUS both postcondition bands (DEC-034).
 */
export type OracleMode = 'weak-invariant' | 'postcondition';

export type FindingType =
    'unexpected-throw' | 'contract-violation' | 'invariant-violation' | 'postcondition-violation';

/** A reproducible counterexample. The seed is the whole point — a finding you cannot replay is noise. */
export interface FuzzFinding {
    readonly type: FindingType;
    readonly message: string;
    /** The (shrunk) argument tuple that triggered it. Kept raw for programmatic replay; the *report*
     *  redacts it by default (DEC-030) — see {@link module:report}. */
    readonly counterexample: ReadonlyArray<unknown>;
    /** fast-check's seed — replay with `fuzzMethod({..., seed})` to reproduce exactly. */
    readonly seed: number;
    readonly numShrinks: number;
    /** fast-check's shrink path — the value-free replay coordinate the redacted report prints instead
     *  of the raw counterexample (`fc.check({..., path})` reproduces the exact case). */
    readonly path?: string;
    /** For an `invariant-violation`: which field, and which constraint on it, broke. */
    readonly field?: string;
    readonly constraint?: string;
    /** For a `postcondition-violation`: the broken guarantee, named — a reified descriptor's
     *  `describe()` or a closure's `description` (or a placeholder for an anonymous closure). */
    readonly postconditionDescription?: string;
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
    /**
     * The postcondition guarantees this run exercised — reified `@Returns` `describe()`s and `@Ensures`
     * descriptions. The honest "what I checked" a green postcondition result needs so it does not
     * over-claim (foundation §5.2 pt 3). Empty in weak-invariant mode.
     */
    readonly oraclesChecked: ReadonlyArray<string>;
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
    /**
     * Override the oracle. Default is **auto**: `'postcondition'` when the method has any effective
     * postcondition (closure band non-empty OR reified `post` band non-empty), else `'weak-invariant'`.
     * Auto keeps Phase A behaviour for methods with no oracle and upgrades automatically once a
     * postcondition exists. Force `'weak-invariant'` to skip the postcondition oracle deliberately.
     */
    readonly oracle?: OracleMode;
}

/** The standing disclaimers every run carries — the warn-vs-trust line drawn in plain words (§7). */
const STANDING_WARNINGS: ReadonlyArray<string> = [
    'Fuzzing runs the REAL method with generated inputs, many times. If it sends email, charges a ' +
        'card, or writes to a database, those effects are real and irreversible (foundation §7.2).',
    'A clean run means "no generated input crashed it, broke a field invariant, or broke a checked ' +
        'postcondition" — NOT "correct" and NOT "proved". Property-based testing samples; it does not ' +
        'verify (foundation §7.1).',
];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Fuzz one contracted method with the contract oracle (postcondition oracle when a postcondition
 * exists, weak-invariant floor otherwise — {@link FuzzOptions.oracle}).
 *
 * Synchronous. If the method returns a thenable it is **declined** with a clear "use fuzzMethodAsync"
 * message rather than silently checking the Promise object as if it were the answer (the
 * number-that-looks-like-an-answer trap `@Time`/DEC-032 guard against). Never throws for an un-fuzzable
 * method: it returns a `declined` result naming why, so "declined" and "clean" stay distinguishable (§3).
 */
export function fuzzMethod(options: FuzzOptions): FuzzResult {
    const p = prepareRun(options);
    if (p.declined) return p.declined;

    let details: fc.RunDetails<[unknown[]]>;
    try {
        details = withPostconditionProbe(p.mode, () =>
            fc.check(
                fc.property(p.argsArbitrary, (args: unknown[]) => oracleOutcomeSync(args, p.ctx) === null),
                p.seed === undefined ? {numRuns: p.numRuns} : {numRuns: p.numRuns, seed: p.seed},
            ),
        );
    } catch (error) {
        // A per-position filter that cannot produce a value makes fast-check throw. Report it as
        // starvation rather than letting the tool crash (foundation §7.2), and decline honestly.
        return declinedResult(
            p.className,
            p.methodName,
            p.isStatic,
            p.coverage,
            `generation starved: ${error instanceof Error ? error.message : String(error)}`,
            p.oraclesChecked,
            p.mode,
        );
    }

    if (p.ctx.sawThenable) {
        return declinedResult(
            p.className,
            p.methodName,
            p.isStatic,
            p.coverage,
            'method returns a thenable — it is async; use fuzzMethodAsync() to await and check the settled value',
            p.oraclesChecked,
            p.mode,
        );
    }

    if (!details.failed) return assemblePassed(p, details);

    // Re-run the oracle once on the shrunk counterexample to classify the finding deterministically,
    // under the same suppression so a postcondition break yields its value rather than a wrapper throw.
    const counterexampleArgs = (details.counterexample ? details.counterexample[0] : []) as unknown[];
    const outcome = withPostconditionProbe(p.mode, () => oracleOutcomeSync(counterexampleArgs, p.ctx));
    return assembleFinding(p, details, outcome, counterexampleArgs);
}

/**
 * The async twin of {@link fuzzMethod} — for a method that returns a Promise (or any thenable).
 *
 * Uses `fc.asyncProperty` and awaits the settled value before the oracle, mirroring the installer's
 * `isThenable` branch: a rejected Promise skips both postcondition bands and is reported as a
 * robustness finding (the async twin of a sync throw), never a false postcondition pass. It also
 * handles a synchronous return, so it is a safe superset of `fuzzMethod` for a method whose synchrony
 * is unknown; `fuzzMethod` stays the sync entry that declines an async method loudly.
 */
export async function fuzzMethodAsync(options: FuzzOptions): Promise<FuzzResult> {
    const p = prepareRun(options);
    if (p.declined) return p.declined;

    let details: fc.RunDetails<[unknown[]]>;
    try {
        details = await withPostconditionProbeAsync(p.mode, () =>
            fc.check(
                fc.asyncProperty(
                    p.argsArbitrary,
                    async (args: unknown[]) => (await oracleOutcomeAsync(args, p.ctx)) === null,
                ),
                p.seed === undefined ? {numRuns: p.numRuns} : {numRuns: p.numRuns, seed: p.seed},
            ),
        );
    } catch (error) {
        return declinedResult(
            p.className,
            p.methodName,
            p.isStatic,
            p.coverage,
            `generation starved: ${error instanceof Error ? error.message : String(error)}`,
            p.oraclesChecked,
            p.mode,
        );
    }

    if (!details.failed) return assemblePassed(p, details);

    const counterexampleArgs = (details.counterexample ? details.counterexample[0] : []) as unknown[];
    const outcome = await withPostconditionProbeAsync(p.mode, () =>
        oracleOutcomeAsync(counterexampleArgs, p.ctx),
    );
    return assembleFinding(p, details, outcome, counterexampleArgs);
}

/**
 * Fuzz every contracted method of a class (both key bands, inheritance included —
 * {@link getContractsForClass}). Instance methods are skipped-as-declined unless a `subject` factory is
 * supplied. Each method picks its own oracle by auto-mode.
 */
export function fuzzClass(
    target: Function,
    options: Omit<FuzzOptions, 'target' | 'method'> = {},
): FuzzResult[] {
    return getContractsForClass(target).map(entry => fuzzMethod({...options, target, method: entry.key}));
}

/**
 * The async twin of {@link fuzzClass}. Awaits each method **sequentially** rather than with
 * `Promise.all`: a postcondition-mode run toggles the process-wide assert gate for its duration, so
 * overlapping runs would race that global — sequential keeps each run's suppression window its own.
 */
export async function fuzzClassAsync(
    target: Function,
    options: Omit<FuzzOptions, 'target' | 'method'> = {},
): Promise<FuzzResult[]> {
    const results: FuzzResult[] = [];
    for (const entry of getContractsForClass(target)) {
        results.push(await fuzzMethodAsync({...options, target, method: entry.key}));
    }
    return results;
}

// ---------------------------------------------------------------------------
// Run preparation (shared by the sync and async entry points)
// ---------------------------------------------------------------------------

/** Everything a run needs, or a `declined` result to return immediately. */
interface PreparedRun {
    declined?: FuzzResult;
    ctx?: OracleContext;
    coverage?: ParameterArbitrary[];
    argsArbitrary?: Arbitrary<unknown[]>;
    mode?: OracleMode;
    oraclesChecked?: string[];
    className?: string;
    methodName?: string;
    isStatic?: boolean;
    invariantsChecked?: string[];
    seed?: number;
    numRuns?: number;
}

function prepareRun(options: FuzzOptions): PreparedRun {
    const {target, method, subject, numRuns = 100, seed, gapFill = fc.anything(), oracle} = options;
    const className = target.name || '(anonymous class)';
    const methodName = String(method);

    const entry = findMethodEntry(target, method);
    if (!entry) {
        return {
            declined: declinedResult(
                className,
                methodName,
                false,
                [],
                `no contract recorded for ${className}.${methodName}`,
                [],
                'weak-invariant',
            ),
        };
    }

    const isStatic = entry.isStatic;
    if (!isStatic && !subject) {
        return {
            declined: declinedResult(
                className,
                methodName,
                isStatic,
                buildCoverage(entry),
                `${className}.${methodName} is an instance method — pass \`subject: () => new ${className}(...)\``,
                [],
                'weak-invariant',
            ),
        };
    }

    const coverage = buildCoverage(entry);

    // A declined position means we cannot produce precondition-valid inputs for the whole tuple.
    const declinedPosition = coverage.find(plan => plan.declined);
    if (declinedPosition) {
        return {
            declined: declinedResult(
                className,
                methodName,
                isStatic,
                coverage,
                `parameter ${declinedPosition.index}` +
                    `${declinedPosition.name ? ` ('${declinedPosition.name}')` : ''} could not be generated: ` +
                    (declinedPosition.note || 'no sound generator'),
                [],
                'weak-invariant',
            ),
        };
    }

    // Both postcondition bands, read effectively (inheritance-unioned) — exactly what enforcement plans
    // from. `entry.contract.post` is the reified `@Returns` band `getEffectiveContract` already unioned
    // base-most-first; the closure band is read the same way enforcement does.
    const returns = entry.contract.post;
    const posts = getEffectivePostconditions(entry.target, method);

    // Auto oracle-mode: postcondition when either band is present, else the weak-invariant floor.
    const mode: OracleMode =
        oracle ?? (posts.length > 0 || returns.length > 0 ? 'postcondition' : 'weak-invariant');
    const oraclesChecked = describeOracles(posts, returns);

    const argsArbitrary = buildArgsArbitrary(coverage, gapFill);
    const fieldContracts = isStatic ? [] : instanceFieldContracts(target);
    const invariantsChecked = fieldContracts.map(f => String(f.key));

    const ctx: OracleContext = {
        isStatic,
        target,
        method,
        subject,
        fieldContracts,
        mode,
        posts,
        returns,
        sawThenable: false,
    };

    return {
        ctx,
        coverage,
        argsArbitrary,
        mode,
        oraclesChecked,
        className,
        methodName,
        isStatic,
        invariantsChecked,
        seed,
        numRuns,
    };
}

function assemblePassed(p: PreparedRun, details: fc.RunDetails<[unknown[]]>): FuzzResult {
    return {
        target: p.className,
        method: p.methodName,
        isStatic: p.isStatic,
        oracle: p.mode,
        declined: false,
        numRuns: details.numRuns,
        seed: details.seed,
        coverage: p.coverage,
        invariantsChecked: p.invariantsChecked,
        oraclesChecked: p.oraclesChecked,
        passed: true,
        warnings: collectWarnings(p.coverage),
    };
}

function assembleFinding(
    p: PreparedRun,
    details: fc.RunDetails<[unknown[]]>,
    outcome: OracleOutcome | null,
    counterexampleArgs: unknown[],
): FuzzResult {
    return {
        target: p.className,
        method: p.methodName,
        isStatic: p.isStatic,
        oracle: p.mode,
        declined: false,
        numRuns: details.numRuns,
        seed: details.seed,
        coverage: p.coverage,
        invariantsChecked: p.invariantsChecked,
        oraclesChecked: p.oraclesChecked,
        passed: false,
        finding: describeFinding(outcome, counterexampleArgs, details),
        warnings: collectWarnings(p.coverage),
    };
}

// ---------------------------------------------------------------------------
// The oracle body
// ---------------------------------------------------------------------------

/** The immutable facts of a run, plus the one mutable async-detection flag (`sawThenable`). */
interface OracleContext {
    readonly isStatic: boolean;
    readonly target: Function;
    readonly method: string | symbol;
    readonly subject?: () => object;
    readonly fieldContracts: ReadonlyArray<ClassFieldContract>;
    readonly mode: OracleMode;
    readonly posts: ReadonlyArray<Postcondition>;
    readonly returns: ReadonlyArray<ConstraintDescriptor>;
    /** Set by the sync oracle when it observes a thenable return — the run then declines as async. */
    sawThenable: boolean;
}

interface OracleOutcome {
    readonly type: FindingType;
    readonly message: string;
    readonly field?: string;
    readonly constraint?: string;
    readonly postconditionDescription?: string;
}

/**
 * Run the method once, synchronously, and evaluate the oracle. Returns `null` when the call is clean,
 * or a structured outcome describing the first violation found. A thenable return cannot be settled
 * synchronously, so it flags the context (the run declines with a "use fuzzMethodAsync" message) rather
 * than checking the Promise object as if it were the value.
 */
function oracleOutcomeSync(args: unknown[], ctx: OracleContext): OracleOutcome | null {
    const receiver: object = ctx.isStatic ? ctx.target : ctx.subject!();

    let result: unknown;
    try {
        result = invoke(receiver, ctx.method, args);
    } catch (error) {
        return classifyThrow(error);
    }

    if (isThenable(result)) {
        ctx.sawThenable = true;
        return null;
    }

    return checkSettled(receiver, result, args, ctx);
}

/**
 * The async twin of {@link oracleOutcomeSync}: awaits a thenable return before checking, mirroring the
 * installer's `isThenable` branch. A rejected Promise skips both postcondition bands and is reported as
 * a robustness finding (the async twin of a sync throw). A synchronous return is checked directly.
 */
async function oracleOutcomeAsync(args: unknown[], ctx: OracleContext): Promise<OracleOutcome | null> {
    const receiver: object = ctx.isStatic ? ctx.target : ctx.subject!();

    let result: unknown;
    try {
        result = invoke(receiver, ctx.method, args);
    } catch (error) {
        return classifyThrow(error);
    }

    if (isThenable(result)) {
        let settled: unknown;
        try {
            settled = await Promise.resolve(result);
        } catch (error) {
            return classifyThrow(error);
        }
        return checkSettled(receiver, settled, args, ctx);
    }

    return checkSettled(receiver, result, args, ctx);
}

/**
 * Check a settled (non-thenable) outcome: the weak-invariant floor (field invariants, both modes), then
 * — only in postcondition mode — the postcondition oracle. This is where "layering, not replacement"
 * lives: the postcondition oracle is the floor PLUS the two bands, checked only on a non-throwing run,
 * exactly as enforcement checks postconditions only after a clean `proceed()`.
 */
function checkSettled(
    receiver: object,
    result: unknown,
    args: unknown[],
    ctx: OracleContext,
): OracleOutcome | null {
    if (!ctx.isStatic) {
        const invariant = checkFieldInvariants(receiver, ctx.fieldContracts);
        if (invariant) return invariant;
    }

    if (ctx.mode === 'postcondition') {
        return checkPostconditionBands(result, args, ctx);
    }

    return null;
}

/** The Phase A field-invariant re-check, factored out so both modes share it. */
function checkFieldInvariants(
    receiver: object,
    fieldContracts: ReadonlyArray<ClassFieldContract>,
): OracleOutcome | null {
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
    return null;
}

/**
 * The Phase B postcondition oracle — BOTH bands, consumed exactly as
 * `ContractInstaller.enforcementBehavior` does, on the same settled value (DEC-034 no drift):
 *
 *   1. reified `@Returns` descriptor band FIRST (DEC-033) — the same `descriptor.predicate` the wrapper
 *      runs (DEC-010), the same base-most-first order, the descriptor's own redaction-by-default message;
 *   2. `@Ensures` closure band SECOND — via the EXACT {@link evaluatePostconditions} the wrapper calls.
 *
 * First-failure-wins across the two bands, reified first, so the most structured broken guarantee is
 * reported. A postcondition that *threw* is surfaced as a postcondition-violation naming the thrown
 * value, so a buggy oracle is not mistaken for the bug it hunts (foundation §5.2 pt 1).
 */
function checkPostconditionBands(result: unknown, args: unknown[], ctx: OracleContext): OracleOutcome | null {
    for (const descriptor of ctx.returns) {
        if (descriptor.predicate(result)) continue;
        return {
            type: 'postcondition-violation',
            message: descriptor.message({
                value: result,
                paramName: 'return value',
                disclose: shouldDiscloseValue(false),
            }),
            postconditionDescription: descriptor.describe(),
        };
    }

    const outcome = evaluatePostconditions(ctx.posts, result, args);
    if (outcome.ok || !outcome.failed) return null;

    const description = outcome.failed.description || '(anonymous closure postcondition)';
    const message =
        outcome.error !== undefined
            ? `postcondition "${description}" THREW while being evaluated: ` +
              `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)} ` +
              '— a bug in the postcondition itself, not necessarily in the method'
            : `postcondition "${description}" did not hold; returned ${renderReturned(result)}`;

    return {type: 'postcondition-violation', message, postconditionDescription: description};
}

/** Classify a thrown value: an adorn contract violation vs an error from the method body. */
function classifyThrow(error: unknown): OracleOutcome {
    return {
        type: isAdornViolation(error) ? 'contract-violation' : 'unexpected-throw',
        message: error instanceof Error ? error.message : String(error),
    };
}

/** Render a returned value for a message, redacted by default (DEC-030) — the same rule the wrapper uses. */
function renderReturned(result: unknown): string {
    return shouldDiscloseValue(false) ? String(result) : REDACTED;
}

function describeFinding(
    outcome: OracleOutcome | null,
    counterexample: unknown[],
    details: fc.RunDetails<[unknown[]]>,
): FuzzFinding {
    const path = counterexamplePathOf(details);

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
            path,
        };
    }
    return {
        type: outcome.type,
        message: outcome.message,
        counterexample,
        seed: details.seed,
        numShrinks: details.numShrinks,
        path,
        field: outcome.field,
        constraint: outcome.constraint,
        postconditionDescription: outcome.postconditionDescription,
    };
}

// ---------------------------------------------------------------------------
// Assert-gate suppression (so a postcondition-mode run can read the settled value)
// ---------------------------------------------------------------------------

/**
 * Run `run` with **assert-trust** enforcement suppressed when in postcondition mode, restoring the
 * prior gate afterwards. Postconditions are fixed at `assert` (`POSTCONDITION_TRUST`), so this makes the
 * installed wrapper hand back the raw settled value un-post-checked, letting the driver evaluate both
 * bands itself. Precondition **guard** enforcement is untouched. A weak-invariant run suppresses nothing.
 */
function withPostconditionProbe<T>(mode: OracleMode, run: () => T): T {
    if (mode !== 'postcondition') return run();
    const previous = getAssertEnforcement();
    setAssertEnforcement(false);
    try {
        return run();
    } finally {
        setAssertEnforcement(previous);
    }
}

/** The async twin of {@link withPostconditionProbe}, holding the gate off across the awaited run. */
async function withPostconditionProbeAsync<T>(mode: OracleMode, run: () => Promise<T>): Promise<T> {
    if (mode !== 'postcondition') return run();
    const previous = getAssertEnforcement();
    setAssertEnforcement(false);
    try {
        return await run();
    } finally {
        setAssertEnforcement(previous);
    }
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

/** Name each postcondition guarantee this run will exercise — the honest `oraclesChecked` (§5.2 pt 3). */
function describeOracles(
    posts: ReadonlyArray<Postcondition>,
    returns: ReadonlyArray<ConstraintDescriptor>,
): string[] {
    const out: string[] = [];
    for (const descriptor of returns) out.push(`@Returns ${descriptor.constraint}: ${descriptor.describe()}`);
    for (const post of posts)
        out.push(`@Ensures: ${post.description || '(anonymous closure postcondition)'}`);
    return out;
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

/** Invoke the method, returning its result so the postcondition oracle can check it (Phase B). */
function invoke(receiver: object, method: string | symbol, args: unknown[]): unknown {
    return (receiver as Record<string | symbol, (...a: unknown[]) => unknown>)[method](...args);
}

function readField(receiver: object, key: string | symbol): unknown {
    return (receiver as Record<string | symbol, unknown>)[key];
}

/** The same three-line duck-type `@Time` and the installer use — a thenable is settled, not read raw. */
function isThenable(value: unknown): boolean {
    return (
        !!value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as {then?: unknown}).then === 'function'
    );
}

/** fast-check's shrink path for the failing case, when present — the value-free replay coordinate. */
function counterexamplePathOf(details: fc.RunDetails<[unknown[]]>): string | undefined {
    const path = (details as {counterexamplePath?: string | null}).counterexamplePath;
    return path ? String(path) : undefined;
}

/**
 * Whether a thrown value is an adorn contract violation, as opposed to an error from the method body.
 * adorn's enforcement throws `new Error('Value Error: …')` (`Descriptor.formatMessage`), so the prefix
 * is the tell. Heuristic and tied to that message shape — noted here so it travels if the shape changes.
 * (In postcondition mode the wrapper's own post-check is suppressed, so a throw here is a real method
 * crash or a still-live precondition guard, never a post-check throw — see the module header.)
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
    oraclesChecked: ReadonlyArray<string>,
    oracle: OracleMode,
): FuzzResult {
    return {
        target,
        method,
        isStatic,
        oracle,
        declined: true,
        reason,
        numRuns: 0,
        coverage,
        invariantsChecked: [],
        oraclesChecked,
        passed: false,
        warnings: [],
    };
}
