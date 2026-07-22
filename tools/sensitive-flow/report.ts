/**
 * The scope / emission-position report (DEC-026 point 4).
 *
 * ## Why this is a condition of shipping, not a nicety
 *
 * The narrowed threat model (DEC-025) partitions real leaks into *reported* (into an adorn sink) and
 * *permanently unreported* (out through a raw `console.log` or a non-adorn function). A clean leak
 * report that hides the second class is exactly the false-confidence failure `pii-redaction-plan.md`
 * §11.2 calls *"worse than no design at all"*. So the detector must print **its own scope** on every
 * run — what it analysed, and which `@Sensitive` values it saw flowing somewhere it therefore did
 * *not* analyse — not merely its findings.
 *
 * It also fixes the three-silences problem the spike measured (§4.3): a report that is printed
 * distinguishes *clean* (analysed N positions, found 0 leaks) from *never run* (no report at all).
 * A detector that is silent both when it is clean and when it never looked fails the standard the
 * spikes set — so this always prints the scope line, even at zero findings.
 */

import {AnalysisResult} from './analysis';

export interface ScopeReportOptions {
    /**
     * The enumeration basis — how the analysed set of files was chosen — so the report states its own
     * limits (DEC-007: a static scan only sees what it was pointed at). Optional; omitted when the
     * caller has nothing to add.
     */
    readonly basis?: string;
}

/**
 * Render the analysis result as a human-readable scope report. Always non-empty: the act of printing
 * it is the signal that the detector ran.
 */
export function formatScopeReport(result: AnalysisResult, options: ScopeReportOptions = {}): string {
    const lines: string[] = [];
    const {analyzedSinks, leaks, outOfScope} = result;

    lines.push('adorn sensitive-flow report');
    lines.push('===========================');
    if (options.basis) lines.push(`Scope: ${options.basis}`);

    // 1. What it looked at — the denominator. Silent-because-clean and silent-because-never-looked
    //    are made distinguishable here.
    lines.push('');
    lines.push(`Analysed ${analyzedSinks.length} adorn emission position(s):`);
    if (analyzedSinks.length === 0) {
        lines.push(
            '  (none — no @Log method or adorn-constrained parameter was found in the analysed files.',
        );
        lines.push('   A clean result here means "nothing to analyse", NOT "no sensitive data leaks".)');
    } else {
        for (const s of analyzedSinks) lines.push(`  - ${s.label}  ${s.via} [${s.emitter}]  ${s.site}`);
    }

    // 2. The actionable findings.
    lines.push('');
    if (leaks.length === 0) {
        lines.push('Leaks: none — no @Sensitive value reaches an adorn emitter.');
    } else {
        lines.push(`Leaks: ${leaks.length} — a @Sensitive value reaches an adorn emitter:`);
        for (const l of leaks) {
            lines.push(
                `  - ${l.source.label} (${l.source.kind}) -> ${l.sink.label} ${l.sink.via} at ${l.site}`,
            );
        }
    }

    // 3. The honesty disclosure — DEC-026 point 4. Values that left adorn's scope, named, so a clean
    //    leak report is never mistaken for a clean bill of health.
    lines.push('');
    if (outOfScope.length === 0) {
        lines.push('Out of scope: none observed.');
    } else {
        lines.push(
            `Out of scope: ${outOfScope.length} @Sensitive value(s) flowed to a non-adorn receiver ` +
                'and were NOT analysed (adorn is not in these call paths — DEC-025):',
        );
        for (const o of outOfScope) {
            lines.push(`  - ${o.source.label} -> ${o.receiver} at ${o.site}  [${o.reason}]`);
        }
        lines.push('');
        lines.push("  These are the developer's responsibility: adorn secures its OWN emissions, not a raw");
        lines.push('  console.log or a hand-rolled logger. A clean "Leaks: none" does not cover them.');
    }

    return lines.join('\n');
}
