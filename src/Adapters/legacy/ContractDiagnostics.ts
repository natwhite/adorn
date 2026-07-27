/**
 * P1.3 — the missing-`@Contract()` diagnostic.
 *
 * ## Why this module exists at all
 *
 * P1.3 makes installation explicit: parameter decorators **record**, and `@Contract()` on the class
 * **installs**. That eliminates the `Object.defineProperty` monkey-patch (DEC-005), but it buys the
 * fix with the single worst failure mode in the whole plan:
 *
 * > Writing `@StringMinLength(10)` on a parameter and forgetting `@Contract()` on the class means
 * > every contract on that class silently stops being enforced. No error. No warning. The method
 * > just runs unguarded.
 *
 * A crash would be *better* than that, because a crash is discoverable. And under DEC-006 there is
 * now a second, quieter failure alongside it: an un-annotated class is also absent from
 * `getContractedClasses()`, so it vanishes from generated documentation and fuzzing — and *silently
 * missing from an artifact people trust* is worse than *unenforced at runtime*, because nothing
 * ever throws to reveal it.
 *
 * The implementation plan therefore calls this warning **mandatory, not optional** (plan P1.3 risk,
 * §8, top risk 1). This module is that countermeasure. It converts a silent no-op into a directed,
 * named, actionable message.
 *
 * ## Why the check has to be deferred
 *
 * It cannot run at decoration time. TypeScript emits member decorators *before* the class
 * decorator:
 *
 * ```js
 * __decorate([__param(0, StringMinLength(10))], Task.prototype, "test", null);
 * Task = __decorate([Contract()], Task);          // <- only now do we know
 * ```
 *
 * so when a parameter decorator runs, whether `@Contract()` is coming is genuinely unknown. Nor can
 * it run on first *call*: an uninstalled method has no wrapper, so there is no hook to run in.
 *
 * The check is therefore scheduled onto the microtask queue. Class evaluation — members then class
 * decorator — is entirely synchronous, so the queue drains strictly after every class in the module
 * has finished decorating, and `@Contract()` has had its chance to clear the entry.
 * {@link flushContractDiagnostics} forces the sweep early for tests and for anyone who wants a
 * deterministic point to assert at.
 *
 * ## Layering
 *
 * Adapter-side but decorator-free: it is told about *targets and keys*, never about decorators or
 * constraints. It deliberately does not read `ContractRegistry`, because the pending set has to
 * cover contracts the registry cannot hold — `CreateSimpleDecorator`'s hand-written closures carry
 * no `ConstraintDescriptor` and so are never recorded there, yet forgetting `@Contract()` breaks
 * them in exactly the same way.
 */

import {MethodKey} from '../../Core/ContractRegistry';

/** Where warnings go. Swappable so tests can assert on them and hosts can route them. */
export type DiagnosticSink = (message: string) => void;

interface PendingTarget {
    /** Kept for the message; resolved lazily because a class may be renamed by another decorator. */
    readonly target: object;
    readonly keys: Set<MethodKey>;
}

/**
 * Strong references, held only until the next sweep clears them. Bounded by "classes decorated
 * since the last microtask checkpoint", which is why this does not need to be a WeakMap — and
 * cannot be, since the sweep has to enumerate it.
 */
const pending = new Map<object, PendingTarget>();

/** One warning per target, ever. A hot import loop must not produce a wall of duplicates. */
const alreadyWarned = new WeakSet<object>();

let sink: DiagnosticSink | null = null;
let enabled = true;
let sweepScheduled = false;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Note that a contract was authored on `target[propertyKey]` but nothing has installed it yet.
 * Called by every parameter decorator, whichever authoring form produced it.
 */
export function notePendingContract(target: object, propertyKey: MethodKey): void {
    if (!diagnosticsActive()) return;
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;

    let entry = pending.get(target);
    if (!entry) {
        entry = {target, keys: new Set<MethodKey>()};
        pending.set(target, entry);
    }
    entry.keys.add(propertyKey);

    scheduleSweep();
}

/** Note that an installer has taken responsibility for `target[propertyKey]`. */
export function noteContractInstalled(target: object, propertyKey: MethodKey): void {
    const entry = pending.get(target);
    if (!entry) return;
    entry.keys.delete(propertyKey);
    if (entry.keys.size === 0) pending.delete(target);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Run the sweep now and empty the pending set.
 *
 * Exposed rather than left purely automatic so tests have a deterministic point to assert at, and
 * so an application with an explicit bootstrap phase can fail fast instead of waiting a tick.
 */
export function flushContractDiagnostics(): void {
    sweepScheduled = false;
    if (pending.size === 0) return;

    const uninstalled: PendingTarget[] = [];
    pending.forEach(entry => {
        if (entry.keys.size > 0) uninstalled.push(entry);
    });
    pending.clear();

    if (!diagnosticsActive()) return;

    for (const entry of uninstalled) {
        if (alreadyWarned.has(entry.target)) continue;
        alreadyWarned.add(entry.target);
        emit(buildWarning(entry));
    }
}

function buildWarning(entry: PendingTarget): string {
    const className = describeOwner(entry.target);
    const members = Array.from(entry.keys)
        .map(key => (typeof key === 'symbol' ? key.toString() : String(key)))
        .sort()
        .join(', ');

    return (
        `[adorn] Contracts on ${className} are NOT being enforced.\n` +
        `  Parameter constraints were declared on: ${members}\n` +
        `  ...but ${className} is not annotated with @Contract(), so no wrapper was installed.\n` +
        '  The constraints will never run, and the class is invisible to documentation and\n' +
        '  fuzzing projections (getContractedClasses()).\n' +
        '\n' +
        '  Fix — add @Contract() to the class:\n' +
        '\n' +
        "      import {Contract} from 'adorn';\n" +
        '\n' +
        '      @Contract()\n' +
        `      class ${className} { ... }\n` +
        '\n' +
        '  (adorn development-mode diagnostic. Silenced when NODE_ENV=production, or via\n' +
        '   setContractDiagnosticsEnabled(false).)'
    );
}

function emit(message: string): void {
    try {
        if (sink) {
            sink(message);
        } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn(message);
        }
    } catch {
        // A diagnostic must never become the failure it is reporting on.
    }
}

// ---------------------------------------------------------------------------
// Configuration & test support
// ---------------------------------------------------------------------------

/** Route warnings somewhere other than `console.warn`. Pass `null` to restore the default. */
export function setContractDiagnosticsSink(next: DiagnosticSink | null): void {
    sink = next;
}

/**
 * Emit a one-off development-mode diagnostic through the same sink the missing-`@Contract()` warning
 * uses (O1c, DEC-036 / Q-24 R8). Used to *surface, not silently nullify*, an `@Sensitive` veto of an
 * explicit `@Telemetry.value()` opt-in: the value stays redacted (safe-by-default is non-negotiable for
 * PII, DEC-025), but the collision is announced rather than swallowed — the paternalism corner the
 * adversarial review flagged (Fr2). Silenced in production and when diagnostics are disabled, exactly as
 * the missing-`@Contract()` warning is; guarded so a diagnostic never becomes the failure it reports.
 */
export function reportDiagnostic(message: string): void {
    if (!diagnosticsActive()) return;
    emit(message);
}

/**
 * Turn the diagnostic off entirely.
 *
 * Note this is an escape hatch for noise, not a correctness switch: silencing the warning does not
 * install anything. A class without `@Contract()` is still unenforced, just quietly again.
 */
export function setContractDiagnosticsEnabled(next: boolean): void {
    enabled = next;
}

export function isContractDiagnosticsEnabled(): boolean {
    return enabled;
}

/**
 * Reset the pending set, sink, and enabled flag. Test support.
 *
 * Deliberately does **not** clear the already-warned set: "one warning per class, ever" is a
 * property of the class, not of a test run, and a `WeakSet` cannot be cleared anyway. A test that
 * needs a fresh warning needs a fresh class — which is also the honest way to test it.
 */
export function resetContractDiagnostics(): void {
    pending.clear();
    sweepScheduled = false;
    sink = null;
    enabled = true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Development mode is the default; only an explicit `NODE_ENV=production` opts out. Read per call
 * rather than cached at module load, so a host that sets it late still gets the behaviour it asked
 * for.
 */
function diagnosticsActive(): boolean {
    if (!enabled) return false;
    const env = typeof process !== 'undefined' && process && process.env ? process.env.NODE_ENV : undefined;
    return env !== 'production';
}

function scheduleSweep(): void {
    if (sweepScheduled) return;
    sweepScheduled = true;

    // Microtask, not `setTimeout`: it drains as soon as the synchronous class-evaluation stack
    // unwinds, so the warning appears essentially at import time rather than a tick later — while
    // still being strictly after the class decorator has had its chance to run.
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(flushContractDiagnostics);
    } else if (typeof Promise === 'function') {
        Promise.resolve().then(flushContractDiagnostics);
    } else {
        setTimeout(flushContractDiagnostics, 0);
    }
}

function describeOwner(target: object): string {
    if (typeof target === 'function') return (target as Function).name || '<anonymous class>';
    const constructor = (target as {constructor?: Function}).constructor;
    return (constructor && constructor.name) || '<anonymous class>';
}
