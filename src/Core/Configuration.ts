/**
 * P3.2 — the trust model, and the only sanctioned way enforcement is turned off.
 *
 * ## Why a single boolean was rejected (DEC-008, Q-2)
 *
 * Every mature contract system lets checks be disabled in production, and the obvious shape is one
 * global switch. That shape is unsafe, and the reason is not stylistic:
 *
 * - A precondition guarding **untrusted external input** — a request body, a CLI argument, a value
 *   crossing a module boundary — is the *only* thing standing between that input and the code behind
 *   it. Stripping it in production removes the check precisely where the hostile input lives.
 * - A precondition asserting an **internal invariant** — "this private helper is never called with a
 *   negative index" — is a self-check on code you control. Stripping it costs a debugging aid, not a
 *   safety property.
 *
 * One boolean cannot tell those apart, so it must either keep both (and the toggle is pointless) or
 * strip both (and the toggle is dangerous). The distinction has to be *authored*, which means it
 * needs somewhere to be written down. That is what {@link ContractTrust} is.
 *
 * ## Granularity: per enforcement site, not per constraint
 *
 * Trust is declared on the **method** (via `@Validate({trust})`) or on the **class** (via
 * `@Contract({trust})`), not on the individual constraint.
 *
 * That is a deliberate limit rather than an oversight. Trust answers *why a check exists* — "this
 * method sits at a boundary and is handed input it did not produce" — and that is a property of the
 * method's role, not of any one `min: 0` inside it. A method whose first parameter is a `guard` while
 * its second is an `assert` describes a boundary that is half-trusted, which is not a thing. Per
 * constraint trust is a pure extension of what is here (add a `trust` to the recorded constraint and
 * take the strictest on the path) and should be added when something actually needs it, not before —
 * plan risk 10 names this layer specifically.
 *
 * The **category** axis the plan sketches (`{parameter, field, postcondition, concern}`) is likewise
 * not built: `parameter` is the only category that exists today, so three of its four keys would be
 * dead configuration that nothing can set meaningfully and no test can exercise.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * Decorator-agnostic. Nothing here imports a decorator type or touches `target`/`propertyKey`; a
 * violation site arrives as two plain strings the adapter resolved at install time.
 */

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/**
 * Why a contract exists, and therefore whether it may be stripped.
 *
 * - `guard` — validates untrusted or external input. **Not removed by the production switch.**
 *   Turning these off requires the explicit, loud {@link disableGuardEnforcement}.
 * - `assert` — an internal self-check. Removed in production by default, exactly like a C `assert`.
 *
 * `guard` is the default for everything, which is the safe direction to be wrong in: an author who
 * says nothing gets a check that survives production, and downgrades to `assert` deliberately.
 */
export type ContractTrust = 'guard' | 'assert';

export const DEFAULT_TRUST: ContractTrust = 'guard';

/** Options accepted by any decorator that installs enforcement. */
export interface TrustOptions {
    /** Defaults to the process-wide default trust — `guard` unless changed. */
    readonly trust?: ContractTrust;
}

export type EnforcementMode = 'development' | 'production';

// ---------------------------------------------------------------------------
// Violation routing
// ---------------------------------------------------------------------------

/**
 * Which side of the call a violation blames (plan A §5.1, made first-class).
 *
 * A **precondition** failure blames the `caller` — it supplied an argument the contract rejects. A
 * **postcondition** failure blames the `callee` — the method broke its own promise, which is a bug in
 * the method, not in the call. A handler can therefore split "our callers are misusing us" from "we
 * shipped a bug" without any new plumbing: it is one more field on the {@link ViolationSite} it
 * already receives.
 */
export type ViolationBlame = 'caller' | 'callee';

/** Where a violation happened. Plain strings: this layer never sees a prototype or a property key. */
export interface ViolationSite {
    /** The class name, e.g. `Task`. */
    readonly owner: string;
    /** The method name, e.g. `send`. */
    readonly member: string;
    readonly trust: ContractTrust;
    /** Who is at fault — a precondition blames the caller, a postcondition the callee. */
    readonly blame: ViolationBlame;
}

/**
 * Custom routing. Returning normally **suppresses** the violation and the method proceeds; throwing
 * (the original value, or a wrapped one) propagates to the caller.
 */
export type ViolationHandler = (violation: unknown, site: ViolationSite) => void;

/**
 * - `'throw'` — the default, and the only one that actually enforces anything.
 * - `'warn'` — log and **continue into the method**. Useful for staging a new contract over live
 *   traffic before it is allowed to reject anything; not a safe steady state.
 * - a function — route to telemetry. Suppresses unless it throws.
 */
export type ViolationPolicy = 'throw' | 'warn' | ViolationHandler;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `'auto'` follows the mode: enforced in development, stripped in production. An explicit boolean
 * pins it either way, so a production build can keep its self-checks and a development run can
 * measure what production will actually do.
 */
export type AssertEnforcement = boolean | 'auto';

interface ConfigurationState {
    mode: EnforcementMode | 'auto';
    guard: boolean;
    assert: AssertEnforcement;
    defaultTrust: ContractTrust;
    onViolation: ViolationPolicy;
}

function initialState(): ConfigurationState {
    return {
        mode: 'auto',
        guard: true,
        assert: 'auto',
        defaultTrust: DEFAULT_TRUST,
        onViolation: 'throw',
    };
}

let state: ConfigurationState = initialState();

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * The effective mode. Read per call rather than cached at module load, so a host that sets
 * `NODE_ENV` after adorn is imported still gets the behaviour it asked for — the same rule
 * `ContractDiagnostics` follows, for the same reason.
 */
export function getEnforcementMode(): EnforcementMode {
    if (state.mode !== 'auto') return state.mode;
    const env = typeof process !== 'undefined' && process && process.env ? process.env.NODE_ENV : undefined;
    return env === 'production' ? 'production' : 'development';
}

/** Pin the mode, ignoring `NODE_ENV`. Pass `'auto'` to go back to following the environment. */
export function setEnforcementMode(mode: EnforcementMode | 'auto'): void {
    state.mode = mode;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Whether a contract of this trust level runs right now.
 *
 * Called **once per invocation at the top of the wrapper**, not once per predicate — the cost of the
 * gate should not scale with how many constraints a method carries.
 */
export function shouldEnforce(trust: ContractTrust): boolean {
    if (trust === 'guard') return state.guard;
    if (state.assert === 'auto') return getEnforcementMode() !== 'production';
    return state.assert === true;
}

/** Control whether internal `assert` contracts run. `'auto'` (the default) follows the mode. */
export function setAssertEnforcement(enabled: AssertEnforcement): void {
    state.assert = enabled;
}

export function getAssertEnforcement(): AssertEnforcement {
    return state.assert;
}

/**
 * Turn off contracts that guard untrusted input.
 *
 * Deliberately awkward. This is not a performance knob — it removes the checks standing between
 * external input and the code behind it, which is the exact thing DEC-008 exists to prevent a single
 * boolean from doing by accident. It therefore refuses to run without an explicit confirmation and a
 * stated reason, and announces itself loudly when it does.
 *
 * There is no configuration file, environment variable, or plain setter that reaches this. The only
 * way here is a deliberate call in application code.
 */
export function disableGuardEnforcement(options: {confirm: true; reason: string}): void {
    if (
        !options ||
        options.confirm !== true ||
        typeof options.reason !== 'string' ||
        options.reason.trim() === ''
    ) {
        throw new Error(
            'disableGuardEnforcement: refusing to strip guard contracts without an explicit ' +
                "`{confirm: true, reason: '...'}`. Guards validate untrusted input — stripping them " +
                'removes the check exactly where hostile input arrives (DEC-008 / Q-2). If you meant ' +
                "to strip internal self-checks, mark those contracts `trust: 'assert'` and use " +
                'setAssertEnforcement(false) instead.',
        );
    }

    state.guard = false;
    emit(
        '[adorn] GUARD CONTRACTS DISABLED. Contracts validating untrusted external input are no ' +
            'longer enforced process-wide.\n' +
            `  Reason given: ${options.reason}\n` +
            '  This is not the production toggle — production strips `assert` contracts only, and ' +
            'leaves guards in place.\n' +
            '  Re-enable with enableGuardEnforcement().',
    );
}

/** Undo {@link disableGuardEnforcement}. Silent: turning enforcement back on is never the risk. */
export function enableGuardEnforcement(): void {
    state.guard = true;
}

export function isGuardEnforcementEnabled(): boolean {
    return state.guard;
}

// ---------------------------------------------------------------------------
// Default trust
// ---------------------------------------------------------------------------

/**
 * The trust used when a decorator does not say. Ships as `guard`.
 *
 * Lowering it process-wide makes every un-annotated contract strippable in production, which is a
 * decision about the whole codebase — reach for `@Contract({trust: 'assert'})` on the specific
 * internal classes instead unless that really is what you mean.
 */
export function setDefaultTrust(trust: ContractTrust): void {
    state.defaultTrust = trust;
}

export function getDefaultTrust(): ContractTrust {
    return state.defaultTrust;
}

/** Resolution order: per-decorator option → process default. */
export function resolveTrust(options?: TrustOptions): ContractTrust {
    if (options && options.trust) {
        if (options.trust !== 'guard' && options.trust !== 'assert') {
            throw new TypeError(
                `adorn: trust must be 'guard' or 'assert', received ${String(options.trust)}`,
            );
        }
        return options.trust;
    }
    return state.defaultTrust;
}

// ---------------------------------------------------------------------------
// Violation routing
// ---------------------------------------------------------------------------

export function setViolationPolicy(policy: ViolationPolicy): void {
    state.onViolation = policy;
}

export function getViolationPolicy(): ViolationPolicy {
    return state.onViolation;
}

/**
 * Apply the configured policy to a violation.
 *
 * Returns normally when the violation was **suppressed** and the method should proceed; re-throws
 * otherwise. The caller does not decide — that is the whole point of routing living here.
 */
export function applyViolationPolicy(violation: unknown, site: ViolationSite): void {
    const policy = state.onViolation;

    if (policy === 'warn') {
        emit(
            `[adorn] Contract violation (not enforced — onViolation is 'warn') in ` +
                `${site.owner}.${site.member}: ${describeViolation(violation)}`,
        );
        return;
    }

    if (typeof policy === 'function') {
        // A handler that throws propagates; one that returns suppresses. Not wrapped in try/catch:
        // swallowing a handler's own failure would hide the fact that routing is broken.
        policy(violation, site);
        return;
    }

    throw violation;
}

function describeViolation(violation: unknown): string {
    if (violation && typeof violation === 'object' && typeof (violation as Error).message === 'string') {
        return (violation as Error).message;
    }
    return String(violation);
}

// ---------------------------------------------------------------------------
// Diagnostics sink & test support
// ---------------------------------------------------------------------------

let sink: ((message: string) => void) | null = null;

/** Route this module's own warnings somewhere other than `console.warn`. */
export function setConfigurationSink(next: ((message: string) => void) | null): void {
    sink = next;
}

function emit(message: string): void {
    try {
        if (sink) sink(message);
        else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message);
    } catch {
        // A diagnostic must never become the failure it is reporting on.
    }
}

/** Restore every setting to its shipped default. Test support. */
export function resetConfiguration(): void {
    state = initialState();
    sink = null;
}
