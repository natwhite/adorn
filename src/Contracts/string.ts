/**
 * String constraints, as descriptors (P1.0 / P3.3, plan §2).
 *
 * Decorator-agnostic (DEC-012) — see the note in `./number.ts`. Every predicate is **derived from
 * params** (DEC-010); there is no `predicate` input in this file.
 *
 * ---
 *
 * ## Predicates are total (ISSUES.md BUG-4 — fixed here)
 *
 * The P1.0 port reproduced the original closure verbatim, which dereferenced `.length` with no
 * guard: `MinLength(3).predicate(null)` raised a bare `TypeError` from inside adorn instead of
 * reporting a contract violation. Every derivation below now opens with `typeof value === 'string'`
 * and returns `false` for anything else.
 *
 * Two consequences worth separating, because only the first is about error messages:
 *
 * - a `null` argument now produces a proper violation naming the parameter and the expectation;
 * - the predicate is **total**, so a projection can evaluate it on arbitrary input without
 *   defending itself. That is what a fuzzer does, immediately, and it is why BUG-4 was raised to
 *   High rather than treated as a message-quality nit.
 *
 * The guard also closes a quieter hole: `.length` exists on arrays and functions, so before this
 * change `MinLength(3)` accepted `[1, 2, 3]`. A string constraint now means a string.
 *
 * `Url` additionally wraps `new URL()` in a `try`, since parsing failure is signalled by throwing —
 * a predicate that propagates that would be non-total in exactly the way this section forbids.
 *
 * ## Regex params are serialised, never live (P1.0)
 *
 * A `RegExp` instance is not JSON data and `Descriptor.normalizeParams` refuses it outright, so
 * `matches` carries `{pattern: {source, flags}}` and rebuilds the expression inside the derivation.
 * That is what lets a `matches` constraint round-trip through JSON and come back enforcing the same
 * thing.
 *
 * ## `schema()` may under-claim, never over-claim
 *
 * See `./number.ts`. The rule bites hardest here: `matches` with an `i` flag has no faithful JSON
 * Schema `pattern`, so the fragment degrades to `{type: 'string'}` rather than emitting a
 * case-sensitive pattern that would reject values the constraint accepts.
 *
 * ## `arbitrary` is still shape-only
 *
 * `fast-check` is not a dependency (ISSUES.md IDEA-3). Worth recording for whoever adds it: for
 * `minLength`/`maxLength`/`notEmpty` a generator is obvious, for `matches` it requires inverting an
 * arbitrary regex, and for `email`/`url` the honest answer is a curated sample set rather than a
 * pretence of full generality (P3.3).
 */

import {defineConstraint, JsonObject, Predicate} from '../Core/Descriptor';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Inclusive minimum length. */
export interface MinLengthParams extends JsonObject {
    minLength: number;
}

/** Inclusive maximum length. */
export interface MaxLengthParams extends JsonObject {
    maxLength: number;
}

/**
 * A regular expression in serialisable form. A type alias rather than an interface so TypeScript
 * gives it an implicit index signature and it satisfies `JsonValue`.
 */
export type PatternSpec = {
    source: string;
    flags: string;
};

/** A pattern the whole value must match. */
export interface PatternParams extends JsonObject {
    pattern: PatternSpec;
}

/** Accepted URL protocols, normalised to include the trailing colon. */
export interface UrlParams extends JsonObject {
    protocols: string[];
}

// ---------------------------------------------------------------------------
// Totality (BUG-4)
// ---------------------------------------------------------------------------

/** The single gate every string predicate passes through. */
function isText(value: unknown): value is string {
    return typeof value === 'string';
}

// ---------------------------------------------------------------------------
// Derivations — the single source each predicate comes from (DEC-010)
// ---------------------------------------------------------------------------

/** `minLength` is inclusive: a string of exactly `minLength` passes. Shared with `notEmpty`. */
const atLeastLength = (params: Readonly<MinLengthParams>): Predicate =>
    (value: unknown) => isText(value) && value.length >= params.minLength;

/** `maxLength` is inclusive: a string of exactly `maxLength` passes. */
const atMostLength = (params: Readonly<MaxLengthParams>): Predicate =>
    (value: unknown) => isText(value) && value.length <= params.maxLength;

/**
 * Whole-value match. Shared by `matches` and `email`, so the two cannot enforce differently.
 *
 * The expression is built **once**, when the predicate is derived, not per call. `g` and `y` are
 * refused at authoring time ({@link toPatternSpec}) because `RegExp.prototype.test` advances
 * `lastIndex` under those flags, which would make the predicate return different answers for the
 * same input on successive calls — a predicate that is not a function of its argument.
 */
const matchesPattern = (params: Readonly<PatternParams>): Predicate => {
    const expression = new RegExp(params.pattern.source, params.pattern.flags);
    return (value: unknown) => isText(value) && expression.test(value);
};

/**
 * Parses with the `URL` constructor rather than matching a regex.
 *
 * P3.3 calls URL-by-regex a well-known tar pit and prefers parsing, which is also what makes the
 * protocol allowlist expressible: `new URL('HTTP://x').protocol` is normalised to `'http:'`, so the
 * check is case-correct without a case-insensitive pattern.
 */
const isUrl = (params: Readonly<UrlParams>): Predicate => {
    const allowed = params.protocols;
    return (value: unknown) => {
        if (!isText(value) || value.length === 0) return false;
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch (error) {
            return false;
        }
        return allowed.indexOf(parsed.protocol.toLowerCase()) !== -1;
    };
};

// ---------------------------------------------------------------------------
// Built-in patterns
// ---------------------------------------------------------------------------

/**
 * Deliberately the conservative, widely-used approximation: "something, an `@`, something with a
 * dot in it".
 *
 * P3.3 names email-by-regex a tar pit and prefers an approximate pattern over a baroque one that
 * rejects valid addresses. RFC 5322 permits quoted local parts, comments, and IP-literal domains;
 * a pattern that accepts all of them accepts almost anything, and one that tries to be strict
 * rejects real mail. This one errs toward accepting, and the only way to *know* an address is
 * deliverable is to send to it.
 *
 * No flags, which is what lets `email` emit a faithful JSON Schema `pattern`.
 */
const EMAIL_PATTERN: PatternSpec = {source: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', flags: ''};

/** Web URLs only. `javascript:` and `data:` are excluded by default, which is usually the point. */
const DEFAULT_URL_PROTOCOLS = ['http:', 'https:'];

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const minLengthConstraint = defineConstraint<MinLengthParams>({
    kind: 'string',
    constraint: 'minLength',
    derive: atLeastLength,
    // Wording preserved verbatim from the original closure. It says "greater than" while the check
    // is inclusive — inaccurate, and now inconsistent with `maxLength` below, but every existing
    // error string is pinned by a parity test and message rework belongs to P3.1. Changing it here
    // would be the same kind of smuggled behaviour change P1.0 refused to make to the predicates.
    describe: params => `a string of length greater than ${params.minLength}`,
    schema: params => ({type: 'string', minLength: params.minLength}),
});

export const maxLengthConstraint = defineConstraint<MaxLengthParams>({
    kind: 'string',
    constraint: 'maxLength',
    derive: atMostLength,
    describe: params => `a string of length less than or equal to ${params.maxLength}`,
    schema: params => ({type: 'string', maxLength: params.maxLength}),
});

/**
 * A distinct identity from `minLength`, despite sharing its derivation and params shape.
 *
 * Documentation says "a non-empty string"; a schema reads `{"minLength": 1}`. Both descend from the
 * one `atLeastLength` derivation, so `NotEmpty()` and `MinLength(1)` cannot come to disagree.
 *
 * This is the split DEC-020 removed from `./number.ts`, and it survives here for the reason the
 * numeric ones did not: "non-empty" is not a *boundary* dressed up as a word — there is exactly one
 * empty string, so `notEmpty` admits no ambiguity about where its edge falls. `positive` was
 * removed because "positive" genuinely does not say whether `0` is in or out; nobody has ever had
 * to ask that about "non-empty".
 */
export const notEmptyConstraint = defineConstraint<MinLengthParams>({
    kind: 'string',
    constraint: 'notEmpty',
    derive: atLeastLength,
    describe: () => 'a non-empty string',
    schema: params => ({type: 'string', minLength: params.minLength}),
});

export const matchesConstraint = defineConstraint<PatternParams>({
    kind: 'string',
    constraint: 'matches',
    derive: matchesPattern,
    describe: params => `a string matching /${params.pattern.source}/${params.pattern.flags}`,
    /**
     * `pattern` is emitted only when the expression has no flags, because JSON Schema's `pattern`
     * is an unflagged ECMA-262 expression. Emitting the bare source for `/foo/i` would produce a
     * fragment that rejects `FOO` while enforcement accepts it — over-claiming, which the rule in
     * the module header forbids. The fragment degrades to `{type: 'string'}` instead.
     */
    schema: params => params.pattern.flags === ''
        ? {type: 'string', pattern: params.pattern.source}
        : {type: 'string'},
});

/**
 * Its own identity, sharing `matchesPattern` with `matches`.
 *
 * The pattern lives in `params`, so the descriptor states exactly what it enforces rather than
 * hiding it behind the word "email" — a reader of the generated artifact can see the approximation
 * instead of assuming RFC 5322.
 */
export const emailConstraint = defineConstraint<PatternParams>({
    kind: 'string',
    constraint: 'email',
    derive: matchesPattern,
    describe: () => 'an email address',
    /**
     * `pattern` and not `format: 'email'`. A validator that asserts `format` applies a stricter
     * rule than the approximation above and would reject addresses this constraint accepts —
     * over-claiming again. The pattern *is* the enforcement, so emitting it is exact.
     */
    schema: params => ({type: 'string', pattern: params.pattern.source}),
});

export const urlConstraint = defineConstraint<UrlParams>({
    kind: 'string',
    constraint: 'url',
    derive: isUrl,
    describe: params => `a URL using ${params.protocols.map(stripColon).join(' or ')}`,
    /**
     * `format: 'uri'` is an annotation in JSON Schema, not an assertion, and there is no keyword
     * for a protocol allowlist. The fragment therefore under-claims — a schema validator accepts
     * `ftp://…` where the constraint rejects it. That direction is the safe one: enforcement is
     * stricter than the published schema, so bad input is refused loudly at the boundary rather
     * than admitted silently.
     */
    schema: () => ({type: 'string', format: 'uri'}),
});

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

function requireLength(constraint: string, name: string, value: number): number {
    if (typeof value !== 'number' || !isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new TypeError(
            `${constraint}: \`${name}\` must be a non-negative integer, received ${String(value)}`,
        );
    }
    return value;
}

/**
 * Normalise a `RegExp` or pattern source into serialisable form, rejecting what cannot be enforced
 * deterministically.
 *
 * `g` and `y` are refused rather than silently stripped. Stripping would leave `params.flags`
 * disagreeing with the expression the predicate actually runs — documentation printing `/a/g` while
 * enforcement uses `/a/` — which is precisely the descriptor/predicate drift of Q-4, introduced by
 * a convenience.
 */
function toPatternSpec(pattern: RegExp | string, flags?: string): PatternSpec {
    let source: string;
    let resolved: string;

    if (pattern instanceof RegExp) {
        if (flags !== undefined) {
            throw new TypeError(
                'Matches: pass flags on the RegExp itself or as a source string, not both',
            );
        }
        source = pattern.source;
        resolved = pattern.flags;
    } else if (typeof pattern === 'string') {
        source = pattern;
        resolved = flags === undefined ? '' : flags;
    } else {
        throw new TypeError(`Matches: expected a RegExp or a pattern string, received ${typeof pattern}`);
    }

    if (/[gy]/.test(resolved)) {
        throw new TypeError(
            "Matches: the 'g' and 'y' flags are not supported — RegExp.test advances `lastIndex` " +
            'under them, so the same value would validate differently on successive calls. Remove ' +
            'them; they have no meaning for a whole-value check.',
        );
    }

    // Compile once here so an invalid pattern fails at decoration time with a clear origin, rather
    // than on the first call from inside a derived predicate.
    try {
        // tslint:disable-next-line no-unused-expression
        new RegExp(source, resolved);
    } catch (error) {
        throw new TypeError(`Matches: invalid regular expression /${source}/${resolved} — ${String(error)}`);
    }

    return {source, flags: resolved};
}

function normalizeProtocol(protocol: string): string {
    if (typeof protocol !== 'string' || protocol.length === 0) {
        throw new TypeError(`Url: each protocol must be a non-empty string, received ${String(protocol)}`);
    }
    const lower = protocol.toLowerCase();
    return lower.charAt(lower.length - 1) === ':' ? lower : `${lower}:`;
}

function stripColon(protocol: string): string {
    return protocol.charAt(protocol.length - 1) === ':' ? protocol.slice(0, -1) : protocol;
}

// ---------------------------------------------------------------------------
// Constraint factories — the authoring surface
// ---------------------------------------------------------------------------

/** Rejects strings shorter than `minLength`; a string of exactly `minLength` passes. */
export function MinLength(minLength: number) {
    return minLengthConstraint({minLength: requireLength('MinLength', 'minLength', minLength)});
}

/** Rejects strings longer than `maxLength`; a string of exactly `maxLength` passes. */
export function MaxLength(maxLength: number) {
    return maxLengthConstraint({maxLength: requireLength('MaxLength', 'maxLength', maxLength)});
}

/**
 * Rejects the empty string.
 *
 * Length-based, not content-based: `'   '` passes. Trimming would make the constraint's params
 * (`{minLength: 1}`) describe something other than what it enforces, and "not blank" is a different
 * rule that should carry its own identity if it is ever wanted.
 */
export function NotEmpty() {
    return notEmptyConstraint({minLength: 1});
}

/**
 * Rejects strings the pattern does not match.
 *
 * Anchoring is the author's business — `Matches(/^a+$/)` requires a whole-string match while
 * `Matches(/a+/)` requires a substring — because that is how a reader of the regex expects it to
 * behave. The `g` and `y` flags are rejected; see {@link toPatternSpec}.
 */
export function Matches(pattern: RegExp | string, flags?: string) {
    return matchesConstraint({pattern: toPatternSpec(pattern, flags)});
}

/** Rejects strings that do not look like an email address. **Approximate** — see {@link EMAIL_PATTERN}. */
export function Email() {
    return emailConstraint({pattern: EMAIL_PATTERN});
}

/**
 * Rejects strings that do not parse as an absolute URL with an accepted protocol.
 *
 * Defaults to `http`/`https`. Pass `protocols` to widen — `Url(['http', 'https', 'ftp'])` — with or
 * without the trailing colon; both forms normalise to the same params, so two spellings of the same
 * intent produce the same artifact.
 */
export function Url(protocols?: string[]) {
    if (protocols !== undefined && (!Array.isArray(protocols) || protocols.length === 0)) {
        throw new TypeError('Url: `protocols` must be a non-empty array of protocol names');
    }
    const resolved = (protocols || DEFAULT_URL_PROTOCOLS).map(normalizeProtocol);
    return urlConstraint({protocols: resolved});
}

/**
 * Alias under the name the existing decorator uses, so the adapter layer has an unambiguous mapping.
 * `MinLength` is the canonical name in this layer — the module is already `string`.
 */
export const StringMinLength = MinLength;
