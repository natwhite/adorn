/**
 * P1.0 — the reified constraint model.
 *
 * Today a constraint is a closure that throws. You can *run* it; you cannot *ask it anything*.
 * Its identity (`min`) and its parameters (`0`) exist only as instructions inside a function
 * body, so no documentation line, JSON Schema fragment, or value generator can be derived from
 * it (implementation-plan §1.5, DEC-006).
 *
 * A `ConstraintDescriptor` makes the constraint **data**: identity + parameters, with the
 * enforcement predicate *derived from* those parameters.
 *
 * ## Derivation, not attachment (DEC-010)
 *
 * The predicate is never supplied alongside `params` — it is produced from `params` by the
 * `ConstraintDefinition`'s `derive` function. This is deliberate and is the whole point:
 * descriptor/predicate **drift** is the worst failure mode the "contracts as source of truth"
 * goal introduces (ISSUES.md Q-4). A descriptor claiming `min: 0` whose predicate actually
 * checks `> 0` would emit documentation that *looks* authoritative while disagreeing with what
 * is enforced — silently, and in exactly the artifact people trust. Deriving leaves one source.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * This module is decorator-agnostic. It must never import or reference a decorator type
 * (`ParameterDecorator`, `MethodDecorator`, stage-3 contexts, `target`/`propertyKey`). Projections
 * will depend on this layer; if it binds to an adapter, "four artifacts from one declaration"
 * quietly becomes "four artifacts from the legacy decorator syntax".
 *
 * ## Deliberately not built here
 *
 * No constraint algebra — no unions, negation, conjunction, or conditionals. Nothing has
 * exercised those yet, and an unused abstraction at this layer is pure cost (plan risk 10).
 * Cross-parameter relationships (Tier 2) will extend this model under real demand.
 */

import {REDACTED} from './redaction';

// ---------------------------------------------------------------------------
// Serialisable value types
// ---------------------------------------------------------------------------

/**
 * `params` must be plain JSON-able data. Anything that is not serialisable cannot be projected
 * into a schema or a documentation artifact, so it is rejected at construction time rather than
 * discovered at projection time.
 *
 * Note for future constraints: a `RegExp` is **not** serialisable and must be represented
 * explicitly, e.g. `{ source: '^a+$', flags: 'i' }`, never as a live `RegExp` instance.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
    [key: string]: JsonValue;
}

// ---------------------------------------------------------------------------
// Core constraint types
// ---------------------------------------------------------------------------

/** The domain a constraint applies to. */
export type ConstraintKind = 'number' | 'string' | 'generic';

/** The data a projection reads. Always plain JSON. */
export type ConstraintParams = JsonObject;

/**
 * Enforcement. Returns `true` when `value` **satisfies** the constraint.
 *
 * `value` is `unknown` on purpose: a constraint receives whatever the caller passed, which is by
 * definition untrusted — that is why the contract exists.
 */
export type Predicate = (value: unknown) => boolean;

/**
 * The information a message needs beyond the constraint itself. Deliberately plain strings:
 * an adapter composes `signature` from its own target/propertyKey knowledge, and this layer
 * never sees those.
 */
export interface ViolationContext {
    readonly value: unknown;
    /** e.g. `Task.test(message, count) parameter 'message'`. Supplied by the enforcement layer. */
    readonly signature?: string;
    /** Fallback subject when no full signature is available. */
    readonly paramName?: string;
    /**
     * Whether the received value may appear in the rendered message — **pre-resolved by the
     * enforcement layer as plain data** (DEC-012, DEC-PII-4). This layer never sees a decorator, the
     * registry, or `@Sensitive`; it only ever sees this boolean, exactly as it only ever sees a
     * composed `signature` rather than a `target`/`propertyKey`.
     *
     * **Absent means redact.** The safe default lives here, so a *new* enforcement path that forgets
     * to forward this gets the redacted rendering rather than the leak — the DEC-PII-1 principle
     * applied to adorn's own internals: neither the annotation nor remembering to forward it is
     * load-bearing. `true` discloses the value; anything else (including `undefined`) redacts it.
     */
    readonly disclose?: boolean;
}

/**
 * Placeholder for a property-testing generator.
 *
 * **Shape only — no generator is implemented in P1.0** (and none of the ported built-ins supply
 * one). This is typed `unknown` rather than `fc.Arbitrary` because `fast-check` is not a
 * dependency of this package and P1.0 is not permitted to add one. When the fast-check bridge
 * lands (`Projections/arbitraries.ts`), narrow this alias in one place.
 *
 * Honest limit, stated once (plan §1.5, ISSUES.md Q-3): an arbitrary cannot be synthesised for a
 * hand-written predicate. Generative coverage will be good for built-in constraints and partial
 * for user-authored ones. `arbitrary` is optional precisely because that is unsolvable.
 */
export type Arbitrary = unknown;

/**
 * A constraint as data.
 *
 * | Consumer      | Reads                    |
 * |---------------|--------------------------|
 * | Validation    | `predicate`              |
 * | Documentation | `constraint` + `params`  |
 * | Schema        | `schema` (or `params`)   |
 * | Fuzzing       | `arbitrary`              |
 *
 * Instances are frozen. Build them through a factory returned by {@link defineConstraint}.
 */
export interface ConstraintDescriptor<P extends ConstraintParams = ConstraintParams, Out = unknown> {
    /** Domain: `'number' | 'string' | 'generic'`. */
    readonly kind: ConstraintKind;
    /** Identity: `'min'`, `'max'`, `'minLength'`, … — what a documentation projection names. */
    readonly constraint: string;
    /** The data a projection reads. Deep-frozen, JSON-serialisable. */
    readonly params: Readonly<P>;
    /** Enforcement. **Derived** from `params`; cannot drift from them. */
    readonly predicate: Predicate;
    /** Human phrase for the expectation, e.g. `a number greater than or equal to 5`. */
    readonly describe: () => string;
    /** Full violation message. */
    readonly message: (context: ViolationContext) => string;
    /** Optional generator hook. Absent unless the definition supplies one. */
    readonly arbitrary?: () => Arbitrary;
    /** Optional JSON Schema fragment. Absent unless the definition supplies one. */
    readonly schema?: () => JsonObject;
    /**
     * Optional failure localizer (DEC-060). Given a value the predicate REJECTED, returns the path to the
     * first failing sub-location — `["slotInput", "when"]` for a bad nested field — or `undefined` when the
     * failure is at this value's own level (a container-type gate or a length bound, where the top-level
     * `message` already says everything and there is no key to point at). Absent for primitives, so
     * `'locate' in descriptor` is an honest "can this failure be localized?".
     */
    readonly locate?: (value: unknown) => ReadonlyArray<string | number> | undefined;

    /** Makes `JSON.stringify(descriptor)` produce a rehydratable form. */
    toJSON(): SerializedConstraint<P>;

    /**
     * Phantom OUTPUT tag (DEC-059/IDEA-28) — the type a *satisfying* value has, so `Verify.check`/`that`
     * can narrow `unknown` to it. **Type-level ONLY**: never assigned at runtime, so `'__out' in descriptor`
     * is `false` and `Object.keys`/`JSON.stringify`/spread/freeze are all unaffected. A bare `Out` param
     * would be *bivariant* (unused → no narrowing); referencing it in the covariant return position of
     * `(value: never) => Out` (under `strictFunctionTypes`) makes a `ConstraintDescriptor<P, string>`
     * assignable to `<P, unknown>` (widening — so a typed descriptor still flows into the adapters that
     * take a bare descriptor) but **not** the reverse (so narrowing survives). Defaults to `unknown`, so
     * every existing `ConstraintDescriptor<P>` is unchanged.
     */
    readonly __out?: (value: never) => Out;
}

/**
 * The wire form. Rehydrate with {@link constraintFromJSON}.
 *
 * A **`type` alias** rather than an `interface` (DEC-050): every member type is JSON-compatible
 * (`kind`/`constraint` are `string`, `params` is `P extends JsonObject`), so a type alias carries the
 * implicit index signature that makes `SerializedConstraint` assignable to `JsonValue`/`JsonObject`.
 * That is what lets a *compositional* descriptor store a serialised item in its own `params` (which
 * must `extend JsonObject`) — e.g. `ArrayOfParams.item` in `Contracts/array.ts`. An `interface` has no
 * implicit index signature and fails that assignment (TS2411/TS2322). This is the exact precedent
 * `PatternSpec` records in `Contracts/string.ts`; the members are unchanged, so `toJSON()` and
 * `constraintFromJSON` keep their signatures — pure widening, no runtime effect.
 */
export type SerializedConstraint<P extends ConstraintParams = ConstraintParams> = {
    readonly kind: ConstraintKind;
    readonly constraint: string;
    readonly params: P;
};

/**
 * The reusable *rule*. A {@link ConstraintDescriptor} is one *application* of a definition to a
 * particular set of params.
 *
 * There is no `predicate` field here by design — see DEC-010. `derive` is the only way a
 * predicate comes into existence, so `params` is always the single source.
 */
export interface ConstraintDefinition<P extends ConstraintParams = ConstraintParams> {
    readonly kind: ConstraintKind;
    /** Must be unique across the process; used as the rehydration key. */
    readonly constraint: string;
    /** Produce the enforcement predicate from the params. The anti-drift mechanism. */
    readonly derive: (params: Readonly<P>) => Predicate;
    /** Produce the human expectation phrase from the params. */
    readonly describe: (params: Readonly<P>) => string;
    /** Optional — see {@link Arbitrary}. Not supplied by any P1.0 built-in. */
    readonly arbitrary?: (params: Readonly<P>) => Arbitrary;
    /** Optional JSON Schema fragment producer. Not supplied by any P1.0 built-in. */
    readonly schema?: (params: Readonly<P>) => JsonObject;
    /**
     * Optional failure localizer (DEC-060). Higher-order like `derive`: applied to `params` ONCE (rebuilding
     * any inner descriptors once), returning a per-value walker that reports the first failing sub-path.
     */
    readonly locate?: (params: Readonly<P>) => (value: unknown) => ReadonlyArray<string | number> | undefined;
}

/**
 * What {@link defineConstraint} hands back: call it with params to get a descriptor.
 * The originating definition is exposed for introspection and testing.
 */
export interface ConstraintFactory<P extends ConstraintParams = ConstraintParams, Out = unknown> {
    (params: P): ConstraintDescriptor<P, Out>;

    readonly definition: ConstraintDefinition<P>;
}

// ---------------------------------------------------------------------------
// Definition table
// ---------------------------------------------------------------------------

/**
 * Identity -> definition. Needed for two things:
 *   1. rehydrating a serialised descriptor back into an enforceable one, and
 *   2. letting a projection discover what constraint identities exist at all.
 *
 * Caveat, same shape as DEC-007's: this table is populated by module *evaluation*. A constraint
 * identity is only rehydratable if the module that defines it has been imported.
 */
const definitions = new Map<string, ConstraintDefinition<any>>();

/**
 * Register a constraint rule and return a factory that builds descriptors from it.
 *
 * Throws on a duplicate identity. Two definitions sharing one `constraint` string would make
 * rehydration ambiguous and is nearly always a copy-paste error, so it fails loudly.
 */
export function defineConstraint<P extends ConstraintParams = ConstraintParams, Out = unknown>(
    definition: ConstraintDefinition<P>,
): ConstraintFactory<P, Out> {
    if (!definition || typeof definition.constraint !== 'string' || definition.constraint.length === 0) {
        throw new TypeError('defineConstraint: a non-empty `constraint` identity is required');
    }
    if (typeof definition.derive !== 'function') {
        throw new TypeError(
            `defineConstraint('${definition.constraint}'): \`derive\` is required — predicates are ` +
                'derived from params, never attached alongside them (DEC-010)',
        );
    }
    if (typeof definition.describe !== 'function') {
        throw new TypeError(`defineConstraint('${definition.constraint}'): \`describe\` is required`);
    }
    if (definitions.has(definition.constraint)) {
        throw new Error(
            `defineConstraint: constraint identity '${definition.constraint}' is already registered. ` +
                'Identities must be unique — a duplicate makes serialised descriptors ambiguous.',
        );
    }

    const frozen: ConstraintDefinition<P> = Object.freeze({...definition});
    definitions.set(frozen.constraint, frozen);

    const factory = ((params: P) => createDescriptor(frozen, params)) as ConstraintFactory<P, Out>;
    Object.defineProperty(factory, 'definition', {value: frozen, enumerable: true});
    return factory;
}

/** Look up a registered definition by identity. */
export function getConstraintDefinition(constraint: string): ConstraintDefinition<any> | undefined {
    return definitions.get(constraint);
}

/** Every registered constraint identity. Snapshot, not a live view. */
export function getConstraintIdentities(): string[] {
    const identities: string[] = [];
    definitions.forEach((_definition, identity) => identities.push(identity));
    return identities;
}

/**
 * Rebuild an enforceable descriptor from its serialised form.
 *
 * The predicate is re-derived from the round-tripped `params`, so a rehydrated descriptor
 * enforces exactly what the original did — there is no predicate on the wire to get out of sync.
 */
export function constraintFromJSON<P extends ConstraintParams = ConstraintParams>(
    serialized: SerializedConstraint<P>,
): ConstraintDescriptor<P> {
    if (!serialized || typeof serialized.constraint !== 'string') {
        throw new TypeError('constraintFromJSON: expected an object with a `constraint` identity');
    }
    const definition = definitions.get(serialized.constraint);
    if (!definition) {
        throw new Error(
            `constraintFromJSON: unknown constraint identity '${serialized.constraint}'. ` +
                'The module defining it must be imported before its descriptors can be rehydrated.',
        );
    }
    return createDescriptor(definition as ConstraintDefinition<P>, serialized.params);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function createDescriptor<P extends ConstraintParams>(
    definition: ConstraintDefinition<P>,
    rawParams: P,
): ConstraintDescriptor<P> {
    const params = normalizeParams(definition.constraint, rawParams) as Readonly<P>;

    const predicate = definition.derive(params);
    if (typeof predicate !== 'function') {
        throw new TypeError(`Constraint '${definition.constraint}': \`derive\` did not return a function`);
    }

    const describe = () => definition.describe(params);

    const descriptor: ConstraintDescriptor<P> = {
        kind: definition.kind,
        constraint: definition.constraint,
        params,
        predicate,
        describe,
        message: (context: ViolationContext) => formatMessage(definition.kind, describe(), context),
        toJSON: (): SerializedConstraint<P> => ({
            kind: definition.kind,
            constraint: definition.constraint,
            params: params as P,
        }),
    };

    // Optional hooks are *absent*, not undefined, when unsupplied — so `'arbitrary' in descriptor`
    // is an honest answer to "can this constraint be fuzzed?".
    const arbitraryOf = definition.arbitrary;
    if (arbitraryOf) {
        Object.defineProperty(descriptor, 'arbitrary', {
            value: () => arbitraryOf(params),
            enumerable: true,
        });
    }
    const schemaOf = definition.schema;
    if (schemaOf) {
        Object.defineProperty(descriptor, 'schema', {
            value: () => schemaOf(params),
            enumerable: true,
        });
    }
    // `locate` (DEC-060) is wired EAGERLY: the definition's `(params) => (value) => path` is applied to
    // `params` ONCE here (rebuilding any inner descriptors a single time, like `derive`), and the resulting
    // per-value walker is stored. This differs from `schema` above (stored deferred) because `schema`'s hook
    // is `(params) => fragment`, not higher-order — so the eager form is the correct mirror for `locate`.
    const locateOf = definition.locate;
    if (locateOf) {
        Object.defineProperty(descriptor, 'locate', {value: locateOf(params), enumerable: true});
    }

    return Object.freeze(descriptor);
}

/**
 * Message shape. The constraint and the subject are always stated in full; the **received value is
 * redacted by default** (BUG-19, DEC-PII-4).
 *
 * BUG-19 was that this function embedded the raw value, so *routing* a violation anywhere —
 * `setViolationPolicy(handler)`, an error tracker, a crash report — leaked it through the back door,
 * further than `console.log` ever travels. Redacting here closes it at the source: the value is not
 * in `Error.message`, `String(err)`, `JSON.stringify(err)`, `util.inspect(err)`, or a spread of it.
 *
 * `context.disclose` is the pre-resolved decision (see {@link ViolationContext.disclose}); it is the
 * only thing that turns the value back on, and it is `true` only when a developer opted in *and* the
 * site is not `@Sensitive`. The message still names the constraint and the parameter, which is what
 * a reader needs first — and for most built-in constraints the value is largely redundant with the
 * constraint's own dimension (a length violation is diagnosed by the length, a range by the number).
 */
function formatMessage(kind: ConstraintKind, expectation: string, context: ViolationContext): string {
    const subject = context.signature || context.paramName || 'value';
    return (
        `Value Error: ${subject} expected ${expectation} but received ` +
        `${formatReceived(kind, context.value, context.disclose)} instead`
    );
}

/**
 * Render the received value for a message. Redacts unless disclosure was explicitly resolved to
 * `true` by the enforcement layer — the safe default (DEC-PII-1). When disclosed, string constraints
 * quote the value and numeric ones do not, matching the pre-BUG-19 behaviour.
 */
function formatReceived(kind: ConstraintKind, value: unknown, disclose?: boolean): string {
    if (disclose !== true) return REDACTED;
    return kind === 'string' ? `'${String(value)}'` : String(value);
}

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

/**
 * Validate, clone, and deep-freeze. Cloning stops a caller mutating params out from under a
 * descriptor; freezing stops anyone mutating them afterwards. Either would silently desynchronise
 * `params` from the already-derived predicate — the exact drift this model exists to prevent.
 */
function normalizeParams(constraint: string, params: ConstraintParams): ConstraintParams {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new TypeError(`Constraint '${constraint}': \`params\` must be a plain object`);
    }
    return cloneSerializable(params, `${constraint}.params`) as ConstraintParams;
}

function cloneSerializable(value: JsonValue, path: string): JsonValue {
    if (value === null) return null;

    const type = typeof value;
    if (type === 'string' || type === 'boolean') return value;
    if (type === 'number') {
        // NaN / Infinity survive neither JSON.stringify nor a schema, so reject them here rather
        // than let them become `null` inside a generated artifact.
        if (!isFinite(value as number)) {
            throw new TypeError(
                `Constraint params at '${path}' must be a finite number, received ${String(value)}`,
            );
        }
        return value;
    }

    if (Array.isArray(value)) {
        const clone: JsonValue[] = value.map((entry, index) => cloneSerializable(entry, `${path}[${index}]`));
        Object.freeze(clone);
        return clone;
    }

    if (type === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(
                `Constraint params at '${path}' must be plain JSON data, received ` +
                    `${describeUnserializable(value)}. A RegExp, Date, Map, or class instance cannot be ` +
                    'projected into a schema or a doc artifact — represent it explicitly instead ' +
                    '(e.g. { source, flags } for a RegExp).',
            );
        }
        const source = value as JsonObject;
        const clone: JsonObject = {};
        Object.keys(source).forEach(key => {
            clone[key] = cloneSerializable(source[key], `${path}.${key}`);
        });
        Object.freeze(clone);
        return clone;
    }

    throw new TypeError(
        `Constraint params at '${path}' must be JSON-serialisable, received ${describeUnserializable(value)}`,
    );
}

function describeUnserializable(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return 'a function';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'bigint') return 'a bigint';
    const constructor = value && (value as object).constructor;
    return constructor && constructor.name ? `a ${constructor.name}` : typeof value;
}
