/**
 * **Superseded by `src/Core/Configuration.ts` (P3.2 / DEC-008).**
 *
 * This module held a single global object with one flag, `ErrorOnFieldConstraintMismatch`, which was
 * consulted nowhere (SMELL-4). It is not being replaced by a better global flag: a process-wide
 * boolean is the shape DEC-008 rejects outright, because it cannot distinguish a contract guarding
 * untrusted external input (which must survive production) from an internal self-check (which may
 * not). See the header of `Configuration.ts` for the reasoning and `ContractTrust` for the
 * replacement.
 *
 * The file is kept only so an in-flight import does not break mid-refactor. Nothing reads
 * {@link Configuration}; it has no effect on enforcement, and it should be deleted once the field
 * decorator path (P2.1) is rebuilt on the real configuration.
 *
 * Migration:
 *
 * ```ts
 * // before — inert
 * Configuration.ErrorOnFieldConstraintMismatch = false;
 *
 * // after — route violations instead of silently discarding them
 * import {setViolationPolicy} from './Configuration';
 * setViolationPolicy('warn');
 * ```
 */

export {
    ContractTrust,
    TrustOptions,
    ViolationPolicy,
    setViolationPolicy,
    setAssertEnforcement,
    setEnforcementMode,
    shouldEnforce,
} from './Configuration';

/**
 * @deprecated Inert. Reading or writing this changes nothing — it never had a consumer. Use the
 * trust model in `Configuration.ts` instead.
 */
export const Configuration = {
    /** @deprecated Never consulted. Superseded by `setViolationPolicy` (P3.2). */
    ErrorOnFieldConstraintMismatch: true,
};
