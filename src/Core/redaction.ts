/**
 * The redaction runtime — adorn's safe-by-default emission control (DEC-025, DEC-PII-1).
 *
 * This is the small, load-bearing core the observability plan calls the **O0 redaction
 * prerequisite**: every path adorn can emit a value through — `@Log`, contract violation messages,
 * and (later) the observation sink — must render a *safe placeholder* by default and disclose a raw
 * value only when a developer has explicitly opted in. It closes the two live leaks, BUG-18
 * (`@Log` stringifies every argument) and BUG-19 (`Descriptor.formatMessage` embeds the received
 * value), at the point they are worst: by default.
 *
 * ## The load-bearing principle (DEC-025 / DEC-PII-1) — `@Sensitive` is never load-bearing
 *
 * Safe-by-default must hold **without consulting any `@Sensitive` annotation**. Forgetting an
 * annotation is the normal case, not the exceptional one — every annotation-based privacy mechanism
 * surveyed (pino paths, class-transformer `@Exclude`, bunyan serializers) fails not because the
 * marking is wrong but because it is *absent*. So the default here does not read the registry at all:
 * disclosure is off, and every value redacts. `@Sensitive` then only ever adds *stronger* protection
 * — it **vetoes** an explicit disclosure opt-in on a marked site — and can never be the thing that
 * makes an emission safe. Prove-by-test: a class with no `@Sensitive` anywhere is still safe.
 *
 * ## The decision, resolved as data (DEC-012)
 *
 * The whole disclosure decision is `disclosure === 'all' && !sensitive`. This module owns the global
 * disclosure switch; the *per-site* `sensitive` bit is resolved by the enforcement/emission adapters
 * from `ContractRegistry`'s sensitivity band and handed in as a plain boolean. `Descriptor.ts` never
 * calls into here for the sensitivity part — it receives a pre-resolved `disclose` boolean on its
 * `ViolationContext`, exactly the shape `signature` already uses. So `Descriptor` learns about
 * *redaction as data*, never about `@Sensitive` or the registry.
 *
 * ## Redaction form — deliberately the simplest safe thing
 *
 * A single fixed placeholder, {@link REDACTED}. Not a length-preserving mask (identical information,
 * dressed up to imply more protection than it gives) and not a stable hash (pseudonymisation, not
 * anonymisation — a GDPR trap per the plan §11.6, and still personal data). The value's *type* is
 * carried separately by the emitter where it is useful (`@Log` prints the parameter type beside the
 * placeholder), so the placeholder itself does not need to encode it.
 */

/**
 * Whether adorn may render raw values in its own emissions.
 *
 * - `'none'` — the safe default. Every value renders as {@link REDACTED} on every path.
 * - `'all'` — disclose raw values, for local debugging. A `@Sensitive`-marked site stays redacted
 *   even here — that veto is the only thing the annotation does on this path (DEC-PII-1).
 */
export type ValueDisclosure = 'none' | 'all';

const DEFAULT_DISCLOSURE: ValueDisclosure = 'none';

let disclosure: ValueDisclosure = DEFAULT_DISCLOSURE;

/**
 * The placeholder every redacted value renders as. Fixed, greppable, and type-agnostic.
 *
 * Kept as a single exported constant so `@Log`, `Descriptor.formatMessage`, and any future emitter
 * render the exact same token — a censor mark that differs between paths is a censor mark a reviewer
 * cannot grep for.
 */
export const REDACTED = '[REDACTED]';

/**
 * Turn raw-value disclosure on or off, process-wide. Mirrors the `setTimingSink` / `setViolationPolicy`
 * configuration shape (DEC-008): one setter, plain argument, resolved live rather than cached.
 *
 * Ships `'none'`. `'all'` is a **local-debugging** switch and is itself a risk — someone will set it
 * in production — which is why it is off by default and why `@Sensitive` still vetoes it.
 */
export function setValueDisclosure(mode: ValueDisclosure): void {
    if (mode !== 'none' && mode !== 'all') {
        throw new TypeError(`setValueDisclosure: mode must be 'none' or 'all', received ${String(mode)}`);
    }
    disclosure = mode;
}

/** The current disclosure mode. Read live by the emitters, so a change takes effect immediately. */
export function getValueDisclosure(): ValueDisclosure {
    return disclosure;
}

/** Restore the shipped default (`'none'`). Test support, mirroring `resetConfiguration`. */
export function resetValueDisclosure(): void {
    disclosure = DEFAULT_DISCLOSURE;
}

/**
 * The single disclosure decision, read live.
 *
 * `sensitive` is pre-resolved by the caller from the registry's sensitivity band — this function
 * never reads the registry, so the safe default holds with no annotation present. The annotation
 * only ever *removes* disclosure (`!sensitive`); it can never grant it. That is the whole of
 * `@Sensitive`'s role on the emission path (DEC-PII-1).
 */
export function shouldDiscloseValue(sensitive: boolean): boolean {
    return disclosure === 'all' && !sensitive;
}
