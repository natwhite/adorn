/**
 * `@adorn/test` — the fuzzing boundary report (Fuzzing Phase A).
 *
 * ## Why this is a condition of shipping, not a nicety (foundation §3, §7.2, §8; DEC-028 point 3)
 *
 * "A fuzzer that runs 10 000 cases and finds nothing has said something almost worthless unless it
 * also says *what it generated*." A green fuzz result is the most over-readable artifact this library
 * will ever produce, so the tool must always emit its own coverage boundary: which parameters it
 * generated for and how (parametric / delegation / curated / filter), which it declined, which it
 * only gap-filled, and which oracle it used. This is the direct descendant of `schema.ts`'s
 * "under-claim, never over-claim" and the sensitive-flow detector's scope report — "a clean
 * `Leaks: none` never masquerades as a clean bill of health" (`report.ts`, DEC-028).
 *
 * The report makes three states distinguishable that a bare pass/fail conflates:
 *   - **clean** — the oracle ran N cases and found nothing (with the coverage that backs that claim);
 *   - **found** — a reproducible counterexample, with its seed;
 *   - **declined** — the method was never actually fuzzed, and why.
 */

import {FuzzResult} from './oracle';
import {GenerationStrategy, ParameterArbitrary} from './arbitraries';
// The same disclosure discipline core uses (DEC-030). A fuzz report is an adorn emission, so the
// counterexample redacts by default and the value-free seed/path carries replay instead — the raw
// value returns only under setValueDisclosure('all'), and @Sensitive would still veto (via the switch).
import {REDACTED, shouldDiscloseValue} from '../../src/Core/redaction';

export interface FuzzReportOptions {
    /** The enumeration basis — how the fuzzed set was chosen — so the report states its own limits. */
    readonly basis?: string;
}

/**
 * Render one result, or a whole batch, as a human-readable boundary report. Always non-empty and
 * always prints the coverage: the act of printing it is the signal the fuzzer ran, and the coverage
 * is what a reader needs to know how far to trust a clean result.
 */
export function formatFuzzReport(
    results: FuzzResult | ReadonlyArray<FuzzResult>,
    options: FuzzReportOptions = {},
): string {
    const batch = Array.isArray(results) ? results : [results];
    const lines: string[] = [];

    lines.push('adorn fuzzing report (contract oracle — Phase B)');
    lines.push('================================================');
    if (options.basis) lines.push(`Scope: ${options.basis}`);
    lines.push('');

    if (batch.length === 0) {
        lines.push('Fuzzed 0 methods — nothing was pointed at the fuzzer.');
        lines.push('A clean report here means "nothing to fuzz", NOT "no bugs".');
        return lines.join('\n');
    }

    const fuzzed = batch.filter(r => !r.declined);
    const declined = batch.filter(r => r.declined);
    const findings = fuzzed.filter(r => !r.passed);

    // The oracle is named per method (a batch can mix modes), not once for the batch: a method with a
    // postcondition ran the postcondition oracle, one without ran only the weak-invariant floor.
    lines.push(
        `Fuzzed ${fuzzed.length} method(s); declined ${declined.length}; findings ${findings.length}.`,
    );

    for (const result of batch) {
        lines.push('');
        lines.push(...renderMethod(result));
    }

    // The standing warnings are printed once at the foot, deduplicated, so they are unmissable but
    // not repeated per method.
    const warnings = dedupe(batch.flatMap(r => r.warnings));
    if (warnings.length > 0) {
        lines.push('');
        lines.push('Warnings:');
        for (const warning of warnings) lines.push(`  ! ${warning}`);
    }

    return lines.join('\n');
}

function renderMethod(result: FuzzResult): string[] {
    const lines: string[] = [];
    const kind = result.isStatic ? 'static ' : '';
    const header = `${kind}${result.target}.${result.method}`;

    if (result.declined) {
        lines.push(`- ${header}: DECLINED — ${result.reason}`);
        lines.push(...renderCoverage(result.coverage, '    '));
        return lines;
    }

    if (result.passed) {
        lines.push(...renderClean(header, result));
    } else {
        const f = result.finding!;
        lines.push(`- ${header}: FOUND (${f.type}) — ${f.message}`);
        if (f.postconditionDescription) {
            lines.push(`    broke postcondition: ${f.postconditionDescription}`);
        }
        // The counterexample redacts by default (DEC-030); the value-free seed+path is the replay handle.
        lines.push(`    counterexample: ${formatArgs(f.counterexample)}`);
        lines.push(
            `    reproduce: seed ${f.seed}` +
                (f.path ? `, path ${f.path}` : '') +
                (f.numShrinks ? `, shrunk ${f.numShrinks}×` : ''),
        );
    }

    lines.push(...renderCoverage(result.coverage, '    '));
    if (result.invariantsChecked.length > 0) {
        lines.push(`    invariants re-checked: ${result.invariantsChecked.join(', ')}`);
    } else if (!result.isStatic) {
        lines.push('    invariants re-checked: none (class declares no field contracts)');
    }
    return lines;
}

/**
 * The clean line, worded so it never over-claims. A postcondition-mode run must say *which*
 * postconditions it checked (`oraclesChecked`) or a green result over-reads (foundation §8, DEC-028
 * pt 3). A weak-mode run keeps saying "no crash and no field-invariant break — NOT correctness".
 */
function renderClean(header: string, result: FuzzResult): string[] {
    const seed = result.seed !== undefined ? ` (seed ${result.seed})` : '';
    if (result.oracle === 'postcondition') {
        const checked =
            result.oraclesChecked.length > 0 ? result.oraclesChecked.join('; ') : '(none named)';
        return [
            `- ${header}: clean — ${result.numRuns} cases; postcondition oracle, guarantees held: ${checked}${seed}`,
        ];
    }
    return [
        `- ${header}: clean — ${result.numRuns} cases, no crash and no field-invariant break` +
            ` (weak-invariant oracle — NOT correctness)${seed}`,
    ];
}

/**
 * The coverage block — the load-bearing half. Every position is named with how it was generated, so a
 * reader can see which parameters were meaningfully fuzzed and which were only gap-filled or declined.
 */
function renderCoverage(coverage: ReadonlyArray<ParameterArbitrary>, indent: string): string[] {
    if (coverage.length === 0) {
        return [`${indent}parameters: none (nullary method)`];
    }
    const lines: string[] = [`${indent}coverage:`];
    for (const plan of coverage) {
        const name = plan.name ? ` '${plan.name}'` : '';
        const constraints = plan.constraints.length > 0 ? plan.constraints.join(' ∧ ') : '(none)';
        lines.push(`${indent}  [${plan.index}]${name}: ${describeStrategy(plan)}  {${constraints}}`);
    }
    return lines;
}

/**
 * Phrase a position's strategy, including the Q-3 caveat for gap-filled positions: an undecorated
 * position and one guarded only by a hand-written `CreateSimpleDecorator` closure are indistinguishable
 * to the registry (SMELL-14), so both surface here as "gap-filled", and the report says so rather than
 * pretending the closure case was covered.
 */
function describeStrategy(plan: ParameterArbitrary): string {
    switch (plan.strategy) {
        case 'parametric':
            return 'parametric (sound by construction)';
        case 'delegation':
            return 'delegation → fc.stringMatching';
        case 'curated':
            return 'curated sample set (partial by design)';
        case 'filter':
            return (
                'generate-and-filter' +
                (plan.acceptanceRate !== undefined
                    ? ` (~${Math.round(plan.acceptanceRate * 100)}% accepted${plan.starved ? ', STARVING' : ''})`
                    : '')
            );
        case 'gap-fill':
            return (
                'gap-filled with a broad arbitrary — NOT contract-generated (undecorated, or a ' +
                'hand-written closure invisible to the registry — the Q-3 floor)'
            );
        case 'declined':
            return `declined — ${plan.note || 'no sound generator'}`;
        default:
            return exhaustive(plan.strategy);
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatArgs(args: ReadonlyArray<unknown>): string {
    // Redact every counterexample value by default (DEC-030). The generated input is reproducible from
    // the seed+path printed on the reproduce line, so a redacted report stays fully replayable without
    // leaking argument values; setValueDisclosure('all') shows them for local debugging.
    return `[${args.map(renderArg).join(', ')}]`;
}

function renderArg(value: unknown): string {
    return shouldDiscloseValue(false) ? safeRender(value) : REDACTED;
}

function safeRender(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'symbol') return value.toString();
    try {
        return String(value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value)));
    } catch {
        return '[unrenderable]';
    }
}

function dedupe(items: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

function exhaustive(value: never): never {
    throw new Error(`unhandled generation strategy: ${String(value)}`);
}

// Referenced only for the type import above; keeps the strategy union in one place.
export type {GenerationStrategy};
