/**
 * P1.1 — the contract registry.
 *
 * Decouples *recording* a contract from the authoring syntax that produced it and from the
 * machinery that installs enforcement. Adapters (`src/Adapters/*`) write; the core and every
 * projection read.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * Nothing here imports a decorator type. `target` is typed `object` — a prototype or a
 * constructor — not `Object` in a `ParameterDecorator` signature. A method-level `@Contract({...})`
 * on standard decorators must be able to populate this store exactly as the legacy per-parameter
 * form does, or the dual-track commitment (DEC-003) degenerates into two implementations.
 *
 * ## Two structures, for two different questions (DEC-011)
 *
 * A `WeakMap` keyed by prototype is the right answer to the hot-path question — *"what contracts
 * does this prototype have?"* — and is leak-free by construction.
 *
 * It cannot answer the question every projection asks: *"what classes have contracts?"* A
 * `WeakMap` exposes no `keys()`/`values()`/`entries()` and is not iterable, **by design** —
 * enumerating it would expose garbage-collection timing. This is not an oversight to work around;
 * it is the data structure's contract. So enumeration needs a second, enumerable structure.
 *
 * **The trade, stated rather than waved past:** the enumerable `Set` holds **strong references**
 * to every registered constructor, so a contracted class is never collected. In practice classes
 * are module-scoped and live for the process lifetime anyway, which is why this is acceptable —
 * but it is a real cost, and it is why {@link setClassEnumerationEnabled} exists as an opt-out
 * for anyone whose situation differs (dynamically generated classes, long-lived workers churning
 * through modules).
 *
 * ## Two contract bands: methods and fields (GAP-9)
 *
 * A target carries two independent stores — {@link MethodContract} for methods (parameters, `pre`,
 * `post`) and {@link FieldContract} for fields (one value, a constraint list). They are kept apart
 * because a field has no parameters and a method has no single value; folding them together would
 * ship permanently-empty slots and make every projection disambiguate before reading.
 *
 * The field band exists at all because without it `FieldDecoratorFactory` had to keep its store
 * adapter-local, which left `@Enforce.positive()` **enforced at runtime but invisible to every
 * projection** — a generated document that looks complete and is not.
 *
 * ## Own-property scoping — and the one place it is deliberately widened
 *
 * Storage is keyed by the exact object passed in and never walks the prototype chain. A subclass
 * therefore starts with an empty contract rather than finding — and mutating — its parent's, which
 * is the inheritance bug in the current parameter factory (plan P1.6).
 *
 * The **field band** layers an inheritance-aware *read* over that own-scoped store
 * ({@link getEffectiveFieldConstraints}, DEC-021). Writes stay own-scoped, which is exactly what
 * makes a subclass unable to weaken its parent: it can only ever add to its own list, and resolution
 * is the union of every list on the chain. See DEC-021 for why a field constraint is treated as an
 * invariant (strengthen-only) rather than a Meyer precondition (weaken-only).
 *
 * ## Semver note (ISSUES.md Q-6)
 *
 * The read API below becomes semver-relevant the moment a projection binds to it. It was internal
 * plumbing before; it is a published surface now.
 */

import {ConstraintDescriptor, JsonValue} from './Descriptor';

/** A prototype or constructor. Deliberately not a decorator-specific type. */
export type ContractTarget = object;

export type MethodKey = string | symbol;

/**
 * A field name. Structurally identical to {@link MethodKey}, named separately because the two bands
 * are separate: a class may legitimately carry a method and a field of the same name on different
 * key bands, and a reader of a signature should not have to work out which one an API means.
 */
export type FieldKey = string | symbol;

/** Contract data for a single parameter position. */
export interface ParameterContract {
    readonly index: number;
    readonly constraints: ReadonlyArray<ConstraintDescriptor>;
    /**
     * Recovered or explicitly supplied parameter name. Optional because it is genuinely not
     * always recoverable at runtime — minification renames parameters and there is no other
     * runtime source of names (plan §1.4). P1.5 owns populating this.
     */
    readonly name?: string;
    /**
     * `design:paramtypes` entry, when `emitDecoratorMetadata` is on. Advisory only: it erases to
     * `Object` for interfaces, unions, and generics. **Not serialisable** — projections must read
     * `constraints` for anything they intend to emit.
     */
    readonly type?: Function;
}

/**
 * Everything recorded about one method.
 *
 * `pre` and `post` are **reserved slots**, always present and always empty in T0/T1. They are
 * declared now because postconditions are a prerequisite for the flagship goal, not a nicety —
 * without an oracle, generated inputs can only ever test "it did not throw" (plan §9). Reserving
 * the shape means Tier 2 adds a writer, not a migration. No writer is provided here: an unused
 * API is cost, an unused *slot* is not.
 */
export interface MethodContract {
    readonly params: ReadonlyArray<ParameterContract>;
    /** Reserved — cross-parameter preconditions (Tier 2). */
    readonly pre: ReadonlyArray<ConstraintDescriptor>;
    /** Reserved — postconditions (Tier 2, top priority per plan §9). */
    readonly post: ReadonlyArray<ConstraintDescriptor>;
    /**
     * Whether an installer has wrapped this method yet.
     *
     * **This does not drive the missing-`@Contract()` warning** (Q-13), contrary to what this
     * comment used to claim. It cannot: a contract authored with `CreateSimpleDecorator` is a bare
     * closure, which the registry refuses by design (see {@link recordParameterConstraint}), so such
     * methods have no entry here at all. A sweep over `installed === false` would therefore silently
     * skip exactly the classes most likely to be broken — the ones using the older authoring form —
     * which is the opposite of what a mandatory diagnostic is for (SMELL-14).
     *
     * The warning is driven by an adapter-side pending set in `ContractDiagnostics`, which is told
     * about every authoring form. This flag is still maintained accurately for the methods the
     * registry does hold, and is what a projection reads to mark a contract as recorded-but-unenforced.
     */
    readonly installed: boolean;
}

/**
 * The predicate a postcondition evaluates: the (settled) return value first, then the arguments the
 * method was actually called with. `any[]` deliberately mirrors `InvocationContext.args`, the same
 * untyped tuple the invocation seam already exposes — a postcondition needs no serialisable value
 * types, only the runtime values, which is exactly what makes it enforceable but not projectable.
 */
export type PostconditionPredicate = (result: unknown, ...args: any[]) => boolean;

/**
 * One recorded postcondition (Q-11).
 *
 * A **closure, not a {@link ConstraintDescriptor}**. Two things make it un-descriptor-shaped, both
 * fundamental rather than incidental: its predicate relates the *result* to the *arguments*
 * (`(result, ...args) => boolean`) where a descriptor tests one value, and it carries no identity and
 * no serialisable params (Q-3) so nothing can be derived from it (DEC-010). It is therefore
 * enforceable and fuzzable but **not** projectable to docs/schema — the same accepted trade
 * `CreateSimpleDecorator` makes (SMELL-14), applied to the return value.
 *
 * This is why postconditions get their **own band** rather than the reserved
 * `MethodContract.post: ConstraintDescriptor[]` slot: that slot stays reserved for a future
 * *descriptor-shaped* postcondition (the reified `Returns(<descriptor>)` tier, deferred), and
 * `recordParameterConstraint`/`recordFieldConstraint` throw on bare predicates by design — a closure
 * does not live in the registry as a descriptor.
 */
export interface Postcondition {
    readonly predicate: PostconditionPredicate;
    /** Optional human phrase for the violation message, e.g. "the balance covers the withdrawal". */
    readonly description?: string;
    /**
     * Optional STABLE identity for this clause, distinct from the human-readable {@link description}
     * (axiform feedback 2026-10-18 §5). A closure degrades to the `_OTHER` facts sentinel, so a consumer
     * that needs to map a failure back to a declared clause has only `description` to key on — a convention
     * resting on a display string. `id` makes that explicit: `contract.checked`'s verdict carries it on the
     * failing clause. Unused by the decorator path (`@Ensures` carries none); purely additive.
     */
    readonly id?: string;
}

/**
 * The predicate a precondition evaluates: the arguments the method was actually called with, in order.
 * `any[]` mirrors `InvocationContext.args`. A precondition relates *multiple parameters*
 * (`(...args) => boolean`) where a per-position descriptor tests one value, and it carries no identity
 * or serialisable params — exactly what makes it enforceable and fuzzable but NOT projectable.
 */
export type PreconditionPredicate = (...args: any[]) => boolean;

/**
 * One recorded cross-parameter precondition (`@Requires`, IDEA-26/DEC-057). A **closure, not a
 * {@link ConstraintDescriptor}**, for the same two fundamental reasons a {@link Postcondition} is: its
 * predicate relates several arguments, and it carries no identity/serialisable params (Q-3). It gets its
 * **own band** — the input-side twin of the postcondition band — and, like `@Ensures`, is enforceable
 * and fuzzable but unprojectable (the reserved descriptor `pre` slot stays for a future *reified*
 * precondition).
 */
export interface Precondition {
    readonly predicate: PreconditionPredicate;
    /** Optional human phrase for the violation message, e.g. "start is before end". */
    readonly description?: string;
    /**
     * Optional STABLE identity for this clause, the input-side twin of {@link Postcondition.id} (axiform
     * feedback 2026-10-18 §5) — a key a consumer maps a failure back to, distinct from the display
     * `description`. Surfaced on `contract.checked`'s verdict; unused by the `@Requires` decorator path.
     */
    readonly id?: string;
}

/**
 * The predicate an **enabledness guard** (`@EnabledWhen`) evaluates: the RECEIVER first (so it can read
 * `this`/object state), then the call's arguments in order. `(self, ...args) => boolean`. The
 * receiver-first shape is the whole difference from {@link PreconditionPredicate} — a guard reads state,
 * a `@Requires` precondition never can (it is evaluated with no receiver).
 */
export type EnablednessPredicate = (self: any, ...args: any[]) => boolean;

/**
 * One recorded state-reading precondition (`@EnabledWhen`, DEC-089) — the "guard" band. A closure, like
 * {@link Precondition}, for the same two reasons: it relates state+args, and it carries no
 * identity/serialisable params — so it is enforceable and fuzzable but **not** projectable. It is kept
 * in a band **separate** from `@Requires` because the two carry opposite operational meaning downstream
 * code must tell apart: a failed `@Requires` is a generation/STARVATION signal and constrains an input
 * schema; a failed `@EnabledWhen` is an EXPECTED SKIP ("correctly not enabled in this state now") and is
 * never schema-projected. `band` is the self-describing tag on the record (contracts-as-data), named
 * `band` — not `kind` — to avoid colliding with {@link ConstraintKind}.
 */
export interface EnablednessGuard {
    readonly predicate: EnablednessPredicate;
    /** Optional human phrase for the "not enabled" message, e.g. "balance covers the amount". */
    readonly description?: string;
    /** Self-describing discriminant: this record is the enabledness band, not `@Requires`. */
    readonly band: 'enabledness';
}

/**
 * Everything recorded about one contracted **field** (GAP-9).
 *
 * ## Why the registry needs a field band at all
 *
 * `FieldDecoratorFactory` kept this store adapter-local, which meant a `@Enforce.positive()` field
 * was enforced at runtime and **absent from every projection**. That is the same shape as BUG-14 and
 * the same failure DEC-016 rejects: adorn guaranteeing something at runtime that it will not admit to
 * in a generated document. Nothing throws, and the artifact looks complete.
 *
 * ## Why it is a separate band rather than a `MethodContract` variant
 *
 * A field has no parameters, no arity, and no pre/post — it has one value and a list of constraints
 * on it. Folding it into `MethodContract` would ship four permanently-empty slots and force every
 * projection to ask "is this actually a method?" before reading. The bands are separate for the same
 * reason `getContractsForClass` tags `isStatic` rather than returning two shapes: the distinction is
 * real and the consumer needs it anyway.
 *
 * Layering is unchanged (DEC-012): nothing here knows a field constraint arrived from a property
 * decorator rather than from a schema, a standard-decorator `context.addInitializer`, or an
 * imperative call.
 */
export interface FieldContract {
    /** Declaration order — see {@link recordFieldConstraint}'s `position`. */
    readonly constraints: ReadonlyArray<ConstraintDescriptor>;
    /**
     * `design:type`, when `emitDecoratorMetadata` is on. Advisory only and subject to exactly the
     * caveats on {@link ParameterContract.type}: it erases to `Object` for interfaces, unions, and
     * generics, and it is **absent entirely** under a transpile-only toolchain (esbuild, Babel),
     * which is why it is optional rather than defaulted.
     */
    readonly type?: Function;
    /** Whether an installer has attached the validating accessor. */
    readonly installed: boolean;
}

/**
 * The level of a sensitivity marking (DEC-PII-2).
 *
 * Only `'sensitive'` exists today, and this is a single-member union **deliberately**. The
 * pii-redaction plan (§3.2, §6.1, DEC-PII-2) proposes a three-valued lattice after Palantir
 * `safe-logging` — roughly `'safe' | 'sensitive' | 'never'`, where `'never'` overrides even an
 * explicit `@Telemetry.value()` opt-in. That *behaviour* is a later piece (the redaction runtime,
 * BUG-18/BUG-19) and is not built here. Widening this union is forward-compatible: the stored shape
 * ({@link SensitivityMarking}) does not change, only the set of admissible values, so the later
 * runtime extends it with no data migration.
 */
export type SensitivityLevel = 'sensitive';

/**
 * A **record-only** marking that a field, parameter, or class holds sensitive data (DEC-PII-1).
 *
 * Record-only is the whole of it at this layer: the marking declares intent and feeds the build-time
 * detector and a future exposure report; it does **not** redact. Redaction (safe-by-default emission)
 * is a separate, later piece. It is stored as a small object rather than a bare boolean so the
 * three-valued design can grow into it without a migration — see {@link SensitivityLevel}.
 *
 * Layering is unchanged (DEC-012): the registry learns that a field/parameter/class *is sensitive*,
 * never that a decorator named `@Sensitive` produced the marking. An imperative caller, a
 * standard-decorator adapter, or a schema import could record the same datum.
 */
export interface SensitivityMarking {
    readonly level: SensitivityLevel;
}

/**
 * What a `@Telemetry` declaration opts a value INTO on the observation `record` path (O1c, DEC-036).
 *
 * - `'value'` — emit the value itself (`@Telemetry.value()` / `@Telemetry.result()`).
 * - `{redact: strategy}` — emit a derived surrogate (`@Telemetry.redact('type'|'length')`). The
 *   strategy names its own behaviour, so — as with a {@link ConstraintDescriptor} — it cannot document
 *   one transform and apply another (DEC-010 spirit): `redact('type')` emits the type, always.
 *
 * Deny-by-default is NOT a value here: the *absence* of a marking is the default, resolved to `'deny'`
 * by the disclosure resolver. A recorded marking is always an explicit opt-in.
 */
export type TelemetryDisclosure = 'value' | {readonly redact: string};

/**
 * A **record-only** telemetry-disclosure marking on a parameter or a return (O1c, DEC-036). The exact
 * twin of {@link SensitivityMarking}: own-scoped, index-keyed (hence minification-safe),
 * decorator-agnostic (DEC-012), and it installs nothing. It is the per-parameter production opt-in
 * DEC-030's global switch deliberately did not provide — reviewable and local to the position it
 * governs. `@Sensitive` still vetoes it (the veto only ever *removes* disclosure).
 */
export interface TelemetryMarking {
    readonly disclose: TelemetryDisclosure;
    /**
     * Explicit name for minified builds (DEC-OBS-4): `@Telemetry.value('accountId')`. When present it
     * overrides the recovered parameter name, which degrades to a single letter under minification in
     * exactly the production build where telemetry matters.
     */
    readonly name?: string;
}

/**
 * A **record-only** marking that a parameter is `@Optional` (DEC-051) — an *absent* argument satisfies
 * that position. Own-scoped and index-keyed exactly like {@link SensitivityMarking}/
 * {@link TelemetryMarking}, so it is minification-safe and installs nothing.
 *
 * A small object rather than a bare `Set<number>` membership (the adversarial-review S2 point):
 * `optional` is stored explicitly so a future explicit-`@Required` tri-state (`optional: false`) is
 * expressible without a data migration. Today only `optional: true` is ever recorded — a position with
 * no marking is simply absent from the band. The *effective* resolution ({@link getEffectiveParameterOptional})
 * is **required-wins**, not over-marking; see its note for why (DEC-016/DEC-022).
 */
export interface OptionalMarking {
    readonly optional: boolean;
}

// --- internal mutable twins -------------------------------------------------

interface MutableParameterContract {
    index: number;
    constraints: ConstraintDescriptor[];
    name?: string;
    type?: Function;
}

interface MutableMethodContract {
    params: MutableParameterContract[];
    pre: ConstraintDescriptor[];
    post: ConstraintDescriptor[];
    installed: boolean;
}

interface MutableFieldContract {
    constraints: ConstraintDescriptor[];
    type?: Function;
    installed: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Authoritative per-target store. Lookup only — a WeakMap cannot be enumerated (DEC-011). */
let contractsByTarget = new WeakMap<ContractTarget, Map<MethodKey, MutableMethodContract>>();

/** The field band's twin of {@link contractsByTarget} (GAP-9). Same keying, same own-scoping. */
let fieldsByTarget = new WeakMap<ContractTarget, Map<FieldKey, MutableFieldContract>>();

/**
 * The postcondition band (Q-11). Own-scoped and keyed exactly like {@link contractsByTarget}, so the
 * inheritance behaviour a postcondition needs — a subclass **conjoins** its ancestors' postconditions
 * (covariant strengthening, orthodox Meyer) — falls out of the *same* prototype-walk union the field
 * band already uses. See {@link getEffectivePostconditions}. A separate band rather than the reserved
 * `MethodContract.post` slot because a postcondition is a closure, not a {@link ConstraintDescriptor}
 * (see {@link Postcondition}).
 */
let postconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Postcondition[]>>();

/** Companion enumerable store. Strong references; see the header note. */
let contractedClasses = new Set<Function>();

/**
 * The sensitivity band (DEC-PII-1/2). Own-scoped and keyed **exactly** as the constraint bands are,
 * so the inheritance-safety a privacy marking needs — a subclass may not un-mark an inherited
 * sensitive field (DEC-021) — falls out of the *same* prototype-walk union mechanism the field band
 * already uses, rather than a parallel one. See {@link getEffectiveFieldSensitivity}.
 *
 * These are separate maps rather than a `sensitivity` field on {@link FieldContract}/
 * {@link ParameterContract} for one concrete reason: a `@Sensitive` field is record-only and must
 * never cause an accessor to be installed, but any key that appears in `fieldsByTarget` is a field
 * an installer (`@Contract()` / `installFieldContracts`) will attach a validating accessor to. Keeping
 * the marking out of the enforcement band keeps the marker record-only.
 */
let fieldSensitivityByTarget = new WeakMap<ContractTarget, Map<FieldKey, SensitivityMarking>>();

/** Parameter sensitivity: target → method key → parameter index → marking. */
let parameterSensitivityByTarget = new WeakMap<
    ContractTarget,
    Map<MethodKey, Map<number, SensitivityMarking>>
>();

/** Class-level sensitivity — `@Sensitive` on a class marks the whole type (and its subclasses). */
let classSensitivityByTarget = new WeakMap<Function, SensitivityMarking>();

/**
 * The telemetry-disclosure band (O1c, DEC-036) — the exact twin of {@link parameterSensitivityByTarget}.
 * Own-scoped and index-keyed, so a subclass conjoins rather than un-marks, and minification cannot break
 * the keying. Record-only: no key here ever causes an installer to attach anything.
 */
let parameterTelemetryByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, TelemetryMarking>>>();

/** Return telemetry: target → method key → marking (`@Telemetry.result()`). The disclosure-side of Q-23. */
let returnTelemetryByTarget = new WeakMap<ContractTarget, Map<MethodKey, TelemetryMarking>>();

/**
 * The `@Optional` band (DEC-051) — the twin of {@link parameterSensitivityByTarget}. Own-scoped and
 * index-keyed, record-only: no key here ever causes an installer to attach anything. Resolution is
 * **required-wins** ({@link getEffectiveParameterOptional}), the safe direction for a precondition
 * *weakening* (DEC-016/DEC-022), which is why it is NOT the over-marking rule the sensitivity band uses.
 */
let parameterOptionalByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, OptionalMarking>>>();

/**
 * The `@Default` band (DEC-051) — target → method key → parameter index → the (JSON-serialisable)
 * default value. Own-scoped and index-keyed, record-only. The value is stored directly (a `JsonValue`),
 * so a stored `null` default is distinguishable from "no default" (a missing map entry) — `Map.get`
 * returns `undefined` only when the key is absent. Nearest-declaration-wins ({@link getEffectiveParameterDefault}).
 */
let parameterDefaultByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, JsonValue>>>();

/**
 * The `@Describe` parameter-description band (Q-30) — target → method key → parameter index → the
 * natural-language description the model reads. Own-scoped and index-keyed, record-only: no key here
 * ever causes an installer to attach anything, exactly like the sensitivity/telemetry/`@Optional` bands.
 * Resolution is **nearest-declaration-wins** ({@link getEffectiveParameterDescription}), the same rule
 * `@Default` uses — a description is a plain annotation, not a precondition, so there is nothing to
 * conjoin (contrast the constraint band's DEC-022 union).
 */
let parameterDescriptionByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, string>>>();

/**
 * The `@Tool` method-description band (Q-30) — target → method key → the tool-level description. The
 * method-level twin of {@link parameterDescriptionByTarget}; own-scoped, record-only, and resolved
 * nearest-declaration-wins ({@link getEffectiveMethodDescription}). It is the recorded twin of the
 * `toolSchemaForMethod(C, m, {description})` option — the option overrides it when both are present.
 */
let methodDescriptionByTarget = new WeakMap<ContractTarget, Map<MethodKey, string>>();

let classEnumerationEnabled = true;

const EMPTY_CONTRACTS: ReadonlyMap<MethodKey, MethodContract> = new Map<MethodKey, MethodContract>();

const EMPTY_FIELD_CONTRACTS: ReadonlyMap<FieldKey, FieldContract> = new Map<FieldKey, FieldContract>();

/** Shared by both bands' effective reads, so neither allocates for the nothing-declared case. */
const EMPTY_CONSTRAINTS: ReadonlyArray<ConstraintDescriptor> = Object.freeze([]);

/** The postcondition band's twin of {@link EMPTY_CONSTRAINTS}. */
const NO_POSTCONDITIONS: ReadonlyArray<Postcondition> = Object.freeze([]);

// ---------------------------------------------------------------------------
// Reads — the public introspection surface
// ---------------------------------------------------------------------------

/**
 * Contracts recorded directly on `target`. Own-scoped: a subclass prototype returns its own
 * entries only, never its parent's. Returns an empty map when nothing is recorded, so callers can
 * iterate unconditionally.
 */
export function getContracts(target: ContractTarget): ReadonlyMap<MethodKey, MethodContract> {
    if (!isRegisterableTarget(target)) return EMPTY_CONTRACTS;
    const contracts = contractsByTarget.get(target);
    return contracts ? contracts : EMPTY_CONTRACTS;
}

/** The contract for one method on `target`, or `undefined` if it has none. */
export function getContract(target: ContractTarget, key: MethodKey): MethodContract | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const contracts = contractsByTarget.get(target);
    return contracts ? contracts.get(key) : undefined;
}

/**
 * Every class registered for enumeration — the question a `WeakMap` cannot answer.
 *
 * Returns a snapshot array rather than the live `Set`, so a projection iterating it cannot be
 * disturbed by, or accidentally mutate, the registry.
 *
 * **Limitation, inherent to runtime introspection (DEC-007):** this reflects only what has been
 * *imported and evaluated*. A documentation generator needs an entry point that enumerates the
 * modules to scan; a class nothing imports is invisible here.
 *
 * Note this returns constructors, which is only half of where contracts live — see
 * {@link getContractsForClass}, which is what a projection should actually walk.
 */
export function getContractedClasses(): Function[] {
    const classes: Function[] = [];
    contractedClasses.forEach(entry => classes.push(entry));
    return classes;
}

// --- effective (inheritance-aware) method reads (DEC-022, Q-15) ------------

/**
 * Every constraint in force on parameter `index` of `target[key]`, including every one inherited
 * from a superclass.
 *
 * ## The union, and the one distinction it depends on (DEC-022)
 *
 * The method band resolves exactly as the field band does (DEC-021): a declaration is only ever
 * recorded against the object it was written on, and resolution **concatenates** every list found
 * walking the prototype chain, base-most first. A subclass has no write API that reaches an
 * ancestor, so the resolved set can only grow as you descend — an override can add conjuncts and
 * can never shed one.
 *
 * **The load-bearing line is the `continue` below.** A level that declares *no* constraints at this
 * index and a level that declares an *empty* list are the same statement about preconditions —
 * "this class demands nothing further here" — and neither may displace an ancestor's demand. That
 * is what makes an undecorated override inherit rather than clear: it has no own list, contributes
 * no conjuncts, and the effective set is therefore its parent's, unchanged. Keying on *declares
 * constraints* rather than on *has a registry entry* also means a phantom entry — one conjured by
 * {@link setParameterMetadata} or {@link markInstalled} recording metadata for an undecorated
 * position — can never be mistaken for "declares an empty precondition, so replace the parent".
 *
 * ## Why this is conjunction and not Meyer's disjunction
 *
 * A parameter constraint genuinely *is* a Meyer precondition, and classical DbC permits a subclass
 * to **weaken** one contravariantly. This ruling forecloses that deliberately; DEC-022 records the
 * reasoning and the tension. Explicit weakening remains available as an **additive** future feature
 * (an opt-in disjunction), not as a reversal of this rule.
 *
 * ## Ordering and cost
 *
 * Base-most class first, each level in its own declaration order (DEC-017), matching
 * {@link getEffectiveFieldConstraints}. The common case — no contracted ancestor — returns the
 * stored array itself with no copy.
 */
export function getEffectiveParameterConstraints(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): ReadonlyArray<ConstraintDescriptor> {
    if (!isRegisterableTarget(target)) return EMPTY_CONSTRAINTS;

    // Collected own-most first; reversed on the way out so the base-most class leads.
    let nearest: ConstraintDescriptor[] | undefined;
    let bands: ConstraintDescriptor[][] | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const contracts = contractsByTarget.get(cursor);
        const contract = contracts && contracts.get(key);
        if (!contract) continue;

        const parameter = findParameterEntry(contract, index);
        // Declares nothing, or declares nothing *here* — see the note above. Either way this level
        // adds no conjunct and displaces none.
        if (!parameter || parameter.constraints.length === 0) continue;

        if (!nearest) {
            nearest = parameter.constraints;
        } else {
            if (!bands) bands = [nearest];
            bands.push(parameter.constraints);
        }
    }

    if (!nearest) return EMPTY_CONSTRAINTS;
    // No contracted ancestor — hand back the stored array rather than copying it.
    if (!bands) return nearest;

    const merged: ConstraintDescriptor[] = [];
    for (let level = bands.length - 1; level >= 0; level--) {
        const band = bands[level];
        for (let i = 0; i < band.length; i++) merged.push(band[i]);
    }
    return merged;
}

/**
 * The full contract in force on `target[key]` — the inheritance-aware twin of {@link getContract},
 * and what both enforcement and a projection should read (DEC-022).
 *
 * Each parameter's `constraints` is the union described on
 * {@link getEffectiveParameterConstraints}. `name`, `type` and `installed` come from the **nearest**
 * declaration rather than being merged, for the reason they do on
 * {@link getEffectiveFieldContract}: they describe the member a call actually reaches, and an
 * override's own recovered names are the ones its violation messages quote. `name` and `type` each
 * fall through independently to the nearest ancestor that has one, so a subclass compiled without
 * `emitDecoratorMetadata` degrades to the parent's type rather than to none.
 *
 * `pre` and `post` are concatenated base-most first on the same rule. Both are reserved and have no
 * writer yet (Q-11), so this is inert today — but conjunction is the correct rule for each of them
 * independently (a cross-parameter precondition follows this ruling; a postcondition strengthens
 * covariantly even under classical DbC), so a future writer inherits the right behaviour rather than
 * a placeholder.
 *
 * Returns `undefined` when nothing on the chain records the method.
 */
export function getEffectiveContract(target: ContractTarget, key: MethodKey): MethodContract | undefined {
    if (!isRegisterableTarget(target)) return undefined;

    // Own-most first, so `levels[0]` is the nearest declaration.
    const levels: MutableMethodContract[] = [];
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const contracts = contractsByTarget.get(cursor);
        const contract = contracts && contracts.get(key);
        if (contract) levels.push(contract);
    }

    if (levels.length === 0) return undefined;
    // No contracted ancestor — hand back the stored contract rather than rebuilding it.
    if (levels.length === 1) return levels[0];

    const indices: number[] = [];
    const seenIndices = new Set<number>();
    for (const level of levels) {
        for (const parameter of level.params) {
            if (seenIndices.has(parameter.index)) continue;
            seenIndices.add(parameter.index);
            indices.push(parameter.index);
        }
    }
    indices.sort((a, b) => a - b);

    const params: ParameterContract[] = indices.map(index => {
        let name: string | undefined;
        let type: Function | undefined;
        // `levels` is own-most first, so the first level that supplies either wins.
        for (const level of levels) {
            const parameter = findParameterEntry(level, index);
            if (!parameter) continue;
            if (name === undefined) name = parameter.name;
            if (type === undefined) type = parameter.type;
        }
        return {index, constraints: getEffectiveParameterConstraints(target, key, index), name, type};
    });

    const pre: ConstraintDescriptor[] = [];
    const post: ConstraintDescriptor[] = [];
    for (let level = levels.length - 1; level >= 0; level--) {
        const band = levels[level];
        for (let i = 0; i < band.pre.length; i++) pre.push(band.pre[i]);
        for (let i = 0; i < band.post.length; i++) post.push(band.post[i]);
    }

    return {params, pre, post, installed: levels[0].installed};
}

/**
 * Method keys recorded anywhere on `target`'s prototype chain, own-most level first, deduplicated.
 *
 * The method-band twin of {@link collectEffectiveFieldKeys}, exported because the installer needs it:
 * a subclass overriding a contracted method has no own entry to enumerate, so own-scoped enumeration
 * is exactly how an override used to escape enforcement (Q-15). What the installer does with a key it
 * does not own is its own decision — see `ContractInstaller.installOn`.
 */
export function getEffectiveContractKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];

    const keys: MethodKey[] = [];
    const seen = new Set<MethodKey>();

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const contracts = contractsByTarget.get(cursor);
        if (!contracts) continue;
        contracts.forEach((_contract, key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    }

    return keys;
}

/** One method's contract, tagged with which key band it was recorded on. */
export interface ClassMethodContract {
    readonly key: MethodKey;
    readonly contract: MethodContract;
    /** `true` when recorded against the constructor — i.e. a `static` method. */
    readonly isStatic: boolean;
    /** The object it is recorded against: `constructor` for statics, `constructor.prototype` otherwise. */
    readonly target: ContractTarget;
}

/**
 * Every contract on a class, from **both** key bands.
 *
 * ## Why this exists (Q-9)
 *
 * A class's contracts do not live in one place. Instance-method constraints are recorded against
 * `Class.prototype`; static-method constraints are recorded against the constructor itself, because
 * that is the object the decorator is handed. {@link getContractedClasses} returns only
 * `Function[]`, so every consumer had to know to look in both — and *getting it wrong does not
 * fail*. It silently emits an artifact that is missing every static method, which under DEC-006 is
 * the worst failure shape available: a generated document that looks complete and is not.
 *
 * That knowledge belongs here, once, rather than being re-derived by the documentation, schema,
 * arbitrary, and fuzz projections independently. This is the API they should walk.
 *
 * ## Inherited contracts are included (DEC-022)
 *
 * A subclass instance is checked against every constraint on its chain, so this reports every
 * constraint on its chain — including methods the subclass never mentions, and including an
 * ancestor's constraints on a method the subclass overrides. Reporting only own declarations would
 * put a generated document *behind* what is enforced, which is the exact asymmetry DEC-016 rejects
 * and BUG-16 was. This mirrors what DEC-021 did for {@link getFieldContractsForClass}. `installed`,
 * parameter names and types come from the nearest declaration — see {@link getEffectiveContract}.
 *
 * Ordering is deterministic — instance methods first, then statics; within each band, methods
 * declared on the class itself first, then inherited ones, each level in registry insertion order —
 * so a regenerated artifact does not produce spurious diffs.
 *
 * Returns an empty array for a class with nothing recorded, so callers iterate unconditionally.
 */
export function getContractsForClass(constructor: Function): ClassMethodContract[] {
    if (typeof constructor !== 'function') {
        throw new TypeError('getContractsForClass: expected a constructor function');
    }

    const entries: ClassMethodContract[] = [];

    // Guard the prototype read: `Class.prototype` is absent on an arrow function or a bound
    // function, and a class with only statics still has contracts worth reporting.
    const prototype = constructor.prototype;
    if (prototype) {
        getEffectiveContractKeys(prototype).forEach(key => {
            entries.push({
                key,
                contract: getEffectiveContract(prototype, key)!,
                isStatic: false,
                target: prototype,
            });
        });
    }

    getEffectiveContractKeys(constructor).forEach(key => {
        entries.push({
            key,
            contract: getEffectiveContract(constructor, key)!,
            isStatic: true,
            target: constructor,
        });
    });

    return entries;
}

// --- postcondition band reads (Q-11, DEC-022 union) ------------------------

/**
 * Postconditions declared **directly** on `target[key]`. Own-scoped exactly as {@link getContracts}
 * is: a subclass prototype returns only what was declared on it, never its ancestors'. For what is
 * actually enforced, use {@link getEffectivePostconditions}.
 */
export function getPostconditions(target: ContractTarget, key: MethodKey): ReadonlyArray<Postcondition> {
    if (!isRegisterableTarget(target)) return NO_POSTCONDITIONS;
    const list = postconditionsByTarget.get(target)?.get(key);
    return list ? list : NO_POSTCONDITIONS;
}

/**
 * Every postcondition in force on `target[key]`, base-most class first — the read the installer plans
 * from AND the read the fuzzer's oracle consumes.
 *
 * ## Conjunction is orthodox Meyer here, with no tension (DEC-022)
 *
 * The mechanism is identical to {@link getEffectiveFieldConstraints}: declarations are only ever
 * recorded against the object they were written on, and resolution concatenates every list found
 * walking the prototype chain. A subclass can only add conjuncts to its own list, so the resolved set
 * grows monotonically as you descend, and union of predicates is logical AND.
 *
 * For **postconditions** that AND is *covariant strengthening* — a subclass promises **at least** what
 * its ancestors promised, and may promise more — which is exactly Meyer's `ensure then`. Note the
 * contrast: for preconditions DEC-022 had to argue a *departure* from classical contravariance to use
 * the same union; for postconditions there is no departure and nothing to decide. Weakening is
 * unexpressible, and here that is precisely the guarantee, not a compromise.
 *
 * Base-most first so a violation reports the most general broken guarantee first (DEC-021/DEC-022
 * ordering). The common case — no contracted ancestor — returns the stored array itself with no copy.
 */
export function getEffectivePostconditions(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<Postcondition> {
    if (!isRegisterableTarget(target)) return NO_POSTCONDITIONS;

    // Collected own-most first; reversed on the way out so the base-most class leads.
    let nearest: Postcondition[] | undefined;
    let bands: Postcondition[][] | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const list = postconditionsByTarget.get(cursor)?.get(key);
        if (!list || list.length === 0) continue;

        if (!nearest) {
            nearest = list;
        } else {
            if (!bands) bands = [nearest];
            bands.push(list);
        }
    }

    if (!nearest) return NO_POSTCONDITIONS;
    // No contracted ancestor — hand back the stored array rather than copying it.
    if (!bands) return nearest;

    const merged: Postcondition[] = [];
    for (let level = bands.length - 1; level >= 0; level--) {
        const band = bands[level];
        for (let i = 0; i < band.length; i++) merged.push(band[i]);
    }
    return merged;
}

/**
 * Method keys carrying postconditions on `target` (own). Complements {@link getPostconditionKeys}'s
 * effective twin below and the {@link getStagedMethodKeys} the installer already unions.
 */
export function getPostconditionKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];
    const byKey = postconditionsByTarget.get(target);
    if (!byKey) return [];
    const keys: MethodKey[] = [];
    byKey.forEach((_list, key) => keys.push(key));
    return keys;
}

/**
 * Method keys carrying postconditions anywhere on `target`'s prototype chain, own-most level first,
 * deduplicated — the postcondition-band twin of {@link getEffectiveContractKeys}, and needed by the
 * installer for the same reason: a subclass overriding a method that only its ancestor gives a
 * postcondition has no own entry, so own-scoped enumeration would let the override escape the check.
 */
export function getEffectivePostconditionKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];

    const keys: MethodKey[] = [];
    const seen = new Set<MethodKey>();

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const byKey = postconditionsByTarget.get(cursor);
        if (!byKey) continue;
        byKey.forEach((_list, key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    }

    return keys;
}

// --- precondition band (IDEA-26 / DEC-057) — the input-side twin of the postcondition band ----------

/**
 * Cross-parameter preconditions (`@Requires`), keyed by target then method — the input-side twin of
 * {@link postconditionsByTarget}. A separate closure band (not the reserved descriptor `pre` slot) for
 * the same reason postconditions are: a {@link Precondition} is a closure with no identity/params.
 */
let preconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Precondition[]>>();

const NO_PRECONDITIONS: ReadonlyArray<Precondition> = Object.freeze([]);

/**
 * Preconditions declared **directly** on `target[key]`. Own-scoped, exactly as {@link getPostconditions}.
 * For what is enforced, use {@link getEffectivePreconditions}.
 */
export function getPreconditions(target: ContractTarget, key: MethodKey): ReadonlyArray<Precondition> {
    if (!isRegisterableTarget(target)) return NO_PRECONDITIONS;
    const list = preconditionsByTarget.get(target)?.get(key);
    return list ? list : NO_PRECONDITIONS;
}

/**
 * Every precondition in force on `target[key]`, base-most class first — the read the installer plans
 * from AND the read a fuzzer's argument oracle consumes. Mechanism identical to
 * {@link getEffectivePostconditions}: own-scoped storage unioned down the prototype chain, so a subclass
 * can only add conjuncts (strengthen). For preconditions this union is DEC-022's considered departure
 * from classical contravariant weakening — the same ruling parameter constraints already follow.
 */
export function getEffectivePreconditions(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<Precondition> {
    if (!isRegisterableTarget(target)) return NO_PRECONDITIONS;

    let nearest: Precondition[] | undefined;
    let bands: Precondition[][] | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const list = preconditionsByTarget.get(cursor)?.get(key);
        if (!list || list.length === 0) continue;

        if (!nearest) {
            nearest = list;
        } else {
            if (!bands) bands = [nearest];
            bands.push(list);
        }
    }

    if (!nearest) return NO_PRECONDITIONS;
    if (!bands) return nearest;

    const merged: Precondition[] = [];
    for (let level = bands.length - 1; level >= 0; level--) {
        const band = bands[level];
        for (let i = 0; i < band.length; i++) merged.push(band[i]);
    }
    return merged;
}

/** Method keys carrying preconditions on `target` (own) — the twin of {@link getPostconditionKeys}. */
export function getPreconditionKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];
    const byKey = preconditionsByTarget.get(target);
    if (!byKey) return [];
    const keys: MethodKey[] = [];
    byKey.forEach((_list, key) => keys.push(key));
    return keys;
}

/**
 * Method keys carrying preconditions anywhere on `target`'s prototype chain — the twin of
 * {@link getEffectivePostconditionKeys}, needed by the installer so a subclass override of a method whose
 * precondition only an ancestor declared does not escape the check.
 */
export function getEffectivePreconditionKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];

    const keys: MethodKey[] = [];
    const seen = new Set<MethodKey>();

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const byKey = preconditionsByTarget.get(cursor);
        if (!byKey) continue;
        byKey.forEach((_list, key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    }

    return keys;
}

/**
 * Record a precondition against `target[key]`. A method may carry several, recorded in declaration order
 * (the `@Requires` decorator passes `'prepend'` to normalise `__decorate`'s reversal, exactly as
 * `@Ensures`/`recordPostcondition`). Accepts a bare `{predicate}` — a precondition is a closure by
 * design, so the descriptor bands' "no bare predicates" rule does not apply (it has its own band).
 */
export function recordPrecondition(
    target: ContractTarget,
    key: MethodKey,
    precondition: Precondition,
    position: ConstraintPosition = 'append',
): void {
    if (!precondition || typeof precondition.predicate !== 'function') {
        throw new TypeError('recordPrecondition: expected a { predicate } object with a function predicate');
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordPrecondition: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const list = preconditionEntry(target, key);
    if (position === 'prepend') list.unshift(precondition);
    else list.push(precondition);
}

function preconditionEntry(target: ContractTarget, key: MethodKey): Precondition[] {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let byKey = preconditionsByTarget.get(target);
    if (!byKey) {
        byKey = new Map<MethodKey, Precondition[]>();
        preconditionsByTarget.set(target, byKey);
    }
    let list = byKey.get(key);
    if (!list) {
        list = [];
        byKey.set(key, list);
    }
    return list;
}

// --- enabledness band (`@EnabledWhen`, DEC-089) — the state-reading, receiver-aware guard band --------

/**
 * State-reading enabledness guards (`@EnabledWhen`), keyed by target then method. A **separate** closure
 * band from {@link preconditionsByTarget} — structurally distinct so downstream reads a *different
 * function* ({@link getEffectiveEnablednessGuards} vs {@link getEffectivePreconditions}) and the
 * type system, not a field test, keeps enabledness tellable-apart from an arg-only precondition. The
 * separation is also forced by the signature: a guard is `(self, ...args) => boolean` and cannot share
 * {@link Precondition}'s `(...args) => boolean` storage.
 */
let enablednessByTarget = new WeakMap<ContractTarget, Map<MethodKey, EnablednessGuard[]>>();

const NO_ENABLEDNESS: ReadonlyArray<EnablednessGuard> = Object.freeze([]);

/**
 * Enabledness guards declared **directly** on `target[key]`. Own-scoped, the twin of
 * {@link getPreconditions}. For what is enforced, use {@link getEffectiveEnablednessGuards}.
 */
export function getEnablednessGuards(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<EnablednessGuard> {
    if (!isRegisterableTarget(target)) return NO_ENABLEDNESS;
    const list = enablednessByTarget.get(target)?.get(key);
    return list ? list : NO_ENABLEDNESS;
}

/**
 * Every enabledness guard in force on `target[key]`, base-most class first — the read the installer plans
 * from AND the read the future stateful-sequence driver consumes to decide which commands are enabled.
 * Mechanism identical to {@link getEffectivePreconditions}: own-scoped storage unioned down the prototype
 * chain (DEC-022), so a subclass can only add conjuncts (strengthen the guard).
 */
export function getEffectiveEnablednessGuards(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<EnablednessGuard> {
    if (!isRegisterableTarget(target)) return NO_ENABLEDNESS;

    let nearest: EnablednessGuard[] | undefined;
    let bands: EnablednessGuard[][] | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const list = enablednessByTarget.get(cursor)?.get(key);
        if (!list || list.length === 0) continue;

        if (!nearest) {
            nearest = list;
        } else {
            if (!bands) bands = [nearest];
            bands.push(list);
        }
    }

    if (!nearest) return NO_ENABLEDNESS;
    if (!bands) return nearest;

    const merged: EnablednessGuard[] = [];
    for (let level = bands.length - 1; level >= 0; level--) {
        const band = bands[level];
        for (let i = 0; i < band.length; i++) merged.push(band[i]);
    }
    return merged;
}

/** Method keys carrying enabledness guards on `target` (own) — the twin of {@link getPreconditionKeys}. */
export function getEnablednessKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];
    const byKey = enablednessByTarget.get(target);
    if (!byKey) return [];
    const keys: MethodKey[] = [];
    byKey.forEach((_list, key) => keys.push(key));
    return keys;
}

/**
 * Method keys carrying enabledness guards anywhere on `target`'s prototype chain — the twin of
 * {@link getEffectivePreconditionKeys}, needed by the installer so a subclass override of a method whose
 * guard only an ancestor declared does not escape the check.
 */
export function getEffectiveEnablednessKeys(target: ContractTarget): MethodKey[] {
    if (!isRegisterableTarget(target)) return [];

    const keys: MethodKey[] = [];
    const seen = new Set<MethodKey>();

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const byKey = enablednessByTarget.get(cursor);
        if (!byKey) continue;
        byKey.forEach((_list, key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    }

    return keys;
}

/**
 * Record an enabledness guard against `target[key]`. A method may carry several, recorded in declaration
 * order (the `@EnabledWhen` decorator passes `'prepend'` to normalise `__decorate`'s reversal, exactly as
 * `@Requires`/`recordPrecondition`). The twin of {@link recordPrecondition}.
 */
export function recordEnablednessGuard(
    target: ContractTarget,
    key: MethodKey,
    guard: EnablednessGuard,
    position: ConstraintPosition = 'append',
): void {
    if (!guard || typeof guard.predicate !== 'function') {
        throw new TypeError(
            'recordEnablednessGuard: expected a { predicate } object with a function predicate',
        );
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordEnablednessGuard: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const list = enablednessEntry(target, key);
    if (position === 'prepend') list.unshift(guard);
    else list.push(guard);
}

function enablednessEntry(target: ContractTarget, key: MethodKey): EnablednessGuard[] {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let byKey = enablednessByTarget.get(target);
    if (!byKey) {
        byKey = new Map<MethodKey, EnablednessGuard[]>();
        enablednessByTarget.set(target, byKey);
    }
    let list = byKey.get(key);
    if (!list) {
        list = [];
        byKey.set(key, list);
    }
    return list;
}

// --- reified return-constraint band reads (DEC-033, Q-11) ------------------

/**
 * Every reified return constraint in force on `target[key]`, base-most class first — the descriptor
 * `@Returns(<descriptor>)` tier written by {@link recordReturnConstraint}. This is the read the
 * installer plans the return check from AND the read the fuzzer's oracle consumes for the reified band.
 *
 * A thin wrapper over the `post` union {@link getEffectiveContract} already computes: `post` is
 * concatenated base-most first there, so a subclass `@Returns` **conjoins** its ancestors' (covariant
 * strengthening, orthodox Meyer — free, exactly as the closure band's {@link getEffectivePostconditions}
 * is). It is the descriptor twin of the closure band, so a method may carry both: a `@Ensures` closure
 * (opaque, this returns nothing for it) and a `@Returns` descriptor (projectable, returned here).
 *
 * Kept **internal** — not exported from root `index.ts` — for the same reason
 * {@link getEffectiveContractKeys} is: it is installer/projection plumbing, and Q-6 makes every
 * registry export semver-relevant. A projection reads `getEffectiveContract().post` directly.
 */
export function getEffectiveReturnConstraints(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<ConstraintDescriptor> {
    const contract = getEffectiveContract(target, key);
    return contract ? contract.post : EMPTY_CONSTRAINTS;
}

// --- field band reads (GAP-9) ----------------------------------------------

/**
 * Field contracts recorded **directly** on `target`. Own-scoped exactly as {@link getContracts} is:
 * a subclass prototype returns only what was declared on it, never its parent's.
 *
 * This is the *declared-here* view, and it is **not** what enforcement applies. Since DEC-021 a
 * field's effective contract is the union of every declaration on its prototype chain — read
 * {@link getEffectiveFieldConstraints} for that. Own-scoped reads remain available because "declared
 * on this class" and "in force on this class" are genuinely different questions, and a projection
 * rendering an inheritance hierarchy needs both.
 */
export function getFieldContracts(target: ContractTarget): ReadonlyMap<FieldKey, FieldContract> {
    if (!isRegisterableTarget(target)) return EMPTY_FIELD_CONTRACTS;
    const fields = fieldsByTarget.get(target);
    return fields ? fields : EMPTY_FIELD_CONTRACTS;
}

/**
 * The contract declared directly on `target[key]`, or `undefined` if it declares none.
 *
 * Own-scoped — see {@link getFieldContracts}. For what is actually enforced, use
 * {@link getEffectiveFieldContract}.
 */
export function getFieldContract(target: ContractTarget, key: FieldKey): FieldContract | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const fields = fieldsByTarget.get(target);
    return fields ? fields.get(key) : undefined;
}

// --- effective (inheritance-aware) field reads (DEC-021, Q-14) --------------

/**
 * Every constraint in force on `target[key]`, including every one inherited from a superclass.
 *
 * ## Why the union, and why it is the *whole* mechanism (DEC-021)
 *
 * A subclass may **strengthen** an inherited field constraint and must never **weaken** it. That is
 * enforced structurally rather than by inspection: a declaration is only ever recorded against the
 * exact object it was written on, and resolution concatenates every list found walking the prototype
 * chain. A subclass has no way to reach, replace, or remove an ancestor's array — there is no write
 * API that takes an ancestor — so the resolved set can only ever grow as you descend. Union of
 * predicates is logical AND, and adding a conjunct is monotonically strengthening. **Weakening is
 * therefore not rejected; it is unexpressible.**
 *
 * That is deliberately not the alternative design, which would be to compare a subclass descriptor
 * against its parent's and reject the weaker one. Relative strength of two arbitrary predicates is
 * undecidable in general, so such a check could only ever work for the built-in constraints whose
 * params happen to be comparable — and would silently pass everything else, which is precisely the
 * "looks complete, is not" failure DEC-016 rejects.
 *
 * ## Ordering
 *
 * **Base-most class first**, then each subclass in turn, each level in its own declaration order.
 * A violation therefore reports the most general broken constraint first, which matches how a reader
 * scans a hierarchy from the top down, and it makes a subclass's additions read as additions.
 *
 * ## Cost
 *
 * This is on the assignment hot path. The walk is one `WeakMap` hit per prototype level, and the
 * common case — a field whose declaring class has no contracted ancestor — returns the stored array
 * itself with no copy or allocation. Nothing is memoised: field enforcement reads the registry on
 * every assignment by design (see {@link resetRegistry}), and caching resolved chains would make a
 * later `Object.setPrototypeOf` silently enforce the wrong contract.
 */
export function getEffectiveFieldConstraints(
    target: ContractTarget,
    key: FieldKey,
): ReadonlyArray<ConstraintDescriptor> {
    if (!isRegisterableTarget(target)) return EMPTY_CONSTRAINTS;

    // Collected own-most first; reversed on the way out so the base-most class leads.
    let nearest: ConstraintDescriptor[] | undefined;
    let bands: ConstraintDescriptor[][] | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const fields = fieldsByTarget.get(cursor);
        const contract = fields && fields.get(key);
        if (!contract || contract.constraints.length === 0) continue;

        if (!nearest) {
            nearest = contract.constraints;
        } else {
            if (!bands) bands = [nearest];
            bands.push(contract.constraints);
        }
    }

    if (!nearest) return EMPTY_CONSTRAINTS;
    // No contracted ancestor — hand back the stored array rather than copying it.
    if (!bands) return nearest;

    const merged: ConstraintDescriptor[] = [];
    for (let level = bands.length - 1; level >= 0; level--) {
        const band = bands[level];
        for (let i = 0; i < band.length; i++) merged.push(band[i]);
    }
    return merged;
}

/**
 * The full contract in force on `target[key]` — the inheritance-aware twin of
 * {@link getFieldContract}, and what a projection should render.
 *
 * `constraints` is the union described on {@link getEffectiveFieldConstraints}. `type` and
 * `installed` come from the **nearest** declaration rather than being merged, because both describe
 * the accessor a read or write actually reaches: a redeclaring subclass installs its own trampoline
 * which shadows its parent's, and its own `design:type` is the one the toolchain emitted for the
 * declaration a reader is looking at. `type` falls through to the nearest ancestor that has one, so
 * a subclass compiled without `emitDecoratorMetadata` degrades to the parent's type rather than to
 * none.
 *
 * Returns `undefined` when nothing on the chain declares the field.
 */
export function getEffectiveFieldContract(target: ContractTarget, key: FieldKey): FieldContract | undefined {
    if (!isRegisterableTarget(target)) return undefined;

    let nearest: MutableFieldContract | undefined;
    let type: Function | undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const fields = fieldsByTarget.get(cursor);
        const contract = fields && fields.get(key);
        if (!contract) continue;

        if (!nearest) nearest = contract;
        if (type === undefined) type = contract.type;
    }

    if (!nearest) return undefined;

    return {
        constraints: getEffectiveFieldConstraints(target, key),
        type,
        installed: nearest.installed,
    };
}

/** One field's contract, tagged with which key band it was recorded on. */
export interface ClassFieldContract {
    readonly key: FieldKey;
    readonly contract: FieldContract;
    /** `true` when recorded against the constructor — i.e. a `static` field. */
    readonly isStatic: boolean;
    /** The object it is recorded against: `constructor` for statics, `constructor.prototype` otherwise. */
    readonly target: ContractTarget;
}

/**
 * Every field contract **in force** on a class, from **both** key bands — the field-band twin of
 * {@link getContractsForClass}, and for the same reason (DEC-018).
 *
 * A static field's constraints are recorded against the constructor, an instance field's against the
 * prototype, and a projection that walks only one silently emits an artifact missing half the
 * contracts. That rule lives here once.
 *
 * ## Inherited fields are included (DEC-021)
 *
 * A subclass instance is enforced against every constraint on its chain, so this reports every
 * constraint on its chain — including fields the subclass never mentions, and including an ancestor's
 * constraints on a field the subclass redeclares. Reporting only own declarations would put a
 * generated document *behind* what is actually enforced, which is the exact asymmetry DEC-016 rejects
 * and BUG-16 was: enforced, and missing from an artifact that looks complete. `installed` and `type`
 * come from the nearest declaration — see {@link getEffectiveFieldContract}.
 *
 * Ordering is deterministic — instance fields first, then statics; within each band, fields declared
 * on the class itself first, then inherited ones, each level in registry insertion order.
 */
export function getFieldContractsForClass(constructor: Function): ClassFieldContract[] {
    if (typeof constructor !== 'function') {
        throw new TypeError('getFieldContractsForClass: expected a constructor function');
    }

    const entries: ClassFieldContract[] = [];

    const prototype = constructor.prototype;
    if (prototype) {
        collectEffectiveFieldKeys(prototype).forEach(key => {
            entries.push({
                key,
                contract: getEffectiveFieldContract(prototype, key)!,
                isStatic: false,
                target: prototype,
            });
        });
    }

    collectEffectiveFieldKeys(constructor).forEach(key => {
        entries.push({
            key,
            contract: getEffectiveFieldContract(constructor, key)!,
            isStatic: true,
            target: constructor,
        });
    });

    return entries;
}

/**
 * Field keys declared anywhere on `host`'s prototype chain, own-most level first, deduplicated.
 *
 * A subclass redeclaring an inherited field yields one entry, not two — the two declarations are one
 * contract once resolved (DEC-021), and a document listing the field twice would misrepresent that.
 */
function collectEffectiveFieldKeys(host: ContractTarget): FieldKey[] {
    const keys: FieldKey[] = [];
    const seen = new Set<FieldKey>();

    for (let cursor: object | null = host; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const fields = fieldsByTarget.get(cursor);
        if (!fields) continue;
        fields.forEach((_contract, key) => {
            if (seen.has(key)) return;
            seen.add(key);
            keys.push(key);
        });
    }

    return keys;
}

// ---------------------------------------------------------------------------
// Writes — called by adapters and installers
// ---------------------------------------------------------------------------

/**
 * Where a newly recorded constraint goes within its parameter's list.
 *
 * `'append'` is the default and is what a caller recording in declaration order wants. `'prepend'`
 * exists for an adapter whose decorators arrive in *reverse* declaration order — see
 * {@link recordParameterConstraint}.
 */
export type ConstraintPosition = 'append' | 'prepend';

/**
 * Record a constraint against a parameter position. A parameter may carry several constraints, and
 * the same position may be written more than once.
 *
 * ## Why `position` exists (SMELL-13)
 *
 * Parameters are kept index-sorted, so *across* parameters the registry is already in declaration
 * order. Within a single parameter it was not: constraints were appended in arrival order, and the
 * legacy adapter's decorators arrive bottom-up because `__decorate` applies its array back-to-front.
 * So `@GreaterThanEqual(100) @LessThanEqual(1000) n` **enforced GTE first** — the installer
 * normalises (DEC-015) — while the registry, and therefore every generated document, **listed LTE
 * first**.
 *
 * No semantic disagreement, so not the descriptor/predicate drift of Q-4. But it is enforcement and
 * documentation describing one declaration two different ways, which is precisely the trust the
 * flagship goal is built on (DEC-006). Under "one declaration, four artifacts", a reader has no way
 * to tell a cosmetic reordering from a real one.
 *
 * The fix is a `position` argument rather than the installer reaching in and reversing the
 * registry's arrays. An adapter that knows its own decorators arrive backwards passes `'prepend'`
 * and the store is correct *as recorded* — so knowledge of `__decorate`'s application order stays in
 * the adapter (the only layer entitled to it, DEC-015), while the registry stays the single place
 * that defines what its own ordering means. A standard-decorator adapter, whose decorators arrive
 * in declaration order, simply takes the default.
 */
export function recordParameterConstraint(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    constraint: ConstraintDescriptor,
    position: ConstraintPosition = 'append',
): void {
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'recordParameterConstraint: expected a ConstraintDescriptor. Bare predicates are not ' +
                'accepted — a closure carries no identity or params, so nothing can be projected from it ' +
                '(DEC-006).',
        );
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordParameterConstraint: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const constraints = parameterEntry(methodEntry(target, key), index).constraints;
    if (position === 'prepend') constraints.unshift(constraint);
    else constraints.push(constraint);
}

/**
 * Attach recovered name / reflected type to a parameter position. Separate from constraint
 * recording because these arrive from different places and either may be absent.
 *
 * ## BUG-14 — this had no production caller
 *
 * It was written in P1.1 and then never wired up, so the only things that ever called it were its own
 * tests and the documentation projection's tests. Enforcement, meanwhile, recovered real parameter
 * names for its violation messages and never told anyone. One declaration therefore produced an error
 * saying `parameter 'sku'` and a generated document saying `arg0` — two artifacts from one source,
 * disagreeing, which is the exact failure DEC-006 exists to prevent.
 *
 * Worse, it was **masked by construction**: the projection's tests populate the registry by hand
 * through this function, so they exercised a path no real decorator ever took and reported green.
 *
 * The caller is now `ParameterDecoratorFactory.captureSignature`, which records the *same*
 * `getParamNames` result that the violation message is built from — one computation, both artifacts.
 * Passing `undefined` for either field leaves the stored value alone, so a toolchain that cannot
 * supply types degrades to "no type" rather than to a fabricated one.
 */
export function setParameterMetadata(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    metadata: {name?: string; type?: Function},
): void {
    const entry = parameterEntry(methodEntry(target, key), index);
    if (metadata.name !== undefined) entry.name = metadata.name;
    if (metadata.type !== undefined) entry.type = metadata.type;
}

/** Mark a method as wrapped by an installer. */
export function markInstalled(target: ContractTarget, key: MethodKey): void {
    methodEntry(target, key).installed = true;
}

// --- field band writes (GAP-9) ---------------------------------------------

/**
 * Record a constraint against a field. A field may carry several, and the same field may be written
 * more than once.
 *
 * `position` means exactly what it does on {@link recordParameterConstraint}, and exists for the same
 * reason: an adapter whose decorators arrive in reverse declaration order passes `'prepend'` so the
 * store is correct *as recorded*, keeping knowledge of `__decorate`'s back-to-front application in
 * the adapter (DEC-015/DEC-017) rather than leaking it into the registry. The legacy field adapter
 * passes `'prepend'`; a standard-decorator adapter takes the default.
 */
export function recordFieldConstraint(
    target: ContractTarget,
    key: FieldKey,
    constraint: ConstraintDescriptor,
    position: ConstraintPosition = 'append',
): void {
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'recordFieldConstraint: expected a ConstraintDescriptor. Bare predicates are not ' +
                'accepted — a closure carries no identity or params, so nothing can be projected from it ' +
                '(DEC-006).',
        );
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordFieldConstraint: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const constraints = fieldEntry(target, key).constraints;
    if (position === 'prepend') constraints.unshift(constraint);
    else constraints.push(constraint);
}

/**
 * Attach the reflected type to a field. The field-band twin of {@link setParameterMetadata}; a field
 * needs no `name` because its key *is* its name, so `design:type` is the only metadata there is.
 *
 * `undefined` leaves the stored value alone — the same honest-degradation rule.
 */
export function setFieldMetadata(target: ContractTarget, key: FieldKey, metadata: {type?: Function}): void {
    const entry = fieldEntry(target, key);
    if (metadata.type !== undefined) entry.type = metadata.type;
}

/** Mark a field as carrying an installed validating accessor. */
export function markFieldInstalled(target: ContractTarget, key: FieldKey): void {
    fieldEntry(target, key).installed = true;
}

// --- postcondition band writes (Q-11) --------------------------------------

/**
 * Record a postcondition against `target[key]`. A method may carry several; they are recorded in
 * declaration order by the adapter (the `@Ensures` decorator passes `'prepend'` to normalise
 * `__decorate`'s reversal, exactly as `stageCheck` unshifts — DEC-015/DEC-017).
 *
 * Unlike {@link recordParameterConstraint}, this accepts a bare `{predicate}`: a postcondition is a
 * closure by design (see {@link Postcondition}), so the "no bare predicates" rule that guards the
 * descriptor bands does not apply here — this is its own band precisely so that rule is not violated.
 */
export function recordPostcondition(
    target: ContractTarget,
    key: MethodKey,
    postcondition: Postcondition,
    position: ConstraintPosition = 'append',
): void {
    if (!postcondition || typeof postcondition.predicate !== 'function') {
        throw new TypeError('recordPostcondition: expected a { predicate } object with a function predicate');
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordPostcondition: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const list = postconditionEntry(target, key);
    if (position === 'prepend') list.unshift(postcondition);
    else list.push(postcondition);
}

function postconditionEntry(target: ContractTarget, key: MethodKey): Postcondition[] {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let byKey = postconditionsByTarget.get(target);
    if (!byKey) {
        byKey = new Map<MethodKey, Postcondition[]>();
        postconditionsByTarget.set(target, byKey);
    }
    let list = byKey.get(key);
    if (!list) {
        list = [];
        byKey.set(key, list);
    }
    return list;
}

// --- reified return-constraint band writes (DEC-033, Q-11) -----------------

/**
 * Record a descriptor-shaped postcondition against `target[key]` — the reified `@Returns(<descriptor>)`
 * tier. Writes to the reserved {@link MethodContract.post} slot (Q-11 kept it reserved for exactly
 * this; DEC-032/DEC-033), the *first* writer that slot has ever had.
 *
 * This is the projectable half of the postcondition story. Unlike a `@Ensures` closure — which lives
 * in its own band ({@link recordPostcondition}) precisely because a closure carries no identity or
 * params — a return descriptor is data: it is checked by the same `descriptor.predicate` machinery
 * parameter constraints use (DEC-010) AND emitted into docs/schema. It therefore rejects a bare
 * predicate exactly as {@link recordParameterConstraint} does; a closure does not live in a descriptor
 * band.
 *
 * `position` means what it does on {@link recordParameterConstraint}: `@Returns` passes `'prepend'`
 * because method decorators stack bottom-up under `__decorate`, so prepending yields declaration order
 * (DEC-015/DEC-017), matching `@Ensures`.
 */
export function recordReturnConstraint(
    target: ContractTarget,
    key: MethodKey,
    constraint: ConstraintDescriptor,
    position: ConstraintPosition = 'append',
): void {
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'recordReturnConstraint: expected a ConstraintDescriptor. Bare predicates are not ' +
                'accepted — a closure carries no identity or params, so nothing can be projected from it ' +
                '(DEC-006). Use @Ensures for a closure postcondition.',
        );
    }
    if (position !== 'append' && position !== 'prepend') {
        throw new TypeError(
            `recordReturnConstraint: position must be 'append' or 'prepend', received ${String(position)}`,
        );
    }

    const post = methodEntry(target, key).post;
    if (position === 'prepend') post.unshift(constraint);
    else post.push(constraint);
}

// --- sensitivity band writes (DEC-PII-1/2) ---------------------------------
//
// Record-only. None of these install anything or touch the enforcement bands. Writes stay
// own-scoped exactly as the constraint bands do — which is the entire mechanism that makes a
// subclass unable to un-mark an inherited sensitive field: there is no write API that reaches an
// ancestor, so resolution ({@link getEffectiveFieldSensitivity}) can only ever *find* a marking on
// the chain, never remove one. Weakening is unexpressible, not rejected (the DEC-021 move).

/** Record that `target[key]` is sensitive. `target` is a prototype (instance field) or constructor. */
export function recordFieldSensitivity(
    target: ContractTarget,
    key: FieldKey,
    marking: SensitivityMarking,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('recordFieldSensitivity: target must be an object (a prototype or constructor)');
    }
    let fields = fieldSensitivityByTarget.get(target);
    if (!fields) {
        fields = new Map<FieldKey, SensitivityMarking>();
        fieldSensitivityByTarget.set(target, fields);
    }
    fields.set(key, marking);
}

/** Record that parameter `index` of `target[key]` is sensitive. Index-keyed, so minification-safe. */
export function recordParameterSensitivity(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    marking: SensitivityMarking,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError(
            'recordParameterSensitivity: target must be an object (a prototype or constructor)',
        );
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `recordParameterSensitivity: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    let methods = parameterSensitivityByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, Map<number, SensitivityMarking>>();
        parameterSensitivityByTarget.set(target, methods);
    }
    let params = methods.get(key);
    if (!params) {
        params = new Map<number, SensitivityMarking>();
        methods.set(key, params);
    }
    params.set(index, marking);
}

/** Record that a whole class is sensitive — `@Sensitive` on the class marks every field it holds. */
export function recordClassSensitivity(constructor: Function, marking: SensitivityMarking): void {
    if (typeof constructor !== 'function') {
        throw new TypeError('recordClassSensitivity: expected a constructor function');
    }
    classSensitivityByTarget.set(constructor, marking);
}

// --- telemetry-disclosure band writes (O1c, DEC-036) -----------------------
//
// Record-only, exactly like the sensitivity band above: none of these install anything or touch an
// enforcement band. Own-scoped, so there is no write API that reaches an ancestor — a subclass can only
// add its own opt-in, never remove an inherited one.

/** Record that parameter `index` of `target[key]` opts its value into telemetry. Index-keyed. */
export function recordParameterTelemetry(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    marking: TelemetryMarking,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError(
            'recordParameterTelemetry: target must be an object (a prototype or constructor)',
        );
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `recordParameterTelemetry: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    let methods = parameterTelemetryByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, Map<number, TelemetryMarking>>();
        parameterTelemetryByTarget.set(target, methods);
    }
    let params = methods.get(key);
    if (!params) {
        params = new Map<number, TelemetryMarking>();
        methods.set(key, params);
    }
    params.set(index, marking);
}

/** Record that the return of `target[key]` opts into telemetry (`@Telemetry.result()`). */
export function recordReturnTelemetry(
    target: ContractTarget,
    key: MethodKey,
    marking: TelemetryMarking,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('recordReturnTelemetry: target must be an object (a prototype or constructor)');
    }
    let methods = returnTelemetryByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, TelemetryMarking>();
        returnTelemetryByTarget.set(target, methods);
    }
    methods.set(key, marking);
}

// --- sensitivity band reads (DEC-PII-1/2) ----------------------------------

/** The marking declared **directly** on `target[key]`, or `undefined`. Own-scoped. */
export function getFieldSensitivity(target: ContractTarget, key: FieldKey): SensitivityMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const fields = fieldSensitivityByTarget.get(target);
    return fields ? fields.get(key) : undefined;
}

/** The marking on parameter `index` of `target[key]`, or `undefined`. Own-scoped. */
export function getParameterSensitivity(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): SensitivityMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const params = parameterSensitivityByTarget.get(target)?.get(key);
    return params ? params.get(index) : undefined;
}

/** The class-level marking declared directly on `constructor`, or `undefined`. Own-scoped. */
export function getClassSensitivity(constructor: Function): SensitivityMarking | undefined {
    if (typeof constructor !== 'function') return undefined;
    return classSensitivityByTarget.get(constructor);
}

/**
 * The marking **in force** on `target[key]`, honouring inheritance (DEC-021). Returns a marking when
 * *any* level of the prototype chain marks the field, or when *any* class in the hierarchy is marked
 * at the class level — never when a subclass merely fails to restate an inherited marking.
 *
 * This reuses the field band's exact resolution shape (a prototype-chain walk over own-scoped
 * storage): a marking found anywhere on the chain wins, and there is no way to express its removal,
 * so a subclass cannot un-mark an inherited sensitive field. Over-marking is the safe direction for a
 * privacy marking (DEC-PII-1: never load-bearing, so a spurious mark costs nothing), which is why a
 * class-level marking anywhere on the chain sensitises every field read through it.
 */
export function getEffectiveFieldSensitivity(
    target: ContractTarget,
    key: FieldKey,
): SensitivityMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;

    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const own = fieldSensitivityByTarget.get(cursor)?.get(key);
        if (own) return own;
        // A class-level marking on the class owning this prototype level sensitises all its fields.
        const owner = (cursor as {constructor?: Function}).constructor;
        if (typeof owner === 'function') {
            const classMark = classSensitivityByTarget.get(owner);
            if (classMark) return classMark;
        }
    }
    return undefined;
}

/**
 * The class-level marking in force on `constructor`, honouring inheritance: a subclass of a
 * `@Sensitive` class is itself sensitive and cannot shed it. Walks the constructor chain
 * (`Object.getPrototypeOf(ctor)` is the parent constructor for an ES class).
 */
export function getEffectiveClassSensitivity(constructor: Function): SensitivityMarking | undefined {
    if (typeof constructor !== 'function') return undefined;
    for (
        let cursor: unknown = constructor;
        typeof cursor === 'function';
        cursor = Object.getPrototypeOf(cursor)
    ) {
        const mark = classSensitivityByTarget.get(cursor as Function);
        if (mark) return mark;
    }
    return undefined;
}

// --- telemetry-disclosure band reads (O1c, DEC-036) ------------------------

/** The marking on parameter `index` of `target[key]`, or `undefined`. Own-scoped. */
export function getParameterTelemetry(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): TelemetryMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const params = parameterTelemetryByTarget.get(target)?.get(key);
    return params ? params.get(index) : undefined;
}

/**
 * The marking **in force** on parameter `index` of `target[key]`, honouring inheritance: the nearest
 * declaration on the prototype chain wins (a subclass may add its own opt-in; it cannot un-mark an
 * inherited one). The read the disclosure resolver and the privacy projection both use.
 */
export function getEffectiveParameterTelemetry(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): TelemetryMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const own = parameterTelemetryByTarget.get(cursor)?.get(key)?.get(index);
        if (own) return own;
    }
    return undefined;
}

/** The return marking declared directly on `target[key]`, or `undefined`. Own-scoped. */
export function getReturnTelemetry(target: ContractTarget, key: MethodKey): TelemetryMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const methods = returnTelemetryByTarget.get(target);
    return methods ? methods.get(key) : undefined;
}

/** The return marking **in force** on `target[key]`, honouring inheritance (nearest declaration wins). */
export function getEffectiveReturnTelemetry(
    target: ContractTarget,
    key: MethodKey,
): TelemetryMarking | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const own = returnTelemetryByTarget.get(cursor)?.get(key);
        if (own) return own;
    }
    return undefined;
}

/**
 * Parameter indices carrying a telemetry marking on `target[key]`, own-scoped. The privacy projection
 * unions these with the constraint band's parameter indices, so a parameter that opted its value in via
 * `@Telemetry.value()` but carries no *constraint* is still reported — otherwise a value could leave the
 * process without appearing in the "what leaves the process" table (the DEC-016 asymmetry).
 */
export function getTelemetryParameterIndices(target: ContractTarget, key: MethodKey): number[] {
    if (!isRegisterableTarget(target)) return [];
    const params = parameterTelemetryByTarget.get(target)?.get(key);
    if (!params) return [];
    const indices: number[] = [];
    params.forEach((_marking, index) => indices.push(index));
    return indices;
}

/**
 * Method keys carrying **any** telemetry marking (parameter or return) on a class, from both key bands —
 * instance members on the prototype, statics on the constructor. The privacy projection unions these
 * with {@link getContractsForClass} so a telemetry-marked method with no contract is not silently
 * dropped from the "what leaves the process" table.
 */
export function getTelemetryMethodKeysForClass(
    constructor: Function,
): Array<{key: MethodKey; isStatic: boolean; target: ContractTarget}> {
    if (typeof constructor !== 'function') {
        throw new TypeError('getTelemetryMethodKeysForClass: expected a constructor function');
    }
    const out: Array<{key: MethodKey; isStatic: boolean; target: ContractTarget}> = [];
    const collect = (target: ContractTarget, isStatic: boolean) => {
        const seen = new Set<MethodKey>();
        const paramMethods = parameterTelemetryByTarget.get(target);
        if (paramMethods) paramMethods.forEach((_params, key) => seen.add(key));
        const returnMethods = returnTelemetryByTarget.get(target);
        if (returnMethods) returnMethods.forEach((_marking, key) => seen.add(key));
        seen.forEach(key => out.push({key, isStatic, target}));
    };
    if (constructor.prototype) collect(constructor.prototype, false);
    collect(constructor, true);
    return out;
}

// --- @Optional / @Default band writes (DEC-051) ----------------------------
//
// Record-only, exactly like the sensitivity/telemetry bands above: none of these install anything or
// touch an enforcement band. Own-scoped, so there is no write API that reaches an ancestor.

/** Record that parameter `index` of `target[key]` is `@Optional`. Index-keyed, so minification-safe. */
export function recordParameterOptional(target: ContractTarget, key: MethodKey, index: number): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('recordParameterOptional: target must be an object (a prototype or constructor)');
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `recordParameterOptional: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    let methods = parameterOptionalByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, Map<number, OptionalMarking>>();
        parameterOptionalByTarget.set(target, methods);
    }
    let params = methods.get(key);
    if (!params) {
        params = new Map<number, OptionalMarking>();
        methods.set(key, params);
    }
    params.set(index, {optional: true});
}

/**
 * Record a `@Default` value for parameter `index` of `target[key]`. `value` must already be a plain
 * JSON value — the decorator validates that at authoring time (`Markers/Default.ts`), so the emitted
 * `{default}` fragment is always valid JSON. Index-keyed, so minification-safe.
 */
export function recordParameterDefault(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    value: JsonValue,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('recordParameterDefault: target must be an object (a prototype or constructor)');
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `recordParameterDefault: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    let methods = parameterDefaultByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, Map<number, JsonValue>>();
        parameterDefaultByTarget.set(target, methods);
    }
    let params = methods.get(key);
    if (!params) {
        params = new Map<number, JsonValue>();
        methods.set(key, params);
    }
    params.set(index, value);
}

// --- @Optional / @Default band reads (DEC-051) -----------------------------

/** Whether parameter `index` of `target[key]` is marked `@Optional` **directly** here. Own-scoped. */
export function getParameterOptional(target: ContractTarget, key: MethodKey, index: number): boolean {
    if (!isRegisterableTarget(target)) return false;
    return parameterOptionalByTarget.get(target)?.get(key)?.get(index)?.optional === true;
}

/**
 * Whether parameter `index` of `target[key]` is **effectively** optional — the single read BOTH the
 * installer guard (`ParameterDecoratorFactory.planChecks`) and the tool schema's `required` derive from,
 * so enforcement and the schema cannot drift (DEC-051 invariant 4).
 *
 * ## Required-wins, NOT over-marking (the S2 safety fix — DEC-016/DEC-022)
 *
 * `@Optional` is a precondition *weakening* (it removes a check and drops a `required` entry), so —
 * unlike the sensitivity band, where over-marking is the *safe* direction — resolving it by
 * "optional anywhere on the chain ⇒ optional" would let a subclass **silently** weaken a value its
 * base genuinely constrains, the exact under-enforcement DEC-016 forbids. So the rule is:
 *
 *   effective-optional **iff** `@Optional` is marked on ≥1 declaration for the position **AND** no
 *   declaration on the chain *requires* it, where a declaration "requires" it = it carries ≥1 own
 *   constraint at that position AND does not itself mark the position `@Optional`.
 *
 * A single requiring declaration anywhere on the chain wins (returns `false`) regardless of any
 * `@Optional` marking elsewhere. This satisfies the four pinned invariants: (1) marked-and-never-required
 * ⇒ optional; (2) constrained-required base + `@Optional` subclass ⇒ REQUIRED (no silent weakening);
 * (3) `@Optional` base + constrained subclass override ⇒ REQUIRED (subclass strengthened); (4) same read
 * feeds enforcement and schema.
 *
 * Note: "requires" is measured against the *descriptor* constraint band only (`contractsByTarget`); a
 * hand-written `CreateSimpleDecorator` closure is invisible to the registry by design (SMELL-14), so it
 * does not count as a requiring declaration here — the same limitation every projection already carries.
 */
export function getEffectiveParameterOptional(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): boolean {
    if (!isRegisterableTarget(target)) return false;

    let markedOptional = false;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const optionalHere = parameterOptionalByTarget.get(cursor)?.get(key)?.get(index)?.optional === true;
        if (optionalHere) {
            markedOptional = true;
            // A declaration that marks the position optional does not "require" it, even if it also
            // constrains it (the `@Optional() @GreaterThanEqual(1)` common case) — skip the requires test.
            continue;
        }
        // Does THIS declaration require the position? ≥1 own constraint and no own `@Optional` mark.
        const contract = contractsByTarget.get(cursor)?.get(key);
        const parameter = contract && findParameterEntry(contract, index);
        if (parameter && parameter.constraints.length > 0) return false;
    }
    return markedOptional;
}

/** The `@Default` value declared **directly** on parameter `index` of `target[key]`, or `undefined`. Own-scoped. */
export function getParameterDefault(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): JsonValue | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const params = parameterDefaultByTarget.get(target)?.get(key);
    return params ? params.get(index) : undefined;
}

/**
 * The `@Default` value **in force** on parameter `index` of `target[key]`, honouring inheritance:
 * nearest declaration on the prototype chain wins (a subclass override's default shadows the base's).
 * Returns `undefined` when no declaration on the chain supplies one; a stored `null` default is a real,
 * distinct value (the map holds it explicitly).
 */
export function getEffectiveParameterDefault(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): JsonValue | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const params = parameterDefaultByTarget.get(cursor)?.get(key);
        if (params && params.has(index)) return params.get(index);
    }
    return undefined;
}

// --- @Describe / @Tool band writes (Q-30) ----------------------------------
//
// Record-only, exactly like the sensitivity/telemetry/@Optional bands above: none install anything or
// touch an enforcement band. Own-scoped, so there is no write API that reaches an ancestor.

/**
 * Record the `@Describe` text for parameter `index` of `target[key]`. Index-keyed, so minification-safe.
 * `text` is validated non-empty at authoring time (`Markers/Describe.ts`); stored verbatim.
 */
export function recordParameterDescription(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    text: string,
): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError(
            'recordParameterDescription: target must be an object (a prototype or constructor)',
        );
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `recordParameterDescription: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    let methods = parameterDescriptionByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, Map<number, string>>();
        parameterDescriptionByTarget.set(target, methods);
    }
    let params = methods.get(key);
    if (!params) {
        params = new Map<number, string>();
        methods.set(key, params);
    }
    params.set(index, text);
}

/**
 * Record the `@Tool` description for `target[key]`. `text` is validated non-empty at authoring time
 * (`Markers/Tool.ts`); stored verbatim.
 */
export function recordMethodDescription(target: ContractTarget, key: MethodKey, text: string): void {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('recordMethodDescription: target must be an object (a prototype or constructor)');
    }
    let methods = methodDescriptionByTarget.get(target);
    if (!methods) {
        methods = new Map<MethodKey, string>();
        methodDescriptionByTarget.set(target, methods);
    }
    methods.set(key, text);
}

// --- @Describe / @Tool band reads (Q-30) -----------------------------------

/** The `@Describe` text declared **directly** on parameter `index` of `target[key]`, or `undefined`. Own-scoped. */
export function getParameterDescription(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): string | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const params = parameterDescriptionByTarget.get(target)?.get(key);
    return params ? params.get(index) : undefined;
}

/**
 * The `@Describe` text **in force** on parameter `index` of `target[key]`, honouring inheritance: the
 * nearest declaration on the prototype chain wins (a subclass override's description shadows the base's).
 * A description is an annotation, not a precondition — nearest-wins, not the constraint band's union.
 */
export function getEffectiveParameterDescription(
    target: ContractTarget,
    key: MethodKey,
    index: number,
): string | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const params = parameterDescriptionByTarget.get(cursor)?.get(key);
        if (params && params.has(index)) return params.get(index);
    }
    return undefined;
}

/** The `@Tool` description declared **directly** on `target[key]`, or `undefined`. Own-scoped. */
export function getMethodDescription(target: ContractTarget, key: MethodKey): string | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const methods = methodDescriptionByTarget.get(target);
    return methods ? methods.get(key) : undefined;
}

/** The `@Tool` description **in force** on `target[key]`, honouring inheritance (nearest declaration wins). */
export function getEffectiveMethodDescription(target: ContractTarget, key: MethodKey): string | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        const own = methodDescriptionByTarget.get(cursor)?.get(key);
        if (own !== undefined) return own;
    }
    return undefined;
}

/**
 * Parameter indices carrying a `@Describe` marking on `target[key]`, own-scoped — the description-band
 * twin of {@link getTelemetryParameterIndices}. The tool-schema projection unions these with the
 * constraint band's parameter indices, so a `@Describe` on a parameter that carries no *constraint* is
 * still surfaced (the S1 fix) rather than silently dropped from `properties`.
 */
export function getDescriptionParameterIndices(target: ContractTarget, key: MethodKey): number[] {
    if (!isRegisterableTarget(target)) return [];
    const params = parameterDescriptionByTarget.get(target)?.get(key);
    if (!params) return [];
    const indices: number[] = [];
    params.forEach((_text, index) => indices.push(index));
    return indices;
}

/**
 * Method keys carrying **any** description marking (`@Tool` or a parameter `@Describe`) on a class, from
 * both key bands — the description-band twin of {@link getTelemetryMethodKeysForClass}. The tool-schema
 * projection unions these with {@link getContractsForClass} so a `@Tool`-only method with no *constraint*
 * still projects (the S1 fix: it would otherwise NPE reading a marker off an absent contract entry).
 */
export function getDescriptionMethodKeysForClass(
    constructor: Function,
): Array<{key: MethodKey; isStatic: boolean; target: ContractTarget}> {
    if (typeof constructor !== 'function') {
        throw new TypeError('getDescriptionMethodKeysForClass: expected a constructor function');
    }
    const out: Array<{key: MethodKey; isStatic: boolean; target: ContractTarget}> = [];
    const collect = (target: ContractTarget, isStatic: boolean) => {
        const seen = new Set<MethodKey>();
        const paramMethods = parameterDescriptionByTarget.get(target);
        if (paramMethods) paramMethods.forEach((_params, key) => seen.add(key));
        const methodDescs = methodDescriptionByTarget.get(target);
        if (methodDescs) methodDescs.forEach((_text, key) => seen.add(key));
        seen.forEach(key => out.push({key, isStatic, target}));
    };
    if (constructor.prototype) collect(constructor.prototype, false);
    collect(constructor, true);
    return out;
}

/**
 * Add a class to the enumerable registry. Called by the `@Contract()` installer (P1.3) — *not* by
 * constraint recording, so `getContractedClasses()` reports exactly the classes that were
 * annotated, which is also exactly the set whose contracts are actually enforced.
 *
 * A no-op when enumeration is disabled.
 */
export function registerContractedClass(constructor: Function): void {
    if (!classEnumerationEnabled) return;
    if (typeof constructor !== 'function') {
        throw new TypeError('registerContractedClass: expected a constructor function');
    }
    contractedClasses.add(constructor);
}

// ---------------------------------------------------------------------------
// Configuration & test support
// ---------------------------------------------------------------------------

/**
 * Opt out of the enumerable class registry (DEC-011). Disabling it drops the strong references
 * — and with them every projection that needs enumeration. Clears any already-registered classes
 * so the opt-out actually releases memory rather than merely stopping additions.
 */
export function setClassEnumerationEnabled(enabled: boolean): void {
    classEnumerationEnabled = enabled;
    if (!enabled) contractedClasses.clear();
}

export function isClassEnumerationEnabled(): boolean {
    return classEnumerationEnabled;
}

/**
 * Drop all registry state. Test support — the per-target store is replaced wholesale because a
 * `WeakMap` cannot be cleared, which is the same non-enumerability that motivates DEC-011.
 *
 * ## It now disarms already-installed field contracts (GAP-9 consequence)
 *
 * Method enforcement is *planned* at install time into closures that hold their descriptors, so
 * clearing the registry afterwards does not stop a wrapper checking. **Field enforcement reads the
 * registry on every assignment**, so a field accessor installed before this call will find no
 * constraints and silently accept anything.
 *
 * That asymmetry is a property of the two enforcement strategies, not something introduced here, but
 * it only became reachable when the field store moved into the registry — so it is stated rather than
 * left to be discovered. Test support only: no production path calls this, and any suite that resets
 * between tests must declare its contracted classes *inside* the test rather than at module scope.
 */
export function resetRegistry(): void {
    contractsByTarget = new WeakMap<ContractTarget, Map<MethodKey, MutableMethodContract>>();
    fieldsByTarget = new WeakMap<ContractTarget, Map<FieldKey, MutableFieldContract>>();
    postconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Postcondition[]>>();
    preconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Precondition[]>>();
    enablednessByTarget = new WeakMap<ContractTarget, Map<MethodKey, EnablednessGuard[]>>();
    contractedClasses = new Set<Function>();
    fieldSensitivityByTarget = new WeakMap<ContractTarget, Map<FieldKey, SensitivityMarking>>();
    parameterSensitivityByTarget = new WeakMap<
        ContractTarget,
        Map<MethodKey, Map<number, SensitivityMarking>>
    >();
    classSensitivityByTarget = new WeakMap<Function, SensitivityMarking>();
    parameterTelemetryByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, TelemetryMarking>>>();
    returnTelemetryByTarget = new WeakMap<ContractTarget, Map<MethodKey, TelemetryMarking>>();
    parameterOptionalByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, OptionalMarking>>>();
    parameterDefaultByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, JsonValue>>>();
    parameterDescriptionByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, string>>>();
    methodDescriptionByTarget = new WeakMap<ContractTarget, Map<MethodKey, string>>();
    classEnumerationEnabled = true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isRegisterableTarget(target: ContractTarget): boolean {
    return target !== null && (typeof target === 'object' || typeof target === 'function');
}

function methodEntry(target: ContractTarget, key: MethodKey): MutableMethodContract {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let contracts = contractsByTarget.get(target);
    if (!contracts) {
        contracts = new Map<MethodKey, MutableMethodContract>();
        contractsByTarget.set(target, contracts);
    }
    let contract = contracts.get(key);
    if (!contract) {
        contract = {params: [], pre: [], post: [], installed: false};
        contracts.set(key, contract);
    }
    return contract;
}

/**
 * Params are kept ordered by index.
 *
 * **Not necessarily only decorated positions** — that was the invariant until BUG-14's fix, and the
 * reason Q-10 existed. The adapter now also records name/type for *undecorated* positions it can
 * confidently name, so `params` describes the method's real signature rather than only the subset
 * carrying constraints. A constraint-free entry is meaningful data (an OpenAPI emitter needs the
 * parameter to exist before it can say it is unconstrained), and a projection reading `constraints`
 * sees an empty array exactly as it would for a position it never knew about.
 */
function parameterEntry(contract: MutableMethodContract, index: number): MutableParameterContract {
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `ContractRegistry: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }
    for (const existing of contract.params) {
        if (existing.index === index) return existing;
    }
    const entry: MutableParameterContract = {index, constraints: []};
    contract.params.push(entry);
    contract.params.sort((a, b) => a.index - b.index);
    return entry;
}

/**
 * The stored entry for one parameter position, or `undefined` if this contract does not describe it.
 * A read-only counterpart to {@link parameterEntry}, which creates.
 */
function findParameterEntry(
    contract: MutableMethodContract,
    index: number,
): MutableParameterContract | undefined {
    for (const parameter of contract.params) {
        if (parameter.index === index) return parameter;
    }
    return undefined;
}

function fieldEntry(target: ContractTarget, key: FieldKey): MutableFieldContract {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let fields = fieldsByTarget.get(target);
    if (!fields) {
        fields = new Map<FieldKey, MutableFieldContract>();
        fieldsByTarget.set(target, fields);
    }
    let contract = fields.get(key);
    if (!contract) {
        contract = {constraints: [], installed: false};
        fields.set(key, contract);
    }
    return contract;
}
