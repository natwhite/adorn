/**
 * O1d — the telemetry-disclosure projection: "what leaves the process, and in what form" (DEC-035, DEC-036).
 *
 * The sixth projection, and a near-free one: because disclosure is a **declaration in the registry** (the
 * telemetry band + the sensitivity band), this can render a privacy-review table of every contract/observed
 * position whose value may leave the process on the observation `record` path — and, crucially, of every
 * position that is *redacted by default*, so the **absence** of a `@Telemetry.value()` is reviewable, which
 * a grep for `logger.info` never is. No logging library can produce this, because none knows what the
 * parameters are.
 *
 * ## It makes NO claim about runtime flows
 *
 * This is a projection of *declarations*, not a trace of *emissions*. It reports what disclosure each
 * position is configured to carry; it does not assert that a value ever actually flowed. There is no
 * false-confidence mode — a position marked `disclosed` here leaks only if the method is also observed.
 *
 * ## One resolver, so this cannot drift from the emitter (DEC-006)
 *
 * The disclosure state of each position is computed by the **same** `telemetryDisclosure` resolver
 * `ObservationBehavior` renders from. If this projection re-derived the sensitive/opt-in/global composition
 * it could report `[REDACTED]` for a position the emitter discloses — the exact "documented one thing, did
 * another" failure the project exists to prevent.
 *
 * ## The scanned denominator (DEC-007 risk 9, DEC-028)
 *
 * The table reflects only imported-and-evaluated modules, so it renders its own denominator — the set of
 * classes it scanned — and never presents a clean sheet as a clean bill of health. An empty table is the
 * expected result of forgetting to import the modules under review, which is indistinguishable from "nothing
 * discloses" unless it is said out loud.
 *
 * ## Layering (DEC-012)
 *
 * Imports from `Core/` only — the registry reads, the shared resolver, and the return sentinel. It binds to
 * **no** decorator adapter (not `@Telemetry`, not `@Observe`, not `ObservationBehavior`), which is guarded by
 * the layering test in `telemetry.test.ts`, exactly as `schema.ts`/`docs.ts` are.
 */

import {
    ContractTarget,
    getContractedClasses,
    getContractsForClass,
    getEffectiveParameterTelemetry,
    getTelemetryMethodKeysForClass,
    getTelemetryParameterIndices,
    MethodKey,
    ParameterContract,
} from '../Core/ContractRegistry';
import {
    resolveParameterDisclosure,
    resolveReturnDisclosure,
    ResolvedDisclosure,
} from '../Core/telemetryDisclosure';
import {RETURN_INDEX} from '../Core/Observation';

// ---------------------------------------------------------------------------
// The model — step 1's output. Plain data, no markdown.
// ---------------------------------------------------------------------------

/**
 * The disclosure a position is configured to carry.
 *
 * - `redacted` — deny-by-default: nothing said, the value stays `[REDACTED]`.
 * - `disclosed` — `@Telemetry.value()`/`.result()` opted the value in.
 * - `surrogate` — `@Telemetry.redact(strategy)` opts a derived surrogate in (see {@link PositionTelemetry.strategy}).
 * - `vetoed` — an explicit opt-in was overridden by `@Sensitive`; the value stays redacted, and the
 *   collision is surfaced here rather than hidden as an ordinary redacted cell (Q-24 R8).
 */
export type DisclosureState = 'redacted' | 'disclosed' | 'surrogate' | 'vetoed';

/** One parameter or return position and the disclosure it carries. */
export interface PositionTelemetry {
    /** Parameter index `>= 0`, or {@link RETURN_INDEX} for the return. */
    readonly index: number;
    /** Recovered/explicit name, or `arg{index}` / `return`. */
    readonly name: string;
    readonly kind: 'parameter' | 'return';
    readonly state: DisclosureState;
    /** The surrogate strategy, present only when `state === 'surrogate'`. */
    readonly strategy?: string;
    /** `@Sensitive` is in force on this position. */
    readonly sensitive: boolean;
}

/** One method's positions. */
export interface MethodTelemetry {
    readonly name: string;
    readonly isStatic: boolean;
    readonly positions: ReadonlyArray<PositionTelemetry>;
}

/** One class's methods. */
export interface ClassTelemetry {
    readonly name: string;
    readonly methods: ReadonlyArray<MethodTelemetry>;
}

/**
 * The privacy-review model. `classes` is the disclosure table; `scanned` is the denominator — the classes
 * this report actually saw, so a reader can tell "nothing discloses" from "nothing was imported".
 */
export interface TelemetryReport {
    readonly classes: ReadonlyArray<ClassTelemetry>;
    readonly scanned: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Step 1 — extraction
// ---------------------------------------------------------------------------

/**
 * Build the telemetry model for one class. The report carries a one-class scanned denominator so the type
 * is uniform with {@link telemetryForContracts} — every report states what it saw.
 */
export function telemetryForClass(constructor: Function): TelemetryReport {
    if (typeof constructor !== 'function') {
        throw new TypeError('telemetryForClass: expected a constructor function');
    }
    return {classes: [classTelemetryOf(constructor)], scanned: [nameOf(constructor)]};
}

/**
 * Build the telemetry model for every class in the enumerable registry (DEC-011). Reflects only
 * imported-and-evaluated modules (DEC-007) — hence `scanned`.
 */
export function telemetryForContracts(): TelemetryReport {
    const classes = getContractedClasses();
    return {classes: classes.map(classTelemetryOf), scanned: classes.map(nameOf)};
}

interface MethodSite {
    readonly key: MethodKey;
    readonly isStatic: boolean;
    readonly target: ContractTarget;
    readonly params?: ReadonlyArray<ParameterContract>;
}

function classTelemetryOf(constructor: Function): ClassTelemetry {
    const sites = collectSites(constructor);
    const methods = sites.map(methodTelemetryOf);
    methods.sort(byBandThenName);
    return {name: nameOf(constructor), methods};
}

/**
 * Every method to report on: the union of contract methods (which supply recovered parameter names) and
 * telemetry-marked methods (so a `@Telemetry.value()` on a method with no *constraint* is still reported —
 * a value could otherwise leave the process without appearing in this table, the DEC-016 asymmetry).
 */
function collectSites(constructor: Function): MethodSite[] {
    const byId = new Map<string, MethodSite>();
    const idOf = (isStatic: boolean, key: MethodKey) => `${isStatic ? 's' : 'i'}:${String(key)}`;

    getContractsForClass(constructor).forEach(entry => {
        byId.set(idOf(entry.isStatic, entry.key), {
            key: entry.key,
            isStatic: entry.isStatic,
            target: entry.target,
            params: entry.contract.params,
        });
    });

    getTelemetryMethodKeysForClass(constructor).forEach(entry => {
        const id = idOf(entry.isStatic, entry.key);
        if (!byId.has(id)) byId.set(id, {key: entry.key, isStatic: entry.isStatic, target: entry.target});
    });

    return Array.from(byId.values());
}

function methodTelemetryOf(site: MethodSite): MethodTelemetry {
    const nameByIndex = new Map<number, string>();
    const indices = new Set<number>();
    (site.params || []).forEach(p => {
        indices.add(p.index);
        if (typeof p.name === 'string' && p.name.length > 0) nameByIndex.set(p.index, p.name);
    });
    getTelemetryParameterIndices(site.target, site.key).forEach(index => indices.add(index));

    const positions: PositionTelemetry[] = Array.from(indices)
        .sort((a, b) => a - b)
        .map(index => {
            const resolved = resolveParameterDisclosure(site.target, site.key, index);
            const explicit = getEffectiveParameterTelemetry(site.target, site.key, index)?.name;
            const name = nameByIndex.get(index) || explicit || `arg${index}`;
            return position(index, name, 'parameter', resolved);
        });

    // The return: reported only when it carries a `@Telemetry.result()` opt-in or is `@Sensitive` — an
    // un-marked return discloses nothing and would be a redundant redacted row on every method.
    const returnResolved = resolveReturnDisclosure(site.target, site.key);
    if (returnResolved.declared || returnResolved.sensitive) {
        positions.push(position(RETURN_INDEX, 'return', 'return', returnResolved));
    }

    return {name: String(site.key), isStatic: site.isStatic, positions};
}

function position(
    index: number,
    name: string,
    kind: 'parameter' | 'return',
    resolved: ResolvedDisclosure,
): PositionTelemetry {
    const base = {index, name, kind, sensitive: resolved.sensitive};
    if (resolved.vetoed) return {...base, state: 'vetoed'};
    if (resolved.disclosure === 'value') return {...base, state: 'disclosed'};
    if (typeof resolved.disclosure === 'object') {
        return {...base, state: 'surrogate', strategy: resolved.disclosure.redact};
    }
    return {...base, state: 'redacted'};
}

/** Instance members before statics, alphabetical within each band — deterministic, diff-stable. */
function byBandThenName(a: MethodTelemetry, b: MethodTelemetry): number {
    if (a.isStatic !== b.isStatic) return a.isStatic ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function nameOf(constructor: Function): string {
    return constructor.name || '(anonymous class)';
}

// ---------------------------------------------------------------------------
// Step 2 — markdown rendering
// ---------------------------------------------------------------------------

export interface TelemetryReportOptions {
    /** Top-level heading. Defaults to `Telemetry Disclosure`. */
    readonly title?: string;
}

const DEFAULT_TITLE = 'Telemetry Disclosure';

const STATE_DETAIL: {readonly [K in DisclosureState]: string} = {
    disclosed: 'value emitted',
    surrogate: 'surrogate emitted',
    vetoed: 'opted-in, vetoed by @Sensitive',
    redacted: 'redacted (default)',
};

/**
 * Render a telemetry report as markdown, with its scanned denominator stated up front. `serializeTelemetry`
 * is the projection's serialiser, mirroring `serializeSchema`/`renderMarkdown`.
 */
export function serializeTelemetry(report: TelemetryReport, options?: TelemetryReportOptions): string {
    const title = (options && options.title) || DEFAULT_TITLE;
    const lines: string[] = [`# ${title}`, ''];

    // The denominator, always — a clean table is never a clean bill of health (DEC-007 / DEC-028).
    if (report.scanned.length === 0) {
        lines.push('_No classes were scanned._', '');
        lines.push(
            'Disclosure is discovered at runtime, so a class is only visible once the module declaring ' +
                'it has been imported and evaluated. An empty report may mean nothing discloses — or that ' +
                'the modules under review were never imported.',
            '',
        );
        return lines.join('\n').replace(/\n+$/, '') + '\n';
    }

    lines.push(`_Scanned ${report.scanned.length} class(es): ${report.scanned.join(', ')}._`, '');
    lines.push(
        '> This reports what each position is **configured to disclose**, from recorded declarations. It ' +
            'makes no claim that a value ever actually flowed at runtime.',
        '',
    );

    report.classes.forEach(classReport => {
        lines.push(`## ${classReport.name}`, '');
        if (classReport.methods.length === 0) {
            lines.push('_No telemetry-relevant methods recorded._', '');
            return;
        }
        classReport.methods.forEach(method => renderMethod(method, lines));
    });

    return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * Walk the registry and render the whole privacy-review table in one call — the entry point a review script
 * uses. Equivalent to `serializeTelemetry(telemetryForContracts(), options)`.
 */
export function generateTelemetryReport(options?: TelemetryReportOptions): string {
    return serializeTelemetry(telemetryForContracts(), options);
}

function renderMethod(method: MethodTelemetry, lines: string[]): void {
    lines.push(`### ${method.name}${method.isStatic ? ' _(static)_' : ''}`, '');
    if (method.positions.length === 0) {
        lines.push('_No parameters or return recorded._', '');
        return;
    }
    lines.push('| Position | Name | Discloses | @Sensitive |', '| --- | --- | --- | --- |');
    method.positions.forEach(p => {
        const position = p.kind === 'return' ? 'return' : `#${p.index}`;
        lines.push(
            `| ${position} | \`${escapeCell(p.name)}\` | ${escapeCell(discloses(p))} ` +
                `| ${p.sensitive ? 'yes' : '—'} |`,
        );
    });
    lines.push('');
}

function discloses(p: PositionTelemetry): string {
    if (p.state === 'surrogate') return `${STATE_DETAIL.surrogate} (${p.strategy})`;
    return STATE_DETAIL[p.state];
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|');
}
