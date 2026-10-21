/**
 * `@adorn/test` — the stateful call-sequence tester (DEC-090), the payoff of `@EnabledWhen` (DEC-089).
 *
 * `fuzzMethod`/`fuzzClass` test one method in ISOLATION against a fresh subject. This tests INTERACTIONS:
 * it generates a sequence of method calls against a SINGLE evolving instance and checks that the class's
 * invariants — field constraints (the Phase A floor) and both postcondition bands (Phase B) — survive
 * every transition. It is the "true model-based tester" `@EnabledWhen` was built to enable.
 *
 * ## Why enabledness makes it work (and why a naive sequence tester does not)
 *
 * The canonical stateful shape is `pop()`/`dequeue()`/`withdraw()` — legal only in some states. A naive
 * tester that just calls a random method on a shared instance hits the installed wrapper's caller-blamed
 * `"Not enabled:"` throw (`@EnabledWhen`, `ContractInstaller.checkEnabledness`) and — since `isAdornViolation`
 * keys on the `"Value Error:"` prefix — misclassifies it as an `unexpected-throw`: a false positive.
 *
 * This driver pre-checks each step with the SAME {@link evaluateEnabledness} enforcement runs, against the
 * SAME live instance, and:
 *   - a guard that cleanly returns **false** → the call is not enabled in this state now → **SKIP** it
 *     (advance the sequence; never a finding, never counted as starvation);
 *   - a guard that **throws** → a defect (guards must be total over reachable state) → an
 *     `enabledness-guard-throw` **finding**;
 *   - a guard that returns **true** → run the step through the EXACT oracle body `fuzzMethod` uses
 *     ({@link oracleOutcomeSync}) on the persistent instance, so field-invariant / postcondition breaks
 *     are found identically and DEC-034's "flag exactly when the wrapper throws" holds per transition.
 *
 * ## Generation & shrinking (the hand-rolled approach, not `fc.commands`)
 *
 * A command is `fc.record({key, args})` — `args` the precondition-gated tuple {@link buildArgsArbitrary} +
 * {@link preconditionGate} produce, exactly as the per-method path does. A sequence is `fc.array` of those,
 * and fast-check shrinks it structurally (drop steps, shrink each step's args). Enabledness is resolved at
 * RUN time against the real instance, so a (shrunk) sequence's skips are a pure function of the array + seed
 * — deterministic and replayable. `fc.commands`/`fc.modelRun` is deliberately NOT used: its `Command.check`
 * is a pure function of an abstract model, but adorn's enabledness reads real state, so fitting it would
 * force a parallel model — the very drift `@EnabledWhen` exists to avoid (DEC-006/DEC-089).
 *
 * ## What it does NOT do (foundation §7, §8)
 *
 * It samples; it does not prove. It checks that invariants/postconditions SURVIVE each transition, not what
 * each transition *does* (a transition oracle needs `old()` — plan-of-record item #3, evidence-gated). It
 * runs the REAL methods, side effects and all. Start-state comes from the user's `subject` factory — adorn
 * cannot invent a constructor (constructor contracts deferred, DEC-089). {@link module:report} states the
 * boundary; a clean run is "no generated sequence broke an invariant", not "correct".
 */

import * as fc from 'fast-check';
import {
    ClassFieldContract,
    ClassMethodContract,
    EnablednessGuard,
    getContractsForClass,
    getEffectiveEnablednessKeys,
    Postcondition,
} from '../../src/Core/ContractRegistry';
import {ConstraintDescriptor} from '../../src/Core/Descriptor';
// Consumed from adorn's PUBLIC surface (the package root), like the oracle's postcondition reads — the
// add-on is an ordinary downstream consumer, not privileged. `evaluateEnabledness` is the SAME function
// enforcement runs against a live receiver (DEC-089), so this driver's enabledness check is byte-for-byte
// the one the installed wrapper enforces (no drift, DEC-006).
import {
    evaluateEnabledness,
    getEffectiveEnablednessGuards,
    getEffectivePostconditions,
    getEffectivePreconditions,
} from '../../introspection';
import {arbitraryForParameter, Arbitrary, ParameterArbitrary} from './arbitraries';
// The oracle body and its coverage/gate helpers, reused verbatim (widened to `export` for this driver but
// NOT re-exported from `index.ts`, so they stay add-on-internal). Reuse, not duplication: an enabled step
// is checked by the exact machinery a single-method run uses.
import {
    buildArgsArbitrary,
    buildCoverage,
    collectWarnings,
    counterexamplePathOf,
    describeOracles,
    FindingType,
    instanceFieldContracts,
    invoke,
    OracleContext,
    OracleMode,
    OracleOutcome,
    oracleOutcomeAsync,
    oracleOutcomeSync,
    preconditionGate,
    withPostconditionProbe,
    withPostconditionProbeAsync,
} from './oracle';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SequenceOptions {
    /**
     * A factory for a fresh start-state instance, called once per generated sequence so state never leaks
     * between sequences. **Required** — adorn cannot invent a constructor for an arbitrary class
     * (constructor contracts deferred, DEC-089); start-state is the caller's to supply.
     */
    readonly subject: () => object;
    /** Restrict the command set to these instance methods. Default: every fuzzable instance command. */
    readonly methods?: ReadonlyArray<string | symbol>;
    /** Maximum sequence length (`fc.array` maxLength). Defaults to 20. Not a nanny cap — raise it freely. */
    readonly maxSteps?: number;
    /** Sequences to generate. Defaults to 100. Not a nanny cap (foundation §7.3). */
    readonly numRuns?: number;
    /** Fix the seed to reproduce a run exactly. Omitted, fast-check picks one and it is reported. */
    readonly seed?: number;
    /** The arbitrary for undecorated argument positions. Defaults to `fc.anything()` (broad by design, §8). */
    readonly gapFill?: Arbitrary<unknown>;
    /** Override the oracle for every command. Default is auto per command (postcondition when it has one). */
    readonly oracle?: OracleMode;
}

/** One executed (enabled) step in a reported counterexample sequence. */
export interface SequenceStep {
    readonly method: string;
    /** The step's argument tuple. Kept raw for replay; the *report* redacts it by default (DEC-030). */
    readonly counterexample: ReadonlyArray<unknown>;
}

/** A reproducible sequence counterexample — the shrunk sequence of enabled calls, plus what broke. */
export interface SequenceFinding {
    readonly type: FindingType;
    readonly message: string;
    /** The shrunk sequence of enabled/executed steps leading to (and including) the break. */
    readonly steps: ReadonlyArray<SequenceStep>;
    /** fast-check's seed — replay with `fuzzSequence({..., seed})` to reproduce exactly. */
    readonly seed: number;
    readonly numShrinks: number;
    /** fast-check's value-free shrink path — the redacted report's replay coordinate. */
    readonly path?: string;
    /** For an `invariant-violation`: which field, and which constraint on it, broke. */
    readonly field?: string;
    readonly constraint?: string;
    /** For a `postcondition-violation`: the broken guarantee, named. */
    readonly postconditionDescription?: string;
}

/** The per-command coverage boundary — the honest "what I drove, and how" a sequence result carries. */
export interface SequenceCommandReport {
    readonly method: string;
    /** Per-parameter coverage — what was generated for each position, how, and what was gap-filled. */
    readonly coverage: ReadonlyArray<ParameterArbitrary>;
    readonly oracle: OracleMode;
    /** The postcondition guarantees this command exercised (empty in weak-invariant mode). */
    readonly oraclesChecked: ReadonlyArray<string>;
    /** Whether this command carries an `@EnabledWhen` guard (so it was enabledness-gated during the run). */
    readonly enabledness: boolean;
}

export interface SequenceResult {
    readonly target: string;
    /** True when the class could not be sequence-tested at all — see {@link reason}. */
    readonly declined: boolean;
    readonly reason?: string;
    readonly numRuns: number;
    /** The seed used, so a clean run is reproducible too. */
    readonly seed?: number;
    readonly maxSteps: number;
    /** The command set that was driven, each with its coverage boundary. */
    readonly commands: ReadonlyArray<SequenceCommandReport>;
    /** The field contracts re-checked as invariants after every transition. */
    readonly invariantsChecked: ReadonlyArray<string>;
    /** True when the driver ran and found nothing. Distinct from `declined` (never ran). */
    readonly passed: boolean;
    readonly finding?: SequenceFinding;
    /** Everything the developer cannot see: starvation, dead commands, side effects, "fuzzed ≠ proved". */
    readonly warnings: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Internal plan
// ---------------------------------------------------------------------------

/** One command in the sequence alphabet — a method the driver can issue, fully prepared. */
interface SequenceCommand {
    readonly key: string | symbol;
    readonly name: string;
    readonly coverage: ParameterArbitrary[];
    readonly argsArbitrary: Arbitrary<unknown[]>;
    readonly guards: ReadonlyArray<EnablednessGuard>;
    readonly posts: ReadonlyArray<Postcondition>;
    readonly returns: ReadonlyArray<ConstraintDescriptor>;
    readonly mode: OracleMode;
    readonly oraclesChecked: string[];
    /** `@Requires` generate-and-filter starvation warnings for this command (merged into the run's). */
    readonly warnings: string[];
}

type PreparedSequence = {readonly declined: SequenceResult} | SequencePlan;

interface SequencePlan {
    readonly declined?: undefined;
    readonly className: string;
    readonly subject: () => object;
    readonly commands: SequenceCommand[];
    readonly byKey: Map<string | symbol, SequenceCommand>;
    readonly fieldContracts: ReadonlyArray<ClassFieldContract>;
    readonly invariantsChecked: string[];
    readonly maxSteps: number;
    readonly numRuns: number;
    readonly seed?: number;
    /** True when any command uses the postcondition oracle — the run then suppresses the assert gate. */
    readonly active: boolean;
}

/** A generated step: which command, and the argument tuple to call it with. */
interface GeneratedStep {
    readonly key: string | symbol;
    readonly args: unknown[];
}

/** One step that actually ran (was enabled) during a sequence. */
interface ExecutedStep {
    readonly method: string;
    readonly args: unknown[];
}

/** The result of running one sequence: the first finding (or null), and the steps that executed. */
interface SequenceRunResult {
    readonly outcome: OracleOutcome | null;
    readonly executed: ExecutedStep[];
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Sequence-test a contracted stateful class: drive generated sequences of enabled method calls against a
 * fresh `subject()` instance and check that field invariants + postconditions survive every transition.
 *
 * Synchronous. A command that returns a thenable makes the whole run **decline** with a "use
 * fuzzSequenceAsync" message rather than checking a Promise object as if it were the settled value.
 */
export function fuzzSequence(target: Function, options: SequenceOptions): SequenceResult {
    const p = prepareSequence(target, options);
    if (p.declined) return p.declined;
    return runSequenceSyncCheck(p);
}

/**
 * The async twin of {@link fuzzSequence} — for classes whose methods return Promises. Awaits each enabled
 * step's settled value before the oracle; a rejected Promise during an enabled step is a finding (the async
 * twin of a throw), a not-enabled step still skips. Sequences run sequentially (the whole check shares one
 * assert-suppression window, so overlapping runs cannot race the process-wide gate — as `fuzzClassAsync`).
 */
export async function fuzzSequenceAsync(target: Function, options: SequenceOptions): Promise<SequenceResult> {
    const p = prepareSequence(target, options);
    if (p.declined) return p.declined;
    return runSequenceAsyncCheck(p);
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

function prepareSequence(target: Function, options: SequenceOptions): PreparedSequence {
    const {subject, methods, maxSteps = 20, numRuns = 100, seed, gapFill = fc.anything(), oracle} = options;
    const className = target.name || '(anonymous class)';
    const proto: object | undefined = target.prototype;

    // The command alphabet is the union of two registry sources, keyed on the prototype (instance methods):
    //   - the contract band (`getContractsForClass`) — methods with per-position / `@Returns` constraints;
    //   - the enabledness band (`getEffectiveEnablednessKeys`) — a method guarded ONLY by `@EnabledWhen`
    //     (the canonical nullary `pop()`) records nothing in the contract band, so it is invisible there;
    //     without this union the driver could not drive the most common stateful shape (DEC-089).
    const entries = getContractsForClass(target).filter(e => !e.isStatic);
    const entryByKey = new Map<string | symbol, ClassMethodContract>();
    for (const e of entries) entryByKey.set(e.key, e);

    const keys: Array<string | symbol> = [];
    const seen = new Set<string | symbol>();
    const addKey = (key: string | symbol) => {
        if (seen.has(key)) return;
        seen.add(key);
        keys.push(key);
    };
    for (const e of entries) addKey(e.key);
    if (proto) for (const key of getEffectiveEnablednessKeys(proto)) addKey(key);

    const restrict = methods ? new Set<string | symbol>(methods) : undefined;

    const commands: SequenceCommand[] = [];
    const excluded: string[] = [];
    for (const key of keys) {
        if (restrict && !restrict.has(key)) continue;
        const built = buildCommand(target, proto, key, entryByKey.get(key), gapFill, oracle);
        if (built.excluded) excluded.push(built.reason);
        else commands.push(built.command);
    }

    if (commands.length === 0) {
        const reason =
            keys.length === 0
                ? `${className} has no contracted instance methods to sequence (no per-position, ` +
                  '@Returns, or @EnabledWhen constraints on any instance method)'
                : `no fuzzable command remained for ${className}: ${excluded.join('; ')}`;
        return {declined: declinedSequence(className, reason, maxSteps)};
    }

    if (typeof subject !== 'function') {
        return {
            declined: declinedSequence(
                className,
                `sequence testing needs a start state — pass \`subject: () => new ${className}(...)\``,
                maxSteps,
            ),
        };
    }

    const byKey = new Map<string | symbol, SequenceCommand>();
    for (const c of commands) byKey.set(c.key, c);

    const fieldContracts = instanceFieldContracts(target);
    const invariantsChecked = fieldContracts.map(f => String(f.key));
    const active = commands.some(c => c.mode === 'postcondition');

    return {
        className,
        subject,
        commands,
        byKey,
        fieldContracts,
        invariantsChecked,
        maxSteps,
        numRuns,
        seed,
        active,
    };
}

type BuiltCommand =
    | {readonly excluded: true; readonly reason: string}
    | {readonly excluded?: false; readonly command: SequenceCommand};

/** Prepare one command, or exclude it (with a reason) when its arguments cannot be soundly generated. */
function buildCommand(
    target: Function,
    proto: object | undefined,
    key: string | symbol,
    entry: ClassMethodContract | undefined,
    gapFill: Arbitrary<unknown>,
    oracleOverride: OracleMode | undefined,
): BuiltCommand {
    const name = String(key);

    // Coverage: from the contract band when present; otherwise recover arity from the method's own
    // `length` and gap-fill each position (the `prepareFunctionRun` precedent for enabledness-only methods).
    let coverage: ParameterArbitrary[];
    if (entry) {
        coverage = buildCoverage(entry);
    } else {
        const fn = proto ? (proto as Record<string | symbol, unknown>)[key] : undefined;
        const arity = typeof fn === 'function' ? fn.length : 0;
        coverage = [];
        for (let index = 0; index < arity; index++) coverage.push(arbitraryForParameter([], index));
    }

    const declinedPosition = coverage.find(plan => plan.declined);
    if (declinedPosition) {
        return {
            excluded: true,
            reason:
                `${name} parameter ${declinedPosition.index}` +
                `${declinedPosition.name ? ` ('${declinedPosition.name}')` : ''} could not be generated (` +
                (declinedPosition.note || 'no sound generator') +
                ')',
        };
    }

    // `@Requires` gate (DEC-057): filter the tuple to the precondition-valid set. Read from the prototype
    // (instance methods), the same key band enforcement reads. 0% acceptance excludes the command honestly.
    const pres = proto ? getEffectivePreconditions(proto, key) : [];
    const gate = preconditionGate(buildArgsArbitrary(coverage, gapFill), pres);
    if (gate.declined) {
        return {excluded: true, reason: `${name}: ${gate.reason}`};
    }

    const guards = proto ? getEffectiveEnablednessGuards(proto, key) : [];
    const posts = proto ? getEffectivePostconditions(proto, key) : [];
    const returns = entry ? entry.contract.post : [];
    const mode: OracleMode =
        oracleOverride ?? (posts.length > 0 || returns.length > 0 ? 'postcondition' : 'weak-invariant');

    return {
        command: {
            key,
            name,
            coverage,
            argsArbitrary: gate.arbitrary!,
            guards,
            posts,
            returns,
            mode,
            oraclesChecked: describeOracles(posts, returns),
            warnings: collectWarnings(coverage, gate.warnings).slice(2), // drop the two STANDING_WARNINGS
        },
    };
}

// ---------------------------------------------------------------------------
// Run — sync
// ---------------------------------------------------------------------------

function runSequenceSyncCheck(p: SequencePlan): SequenceResult {
    const flags = {sawThenable: false};
    const executions = new Map<string | symbol, number>();
    const sequenceArb = buildSequenceArbitrary(p);

    let details: fc.RunDetails<[GeneratedStep[]]>;
    try {
        details = withPostconditionProbe(p.active, () =>
            fc.check(
                fc.property(
                    sequenceArb,
                    (steps: GeneratedStep[]) => runStepsSync(steps, p, flags, executions).outcome === null,
                ),
                p.seed === undefined ? {numRuns: p.numRuns} : {numRuns: p.numRuns, seed: p.seed},
            ),
        );
    } catch (error) {
        return generationStarvedSequence(p, error);
    }

    if (flags.sawThenable) return asyncDeclineSequence(p);
    if (!details.failed) return assemblePassedSequence(p, details, executions);

    const steps = counterexampleStepsOf(details);
    const run = withPostconditionProbe(p.active, () =>
        runStepsSync(steps, p, {sawThenable: false}, executions),
    );
    return assembleFoundSequence(p, details, run, executions);
}

/** Run one generated sequence synchronously against a fresh instance. First finding wins. */
function runStepsSync(
    steps: ReadonlyArray<GeneratedStep>,
    p: SequencePlan,
    flags: {sawThenable: boolean},
    executions: Map<string | symbol, number>,
): SequenceRunResult {
    const instance = p.subject();
    const executed: ExecutedStep[] = [];

    for (const step of steps) {
        const cmd = p.byKey.get(step.key);
        if (!cmd) continue; // a stale key (should not happen — the arbitrary only draws live keys)

        const enabled = evaluateEnabledness(cmd.guards, instance, step.args);
        if (!enabled.ok) {
            if (enabled.error !== undefined) {
                executed.push({method: cmd.name, args: step.args});
                return {outcome: guardThrewOutcome(cmd, enabled.error), executed};
            }
            continue; // clean false → not enabled in this state now → SKIP (never a finding)
        }

        tally(executions, step.key);
        const ctx = commandContext(instance, cmd, p.fieldContracts);
        const outcome = oracleOutcomeSync(step.args, ctx);
        executed.push({method: cmd.name, args: step.args});
        if (ctx.sawThenable) flags.sawThenable = true;
        if (outcome) return {outcome, executed};
    }

    return {outcome: null, executed};
}

// ---------------------------------------------------------------------------
// Run — async
// ---------------------------------------------------------------------------

async function runSequenceAsyncCheck(p: SequencePlan): Promise<SequenceResult> {
    const executions = new Map<string | symbol, number>();
    const sequenceArb = buildSequenceArbitrary(p);

    let details: fc.RunDetails<[GeneratedStep[]]>;
    try {
        details = await withPostconditionProbeAsync(p.active, () =>
            fc.check(
                fc.asyncProperty(
                    sequenceArb,
                    async (steps: GeneratedStep[]) =>
                        (await runStepsAsync(steps, p, executions)).outcome === null,
                ),
                p.seed === undefined ? {numRuns: p.numRuns} : {numRuns: p.numRuns, seed: p.seed},
            ),
        );
    } catch (error) {
        return generationStarvedSequence(p, error);
    }

    if (!details.failed) return assemblePassedSequence(p, details, executions);

    const steps = counterexampleStepsOf(details);
    const run = await withPostconditionProbeAsync(p.active, () => runStepsAsync(steps, p, executions));
    return assembleFoundSequence(p, details, run, executions);
}

/** Run one generated sequence, awaiting each enabled step's settled value before the oracle. */
async function runStepsAsync(
    steps: ReadonlyArray<GeneratedStep>,
    p: SequencePlan,
    executions: Map<string | symbol, number>,
): Promise<SequenceRunResult> {
    const instance = p.subject();
    const executed: ExecutedStep[] = [];

    for (const step of steps) {
        const cmd = p.byKey.get(step.key);
        if (!cmd) continue;

        const enabled = evaluateEnabledness(cmd.guards, instance, step.args);
        if (!enabled.ok) {
            if (enabled.error !== undefined) {
                executed.push({method: cmd.name, args: step.args});
                return {outcome: guardThrewOutcome(cmd, enabled.error), executed};
            }
            continue;
        }

        tally(executions, step.key);
        const ctx = commandContext(instance, cmd, p.fieldContracts);
        const outcome = await oracleOutcomeAsync(step.args, ctx);
        executed.push({method: cmd.name, args: step.args});
        if (outcome) return {outcome, executed};
    }

    return {outcome: null, executed};
}

// ---------------------------------------------------------------------------
// Shared run helpers
// ---------------------------------------------------------------------------

function buildSequenceArbitrary(p: SequencePlan): Arbitrary<GeneratedStep[]> {
    const commandArbs = p.commands.map(cmd =>
        fc.record({key: fc.constant(cmd.key), args: cmd.argsArbitrary}),
    );
    return fc.array(fc.oneof(...commandArbs), {maxLength: p.maxSteps});
}

/**
 * Build the per-step oracle context: the ONE persistent instance is the receiver every step mutates, and
 * the class's field invariants are re-checked after EVERY transition (the invariant-preservation floor) —
 * `checkSettled` reads them off `fieldContracts`, so they must be threaded through here, not left empty.
 */
function commandContext(
    instance: object,
    cmd: SequenceCommand,
    fieldContracts: ReadonlyArray<ClassFieldContract>,
): OracleContext {
    return {
        makeCall: (args: unknown[]) => ({receiver: instance, result: invoke(instance, cmd.key, args)}),
        fieldContracts,
        mode: cmd.mode,
        posts: cmd.posts,
        returns: cmd.returns,
        sawThenable: false,
    };
}

function tally(executions: Map<string | symbol, number>, key: string | symbol): void {
    executions.set(key, (executions.get(key) ?? 0) + 1);
}

/** The `enabledness-guard-throw` outcome — mirrors the postcondition-threw wording (foundation §5.2 pt 1). */
function guardThrewOutcome(cmd: SequenceCommand, error: unknown): OracleOutcome {
    const guard = cmd.guards.find(g => g.description) ?? cmd.guards[0];
    const described = guard && guard.description ? `"${guard.description}"` : `on ${cmd.name}`;
    return {
        type: 'enabledness-guard-throw',
        message:
            `the @EnabledWhen guard ${described} THREW while being evaluated: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            '— a bug in the guard itself; a guard must be total over reachable state (DEC-089)',
    };
}

function counterexampleStepsOf(details: fc.RunDetails<[GeneratedStep[]]>): GeneratedStep[] {
    return (details.counterexample ? details.counterexample[0] : []) as GeneratedStep[];
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function commandReports(p: SequencePlan): SequenceCommandReport[] {
    return p.commands.map(cmd => ({
        method: cmd.name,
        coverage: cmd.coverage,
        oracle: cmd.mode,
        oraclesChecked: cmd.oraclesChecked,
        enabledness: cmd.guards.length > 0,
    }));
}

/** Warnings: standing disclaimers + per-command coverage/precondition warnings + dead-command liveness. */
function sequenceWarnings(p: SequencePlan, executions: Map<string | symbol, number>): string[] {
    const perCommand = p.commands.flatMap(cmd => cmd.warnings);
    const dead = p.commands
        .filter(cmd => !(executions.get(cmd.key) ?? 0))
        .map(
            cmd =>
                `command '${cmd.name}' was never enabled in any generated sequence — it may be dead in ` +
                'this state space, or its @EnabledWhen guard/args need widening (foundation §7.2).',
        );
    // `collectWarnings([], extra)` prepends the two STANDING_WARNINGS once, then appends the extras.
    return collectWarnings([], [...perCommand, ...dead]);
}

function assemblePassedSequence(
    p: SequencePlan,
    details: fc.RunDetails<[GeneratedStep[]]>,
    executions: Map<string | symbol, number>,
): SequenceResult {
    return {
        target: p.className,
        declined: false,
        numRuns: details.numRuns,
        seed: details.seed,
        maxSteps: p.maxSteps,
        commands: commandReports(p),
        invariantsChecked: p.invariantsChecked,
        passed: true,
        warnings: sequenceWarnings(p, executions),
    };
}

function assembleFoundSequence(
    p: SequencePlan,
    details: fc.RunDetails<[GeneratedStep[]]>,
    run: SequenceRunResult,
    executions: Map<string | symbol, number>,
): SequenceResult {
    return {
        target: p.className,
        declined: false,
        numRuns: details.numRuns,
        seed: details.seed,
        maxSteps: p.maxSteps,
        commands: commandReports(p),
        invariantsChecked: p.invariantsChecked,
        passed: false,
        finding: describeSequenceFinding(run, details),
        warnings: sequenceWarnings(p, executions),
    };
}

function describeSequenceFinding(
    run: SequenceRunResult,
    details: fc.RunDetails<[GeneratedStep[]]>,
): SequenceFinding {
    const steps: SequenceStep[] = run.executed.map(s => ({method: s.method, counterexample: s.args}));
    const path = counterexamplePathOf(details as unknown as fc.RunDetails<[unknown[]]>);

    // `run.outcome` can be null only if the class is nondeterministic and the failure did not reproduce.
    if (!run.outcome) {
        return {
            type: 'unexpected-throw',
            message:
                'a failing sequence was found but did not reproduce on re-run — the class is likely ' +
                'nondeterministic (time, randomness, external state). Make it deterministic to shrink it.',
            steps,
            seed: details.seed,
            numShrinks: details.numShrinks,
            path,
        };
    }

    return {
        type: run.outcome.type,
        message: run.outcome.message,
        steps,
        seed: details.seed,
        numShrinks: details.numShrinks,
        path,
        field: run.outcome.field,
        constraint: run.outcome.constraint,
        postconditionDescription: run.outcome.postconditionDescription,
    };
}

function declinedSequence(target: string, reason: string, maxSteps: number): SequenceResult {
    return {
        target,
        declined: true,
        reason,
        numRuns: 0,
        maxSteps,
        commands: [],
        invariantsChecked: [],
        passed: false,
        warnings: [],
    };
}

function generationStarvedSequence(p: SequencePlan, error: unknown): SequenceResult {
    return declinedSequence(
        p.className,
        `generation starved: ${error instanceof Error ? error.message : String(error)}`,
        p.maxSteps,
    );
}

function asyncDeclineSequence(p: SequencePlan): SequenceResult {
    return declinedSequence(
        p.className,
        'a command returns a thenable — the class is async; use fuzzSequenceAsync() to await and check ' +
            'each settled value',
        p.maxSteps,
    );
}
