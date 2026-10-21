/**
 * The shared development-mode diagnostic sink (hoisted to Core, round-4 §2.3 / plan C-1).
 *
 * Two callers emit diagnostics: the Adapter's missing-`@Contract()` warning (`ContractDiagnostics.ts`)
 * and now the descriptor-first tool-schema projection's unsatisfiable-stack diagnostic (`toolSchemaFrom`
 * in `Projections/schema.ts`). A projection must NOT import from an adapter (the layering guard), so the
 * sink primitive lives here in Core where both can reach it. Crucially it is ONE sink and ONE enabled
 * flag: a test that swaps the sink via `setContractDiagnosticsSink` sees diagnostics from BOTH paths —
 * if the projection emitted to a different sink than the setter targets, the spy would be dead (the exact
 * trap C-1 flags). `ContractDiagnostics.ts` re-exports these so its public surface is unchanged.
 */

import {globalSlot} from './singletons';

/** Where warnings go. Swappable so tests can assert on them and hosts can route them. */
export type DiagnosticSink = (message: string) => void;

/**
 * Process-global diagnostics state (DEC-095): the swappable sink and the enabled flag, in one shared slot so a
 * dual-loaded adorn has ONE sink a test can spy on and ONE enabled flag. Both are reassigned at runtime, so
 * they are read and written through `DIAG`. See `./singletons`.
 */
const DIAG = globalSlot('diagnostics', () => ({sink: null as DiagnosticSink | null, enabled: true}));

/**
 * Development mode is the default; only an explicit `NODE_ENV=production` opts out. Read per call rather
 * than cached at module load, so a host that sets it late still gets the behaviour it asked for.
 */
export function diagnosticsActive(): boolean {
    if (!DIAG.enabled) return false;
    const env = typeof process !== 'undefined' && process && process.env ? process.env.NODE_ENV : undefined;
    return env !== 'production';
}

/** Emit through the sink (or `console.warn`), guarded so a diagnostic never becomes the failure it reports. */
export function emitDiagnostic(message: string): void {
    try {
        if (DIAG.sink) {
            DIAG.sink(message);
        } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn(message);
        }
    } catch {
        // A diagnostic must never become the failure it is reporting on.
    }
}

/**
 * Emit a one-off development-mode diagnostic through the shared sink. Silenced in production and when
 * diagnostics are disabled. Used by the missing-`@Contract()` `@Sensitive`-veto surfacing (DEC-036) and by
 * the unsatisfiable-stack diagnostic on both the installer and the `toolSchemaFrom` paths (round-4 §2.3).
 */
export function reportDiagnostic(message: string): void {
    if (!diagnosticsActive()) return;
    emitDiagnostic(message);
}

/** Route warnings somewhere other than `console.warn`. Pass `null` to restore the default. */
export function setContractDiagnosticsSink(next: DiagnosticSink | null): void {
    DIAG.sink = next;
}

/**
 * Turn the diagnostic off entirely. An escape hatch for noise, not a correctness switch: silencing does
 * not install or fix anything.
 */
export function setContractDiagnosticsEnabled(next: boolean): void {
    DIAG.enabled = next;
}

export function isContractDiagnosticsEnabled(): boolean {
    return DIAG.enabled;
}

/** Test support — reset the sink and enabled flag to their defaults (the pending set lives Adapter-side). */
export function resetDiagnosticsState(): void {
    DIAG.sink = null;
    DIAG.enabled = true;
}
