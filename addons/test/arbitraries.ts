/**
 * `@adorn/test` — arbitrary generation from constraint descriptors (Fuzzing Phase A).
 *
 * This is the fast-check bridge the core anticipated but was forbidden to build: `Descriptor.ts`
 * types `Arbitrary = unknown` "because `fast-check` is not a dependency of this package… When the
 * fast-check bridge lands (`Projections/arbitraries.ts`), narrow this alias in one place." That
 * bridge is **here**, in a separate add-on, never in core — the DEC-019 lesson applied to fast-check
 * exactly as it was applied to rxjs: an optional/testing dependency must not be reachable from
 * `require('adorn')`. See `docs/fuzzing-foundation.md` §6.2.
 *
 * ## The one place the alias is narrowed
 *
 * Core keeps `Arbitrary = unknown`. This module is the single place where that opaque shape becomes
 * `fc.Arbitrary<unknown>`. Nothing in `src/` imports fast-check; the add-on maps a descriptor's
 * `{kind, constraint, params}` onto a fast-check arbitrary from the outside, so the built-in
 * descriptors stay shape-only and core stays clean (verified by `isolation.test.ts`).
 *
 * ## The governing invariant — sound generation, or decline (foundation §4.1)
 *
 * A generator derived from a constraint must produce **only** values that constraint accepts —
 * icontract-hypothesis's *"the inferred strategy must satisfy the preconditions"*, adopted as
 * adorn's law and recorded as a decision. This is the generation twin of `schema.ts`'s "under-claim,
 * never over-claim": a schema must never reject a value enforcement accepts; a generator must never
 * *produce* a value enforcement rejects. Every mapping below is one of:
 *
 * - **parametric** — derived from `params`, sound by construction (numeric bounds, lengths, integer).
 * - **delegation** — `matches` rides `fc.stringMatching` (foundation §4.4).
 * - **curated** — `email`/`url` are an honest, partial sample set, never a pretence of generality.
 * - **filter** — a broad arbitrary narrowed by the constraint's own `predicate` (sound; may starve).
 * - **declined** — an identity this bridge does not recognise; generate nothing and say so (Q-3).
 *
 * Where a mapping *could* drift from its predicate (`multipleOf` in binary float; `stringMatching`
 * on an exotic regex), a `.filter(predicate)` soundness guard is composed on top. It reuses the
 * descriptor's own derived predicate — the same code enforcement runs — so it cannot drift, and it
 * costs almost nothing because the base already targets the accepted set. When in doubt, filter;
 * when filtering would starve, decline (foundation §4.1).
 */

import * as fc from 'fast-check';
import {ConstraintDescriptor, constraintFromJSON, SerializedConstraint} from '../../src/Core/Descriptor';

/**
 * The narrowed alias. Core's `Arbitrary = unknown` becomes `fc.Arbitrary<T>` here, and **only**
 * here — the "narrow it in one place" the Descriptor header asked for, kept in the add-on so core
 * never depends on fast-check.
 */
export type Arbitrary<T = unknown> = fc.Arbitrary<T>;

/** How a position (or a single constraint) was generated — the honest coverage label. */
export type GenerationStrategy = 'parametric' | 'delegation' | 'curated' | 'filter' | 'gap-fill' | 'declined';

/** The outcome of mapping one constraint descriptor to an arbitrary. */
export interface ConstraintArbitrary {
    readonly strategy: GenerationStrategy;
    /** `null` exactly when `strategy === 'declined'` — the honest absence (Q-3 floor). */
    readonly arbitrary: Arbitrary<unknown> | null;
    /** The constraint identity, so a report can name what it did or could not do. */
    readonly constraint: string;
    /** Present when a soundness guard or fallback filter is composed on top of the base. */
    readonly note?: string;
}

/** The plan for one parameter position, across however many constraints stack on it. */
export interface ParameterArbitrary {
    readonly index: number;
    readonly name?: string;
    readonly strategy: GenerationStrategy;
    /** `null` only for a `gap-fill` position (no registry-visible constraint) or a declined one. */
    readonly arbitrary: Arbitrary<unknown> | null;
    /** The constraint identities that stack on this position, in declaration order. */
    readonly constraints: ReadonlyArray<string>;
    /** True when a `.filter` narrows a broad base — the place starvation can occur. */
    readonly filtered: boolean;
    /**
     * Fraction of a broad base's samples the conjunction accepts, measured for `filter` positions.
     * `undefined` for positions that need no filter (sound by construction).
     */
    readonly acceptanceRate?: number;
    /** True when the accepted set is a tiny slice — the Hypothesis `filter_too_much` analogue. */
    readonly starved: boolean;
    /**
     * True when no value could be generated at all (contradictory constraints, or a filter that
     * accepts nothing). A method with a declined position cannot be soundly fuzzed on it.
     */
    readonly declined: boolean;
    readonly note?: string;
}

/** Below this acceptance fraction a filtered position is flagged as starving (foundation §7.2). */
export const STARVATION_THRESHOLD = 0.25;

/** How many samples to draw when measuring a filter's acceptance rate. */
const ACCEPTANCE_SAMPLE_SIZE = 200;

/** Bound on the pre-image of `multipleOf`'s `map`, so `n * divisor` cannot overflow to Infinity. */
const MULTIPLE_OF_RANGE = 1_000_000;

// ---------------------------------------------------------------------------
// Curated sample sets (foundation §4.2 — "honest but partial", never general)
// ---------------------------------------------------------------------------

/**
 * A curated set of realistic + a couple of adversarial-but-valid addresses. This is deliberately a
 * *sample*, not a pretence of RFC 5322 generality — `string.ts` says so outright: "the honest answer
 * is a curated sample set rather than a pretence of full generality". Each is guarded by the email
 * descriptor's own predicate before use, so an unsound sample can never leak in.
 */
const EMAIL_SAMPLES: ReadonlyArray<string> = [
    'user@example.com',
    'first.last@sub.domain.io',
    'name+tag@host.co',
    'a@b.cd',
    'admin@localhost.dev',
    'q1w2e3@numbers123.net',
];

// ---------------------------------------------------------------------------
// The per-constraint map — the crux (foundation §4.2)
// ---------------------------------------------------------------------------

/**
 * Map one constraint descriptor to a fast-check arbitrary, or decline.
 *
 * The result's `arbitrary`, where present, is **sound**: every value it produces satisfies
 * `descriptor.predicate`. That is asserted directly in `arbitraries.test.ts`, the mirror of
 * `schema.test.ts`'s under-claim tests.
 */
export function arbitraryForConstraint(descriptor: ConstraintDescriptor): ConstraintArbitrary {
    const constraint = descriptor.constraint;
    const params = descriptor.params as Record<string, unknown>;

    switch (constraint) {
        // --- numeric, parametric ------------------------------------------------
        case 'min':
            return parametric(constraint, fc.double(finiteBounds({min: num(params.min)})));
        case 'max':
            return parametric(constraint, fc.double(finiteBounds({max: num(params.max)})));
        case 'greaterThan':
            return parametric(
                constraint,
                fc.double(finiteBounds({min: num(params.exclusiveMin), minExcluded: true})),
            );
        case 'lessThan':
            return parametric(
                constraint,
                fc.double(finiteBounds({max: num(params.exclusiveMax), maxExcluded: true})),
            );
        case 'between':
            return parametric(
                constraint,
                fc.double(finiteBounds({min: num(params.min), max: num(params.max)})),
            );
        case 'integer':
            return parametric(constraint, fc.integer());
        case 'multipleOf': {
            // Sound and *guaranteeing* the property: every output is `n * divisor`. The `.filter`
            // is a float-safety guard (0.3 % 0.1 !== 0 territory), near-free because the map already
            // lands on multiples. Foundation §4.2's "multipleOf has a floor" made explicit.
            const divisor = num(params.multipleOf);
            const base = fc.integer({min: -MULTIPLE_OF_RANGE, max: MULTIPLE_OF_RANGE}).map(n => n * divisor);
            return {
                strategy: 'parametric',
                arbitrary: base.filter(descriptor.predicate),
                constraint,
                note: 'map-based, guarded by the predicate for fractional-divisor float edges',
            };
        }

        // --- string, parametric -------------------------------------------------
        case 'minLength':
        case 'notEmpty':
            return parametric(constraint, fc.string({minLength: int(params.minLength)}));
        case 'maxLength':
            return parametric(constraint, fc.string({maxLength: int(params.maxLength)}));

        // --- string, delegation (foundation §4.4) -------------------------------
        case 'matches':
            return matchesArbitrary(descriptor);

        // --- string, curated (foundation §4.2) ----------------------------------
        case 'email':
            return curatedFrom(constraint, EMAIL_SAMPLES, descriptor.predicate);
        case 'url':
            return curatedUrl(descriptor);

        // --- membership, parametric (DEC-031's ideal case) ----------------------
        case 'oneOf': {
            // The perfectly-sound generator: `fc.constantFrom` over the exact enum members produces
            // ONLY members, so there is no filtering and no starvation — the generation twin of the
            // `{enum:[…]}` schema fragment being exact rather than an under-claim. (A `@OneOf`
            // authored through `OneOf([...])` always has a non-empty member set; a descriptor built
            // directly with an empty set generates nothing, so decline rather than call
            // `fc.constantFrom()` with no arguments.)
            const values = params.values as unknown[];
            if (!Array.isArray(values) || values.length === 0) {
                return {strategy: 'declined', arbitrary: null, constraint, note: 'oneOf has no members'};
            }
            return {
                strategy: 'parametric',
                arbitrary: fc.constantFrom(...values),
                constraint,
                note: 'fc.constantFrom over the enum members — sound by construction, no filter',
            };
        }

        // --- composition, recursive (DEC-050 — the add-on crux) -----------------
        case 'arrayOf': {
            // Recurse: reconstruct the item descriptor and resolve ITS arbitrary through the same
            // bridge, so an array of a generatable kind is sound (only valid arrays) and an array of a
            // declining kind declines. This recursion is the generation twin of `array.ts`'s
            // `derive`/`schema` recursion (DEC-031's ideal).
            const p = params as {item: SerializedConstraint; minItems?: number; maxItems?: number};
            const item = arbitraryForConstraint(constraintFromJSON(p.item));
            const opts: {minLength?: number; maxLength?: number} = {};
            if (p.minItems !== undefined) opts.minLength = p.minItems;
            if (p.maxItems !== undefined) opts.maxLength = p.maxItems;

            if (item.strategy === 'declined' || !item.arbitrary) {
                // The item cannot be generated. If the empty array is admissible, still offer it;
                // otherwise decline honestly (an array of an ungeneratable kind, required non-empty).
                if ((p.minItems ?? 0) === 0) {
                    return {
                        strategy: 'parametric',
                        arbitrary: fc.constant([] as unknown[]),
                        constraint,
                        note: 'item arbitrary declined; only the empty array is generated',
                    };
                }
                return {
                    strategy: 'declined',
                    arbitrary: null,
                    constraint,
                    note: 'item arbitrary declined and a non-empty array is required',
                };
            }

            // `fc.array` of a sound element arbitrary produces only valid arrays; the `.filter` guard
            // is near-free and pins the invariant (the same discipline as `multipleOf`/`matches`).
            return {
                strategy: 'parametric',
                arbitrary: fc.array(item.arbitrary, opts).filter(descriptor.predicate),
                constraint,
                note: `fc.array over ${item.strategy} item arbitrary`,
            };
        }

        // --- the Q-3 floor ------------------------------------------------------
        default:
            // An identity this bridge does not know — the analogue of a hand-written predicate.
            // Generate nothing here and say so; a stacked/whole-parameter filter may still reach it
            // (arbitraryForParameter), because a descriptor always carries a usable predicate.
            return {strategy: 'declined', arbitrary: null, constraint};
    }
}

/**
 * `matches` rides fast-check's regex inverter (`fc.stringMatching`, 3.10.0+). This moves regex
 * generation from "hard" to "parametric via delegation" (foundation §4.4) — adorn does not reinvent
 * generation, it projects onto a library that already does it.
 *
 * fast-check refuses some flags (`i`, and others `stringMatching` cannot invert) by throwing at
 * construction. That caveat is inherited honestly: when delegation is unavailable we fall back to a
 * broad string filtered by the constraint's real predicate — sound, and flagged as `filter` so the
 * report says the regex could only be generated by filtering.
 */
function matchesArbitrary(descriptor: ConstraintDescriptor): ConstraintArbitrary {
    const params = descriptor.params as {pattern: {source: string; flags: string}};
    const regex = new RegExp(params.pattern.source, params.pattern.flags);
    try {
        const generated = fc.stringMatching(regex);
        return {
            // Delegation, with a predicate soundness guard: stringMatching targets the pattern and
            // the predicate is `regex.test`, so the guard rejects ~nothing but pins the invariant.
            strategy: 'delegation',
            arbitrary: generated.filter(descriptor.predicate),
            constraint: 'matches',
            note: 'fc.stringMatching, guarded by the predicate',
        };
    } catch {
        return {
            strategy: 'filter',
            arbitrary: fc.string().filter(descriptor.predicate),
            constraint: 'matches',
            note: 'fc.stringMatching could not invert this regex (flag unsupported) — generate-and-filter',
        };
    }
}

/**
 * `url` has no regex to invert (it is parsed with `new URL`), so a curated set is constructed from
 * the descriptor's own accepted `protocols` and guarded by its predicate. Honest and partial.
 */
function curatedUrl(descriptor: ConstraintDescriptor): ConstraintArbitrary {
    const params = descriptor.params as {protocols: string[]};
    const hosts = ['example.com', 'sub.example.org/a/b?x=1', 'host.io'];
    const samples: string[] = [];
    for (const protocol of params.protocols) {
        for (const host of hosts) samples.push(`${protocol}//${host}`);
    }
    return curatedFrom('url', samples, descriptor.predicate);
}

// ---------------------------------------------------------------------------
// The per-parameter composer — conjunction of stacked constraints (foundation §4.3)
// ---------------------------------------------------------------------------

/**
 * Build the arbitrary for one parameter position, across every constraint that stacks on it.
 *
 * Stacked constraints are a **conjunction** — the same logical AND enforcement applies and the same
 * union DEC-021/DEC-022 resolve down a prototype chain. Unlike `schema.ts`, generation cannot fall
 * back to "just AND them": it must actually *produce* a member of the intersection. The strategy
 * (foundation §4.3, clojure.spec's `s/and`):
 *
 *   1. Build the tightest parametric base from the combinable subset (numeric bounds / string
 *      lengths / integer) — the same merge `schema.ts` computes from the same params.
 *   2. `.filter()` by the conjunction of the whole descriptor list — reusing the real predicates, so
 *      no drift — to pick up whatever the base did not capture (`multipleOf`, a pattern, an unknown).
 *   3. Measure the filtered fraction and surface starvation, rather than hanging (foundation §7.2).
 *
 * A single constraint short-circuits to {@link arbitraryForConstraint}. Zero constraints is a
 * `gap-fill` position (the method composer supplies a broad arbitrary).
 */
export function arbitraryForParameter(
    constraints: ReadonlyArray<ConstraintDescriptor>,
    index: number,
    name?: string,
): ParameterArbitrary {
    const identities = constraints.map(c => c.constraint);

    if (constraints.length === 0) {
        return {
            index,
            name,
            strategy: 'gap-fill',
            arbitrary: null,
            constraints: identities,
            filtered: false,
            starved: false,
            declined: false,
        };
    }

    if (constraints.length === 1) {
        const single = arbitraryForConstraint(constraints[0]);
        if (single.strategy !== 'declined' && single.arbitrary) {
            return {
                index,
                name,
                strategy: single.strategy,
                arbitrary: single.arbitrary,
                constraints: identities,
                filtered: single.strategy === 'filter',
                starved: false,
                declined: false,
                note: single.note,
            };
        }
        // A lone unknown identity: fall through to the filter path below, which can still generate
        // from a broad base of the right kind because the descriptor carries a predicate.
    }

    // --- multi-constraint (or a lone unknown identity): base + conjunction filter ----------------
    const predicate = conjunction(constraints);
    const base = mergedBase(constraints);

    if (!base) {
        // No base of a determinable kind (e.g. constraints that mix number and string, which no
        // single value can satisfy). Decline rather than pretend.
        return {
            index,
            name,
            strategy: 'declined',
            arbitrary: null,
            constraints: identities,
            filtered: false,
            starved: false,
            declined: true,
            note: 'constraints have no common generatable kind (e.g. numeric ∧ string)',
        };
    }

    const residualOnly = residualBeyondBounds(constraints);
    if (!residualOnly) {
        // The merged parametric base is exact — every value already satisfies the conjunction, so no
        // filter is needed. `min ∧ max ∧ integer` lands here: sound by construction, reported honestly
        // as parametric rather than as a filter it never had to run.
        return {
            index,
            name,
            strategy: 'parametric',
            arbitrary: base.arbitrary,
            constraints: identities,
            filtered: false,
            starved: false,
            declined: false,
            note: 'tightest parametric merge of stacked bounds',
        };
    }

    const acceptanceRate = measureAcceptance(base.arbitrary, predicate);
    if (acceptanceRate === 0) {
        return {
            index,
            name,
            strategy: 'declined',
            arbitrary: null,
            constraints: identities,
            filtered: true,
            acceptanceRate,
            starved: true,
            declined: true,
            note: 'generate-and-filter accepted none of its samples — the intersection is too narrow',
        };
    }

    return {
        index,
        name,
        strategy: 'filter',
        arbitrary: base.arbitrary.filter(predicate),
        constraints: identities,
        filtered: true,
        acceptanceRate,
        starved: acceptanceRate < STARVATION_THRESHOLD,
        declined: false,
        note: base.note,
    };
}

// ---------------------------------------------------------------------------
// Merge logic — the same intersection schema.ts computes (foundation §4.3 step 1)
// ---------------------------------------------------------------------------

interface MergedBase {
    readonly arbitrary: Arbitrary<unknown>;
    readonly kind: 'number' | 'string';
    readonly note?: string;
}

/**
 * Build the tightest parametric base for a stack of constraints, of whichever kind dominates. Number
 * wins if any numeric constraint is present; otherwise string. Mixed kinds return `null` (no single
 * value is both a number and a string), which the caller turns into an honest decline.
 */
function mergedBase(constraints: ReadonlyArray<ConstraintDescriptor>): MergedBase | null {
    const hasNumber = constraints.some(c => c.kind === 'number');
    const hasString = constraints.some(c => c.kind === 'string');
    if (hasNumber && hasString) return null;

    if (hasNumber) {
        const bounds = mergeNumericBounds(constraints);
        const wantsInteger = constraints.some(c => c.constraint === 'integer');
        if (wantsInteger) {
            const min = bounds.min === undefined ? undefined : integerCeil(bounds.min, bounds.minExcluded);
            const max = bounds.max === undefined ? undefined : integerFloor(bounds.max, bounds.maxExcluded);
            if (min !== undefined && max !== undefined && min > max) {
                // No integer in range — signal an empty base so the caller declines cleanly.
                return {arbitrary: fc.integer({min: 0, max: 0}).filter(() => false), kind: 'number'};
            }
            const options: {min?: number; max?: number} = {};
            if (min !== undefined) options.min = min;
            if (max !== undefined) options.max = max;
            return {arbitrary: fc.integer(options), kind: 'number', note: 'integer base'};
        }
        return {arbitrary: fc.double(finiteBounds(bounds)), kind: 'number', note: 'double base'};
    }

    // string
    const lengths = mergeStringLengths(constraints);
    const options: {minLength?: number; maxLength?: number} = {};
    if (lengths.minLength !== undefined) options.minLength = lengths.minLength;
    if (lengths.maxLength !== undefined) options.maxLength = lengths.maxLength;
    return {arbitrary: fc.string(options), kind: 'string', note: 'string base'};
}

interface NumericBounds {
    min?: number;
    max?: number;
    minExcluded?: boolean;
    maxExcluded?: boolean;
}

/** Conjunction of bounds: the tightest lower and upper, exclusive winning a tie (as in schema.ts). */
function mergeNumericBounds(constraints: ReadonlyArray<ConstraintDescriptor>): NumericBounds {
    const bounds: NumericBounds = {};
    for (const c of constraints) {
        const p = c.params as Record<string, unknown>;
        switch (c.constraint) {
            case 'min':
                tightenLower(bounds, num(p.min), false);
                break;
            case 'greaterThan':
                tightenLower(bounds, num(p.exclusiveMin), true);
                break;
            case 'between':
                tightenLower(bounds, num(p.min), false);
                tightenUpper(bounds, num(p.max), false);
                break;
            case 'max':
                tightenUpper(bounds, num(p.max), false);
                break;
            case 'lessThan':
                tightenUpper(bounds, num(p.exclusiveMax), true);
                break;
            default:
                break; // integer / multipleOf contribute no bound
        }
    }
    return bounds;
}

function tightenLower(bounds: NumericBounds, value: number, excluded: boolean): void {
    if (bounds.min === undefined || value > bounds.min) {
        bounds.min = value;
        bounds.minExcluded = excluded;
    } else if (value === bounds.min && excluded) {
        // Same bound, exclusive is the tighter of the two — a tie resolves toward exclusion.
        bounds.minExcluded = true;
    }
}

function tightenUpper(bounds: NumericBounds, value: number, excluded: boolean): void {
    if (bounds.max === undefined || value < bounds.max) {
        bounds.max = value;
        bounds.maxExcluded = excluded;
    } else if (value === bounds.max && excluded) {
        bounds.maxExcluded = true;
    }
}

interface StringLengths {
    minLength?: number;
    maxLength?: number;
}

function mergeStringLengths(constraints: ReadonlyArray<ConstraintDescriptor>): StringLengths {
    const lengths: StringLengths = {};
    for (const c of constraints) {
        const p = c.params as Record<string, unknown>;
        if (c.constraint === 'minLength' || c.constraint === 'notEmpty') {
            const v = int(p.minLength);
            if (lengths.minLength === undefined || v > lengths.minLength) lengths.minLength = v;
        } else if (c.constraint === 'maxLength') {
            const v = int(p.maxLength);
            if (lengths.maxLength === undefined || v < lengths.maxLength) lengths.maxLength = v;
        }
    }
    return lengths;
}

/**
 * True when every constraint's contribution is fully captured by the merged parametric base, so no
 * `.filter` is needed. Only bound/length/integer constraints are "capturable"; `multipleOf`, any
 * pattern, and any unknown identity leave a residual the base cannot express, and therefore need the
 * conjunction filter. Returns `true` when a residual exists.
 */
function residualBeyondBounds(constraints: ReadonlyArray<ConstraintDescriptor>): boolean {
    const capturable = new Set(['min', 'max', 'greaterThan', 'lessThan', 'between', 'integer']);
    const capturableString = new Set(['minLength', 'maxLength', 'notEmpty']);
    return constraints.some(c => !capturable.has(c.constraint) && !capturableString.has(c.constraint));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parametric(constraint: string, arbitrary: Arbitrary<unknown>): ConstraintArbitrary {
    return {strategy: 'parametric', arbitrary, constraint};
}

/**
 * A curated `constantFrom`, guarded by the descriptor's predicate so an unsound sample cannot leak
 * in. If every sample fails the predicate the set is empty and we decline rather than emit an
 * arbitrary that generates nothing.
 */
function curatedFrom(
    constraint: string,
    samples: ReadonlyArray<string>,
    predicate: (v: unknown) => boolean,
): ConstraintArbitrary {
    const valid = samples.filter(predicate);
    if (valid.length === 0) {
        return {
            strategy: 'declined',
            arbitrary: null,
            constraint,
            note: 'no curated sample satisfied the predicate',
        };
    }
    return {
        strategy: 'curated',
        arbitrary: fc.constantFrom(...valid),
        constraint,
        note: `curated sample set of ${valid.length} (partial by design, not general)`,
    };
}

/** The conjunction of every descriptor's predicate — the real enforcement, reused, so it cannot drift. */
function conjunction(constraints: ReadonlyArray<ConstraintDescriptor>): (value: unknown) => boolean {
    return (value: unknown) => constraints.every(c => c.predicate(value));
}

/**
 * Measure the fraction of a broad base's samples that satisfy `predicate`. Sampling the *unfiltered*
 * base is always safe (it never starves); the number is the Hypothesis `filter_too_much` signal.
 */
export function measureAcceptance(base: Arbitrary<unknown>, predicate: (v: unknown) => boolean): number {
    // Seeded so the measurement — and therefore the starvation flag and coverage report — is
    // deterministic. The base is always the *unfiltered* arbitrary, so sampling it never starves.
    const samples = fc.sample(base, {numRuns: ACCEPTANCE_SAMPLE_SIZE, seed: 0});
    const accepted = samples.filter(predicate).length;
    return accepted / samples.length;
}

/**
 * fast-check's `double` can emit `NaN` and `±Infinity` by default; the numeric predicates reject
 * `NaN` (Q-7 `isNumeric`) and reject `Infinity` against a finite upper/lower bound, so both would be
 * *unsound* to produce. `noNaN` + `noDefaultInfinity` keep generation inside the accepted set. This
 * under-generates (never Infinity) which soundness permits — declining a value costs coverage, not
 * trust (foundation §4.1).
 */
interface DoubleOptions {
    min?: number;
    max?: number;
    minExcluded?: boolean;
    maxExcluded?: boolean;
    noNaN?: boolean;
    noDefaultInfinity?: boolean;
}

function finiteBounds(bounds: NumericBounds): DoubleOptions {
    const options: DoubleOptions = {noNaN: true, noDefaultInfinity: true};
    if (bounds.min !== undefined) options.min = bounds.min;
    if (bounds.max !== undefined) options.max = bounds.max;
    if (bounds.minExcluded) options.minExcluded = true;
    if (bounds.maxExcluded) options.maxExcluded = true;
    return options;
}

/** Smallest integer strictly/inclusively above a lower bound. */
function integerCeil(value: number, excluded?: boolean): number {
    const ceil = Math.ceil(value);
    return excluded && ceil === value ? ceil + 1 : ceil;
}

/** Largest integer strictly/inclusively below an upper bound. */
function integerFloor(value: number, excluded?: boolean): number {
    const floor = Math.floor(value);
    return excluded && floor === value ? floor - 1 : floor;
}

function num(value: unknown): number {
    return typeof value === 'number' ? value : Number(value);
}

function int(value: unknown): number {
    return typeof value === 'number' ? value : Number(value);
}
