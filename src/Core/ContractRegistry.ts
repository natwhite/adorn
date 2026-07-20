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
 * ## Own-property scoping
 *
 * Lookups are keyed by the exact object passed in and never walk the prototype chain. A subclass
 * therefore starts with an empty contract rather than finding — and mutating — its parent's, which
 * is the inheritance bug in the current parameter factory (plan P1.6).
 *
 * ## Semver note (ISSUES.md Q-6)
 *
 * The read API below becomes semver-relevant the moment a projection binds to it. It was internal
 * plumbing before; it is a published surface now.
 */

import {ConstraintDescriptor} from './Descriptor';

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

/** Companion enumerable store. Strong references; see the header note. */
let contractedClasses = new Set<Function>();

let classEnumerationEnabled = true;

const EMPTY_CONTRACTS: ReadonlyMap<MethodKey, MethodContract> =
    new Map<MethodKey, MethodContract>();

const EMPTY_FIELD_CONTRACTS: ReadonlyMap<FieldKey, FieldContract> =
    new Map<FieldKey, FieldContract>();

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
 * Ordering is deterministic — instance methods first, then statics, each in registry insertion
 * order — so a regenerated artifact does not produce spurious diffs.
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
        getContracts(prototype).forEach((contract, key) => {
            entries.push({key, contract, isStatic: false, target: prototype});
        });
    }

    getContracts(constructor).forEach((contract, key) => {
        entries.push({key, contract, isStatic: true, target: constructor});
    });

    return entries;
}

// --- field band reads (GAP-9) ----------------------------------------------

/**
 * Field contracts recorded directly on `target`. Own-scoped exactly as {@link getContracts} is: a
 * subclass prototype returns only what was declared on it, never its parent's.
 *
 * Whether a subclass redeclaring a decorated field should *inherit*, be permitted to *strengthen*,
 * or be forbidden from *weakening* its parent's field precondition is a Design-by-Contract / Liskov
 * question (**Q-14**) and is deliberately not answered here. Own-scoping is the status quo this
 * band inherited from the adapter store it replaced, not a ruling.
 */
export function getFieldContracts(target: ContractTarget): ReadonlyMap<FieldKey, FieldContract> {
    if (!isRegisterableTarget(target)) return EMPTY_FIELD_CONTRACTS;
    const fields = fieldsByTarget.get(target);
    return fields ? fields : EMPTY_FIELD_CONTRACTS;
}

/** The contract for one field on `target`, or `undefined` if it has none. */
export function getFieldContract(target: ContractTarget, key: FieldKey): FieldContract | undefined {
    if (!isRegisterableTarget(target)) return undefined;
    const fields = fieldsByTarget.get(target);
    return fields ? fields.get(key) : undefined;
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
 * Every field contract on a class, from **both** key bands — the field-band twin of
 * {@link getContractsForClass}, and for the same reason (DEC-018).
 *
 * A static field's constraints are recorded against the constructor, an instance field's against the
 * prototype, and a projection that walks only one silently emits an artifact missing half the
 * contracts. That rule lives here once.
 *
 * Ordering is deterministic — instance fields first, then statics, each in registry insertion order.
 */
export function getFieldContractsForClass(constructor: Function): ClassFieldContract[] {
    if (typeof constructor !== 'function') {
        throw new TypeError('getFieldContractsForClass: expected a constructor function');
    }

    const entries: ClassFieldContract[] = [];

    const prototype = constructor.prototype;
    if (prototype) {
        getFieldContracts(prototype).forEach((contract, key) => {
            entries.push({key, contract, isStatic: false, target: prototype});
        });
    }

    getFieldContracts(constructor).forEach((contract, key) => {
        entries.push({key, contract, isStatic: true, target: constructor});
    });

    return entries;
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
export function setFieldMetadata(
    target: ContractTarget,
    key: FieldKey,
    metadata: {type?: Function},
): void {
    const entry = fieldEntry(target, key);
    if (metadata.type !== undefined) entry.type = metadata.type;
}

/** Mark a field as carrying an installed validating accessor. */
export function markFieldInstalled(target: ContractTarget, key: FieldKey): void {
    fieldEntry(target, key).installed = true;
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
    contractedClasses = new Set<Function>();
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
        throw new TypeError(`ContractRegistry: parameter index must be a non-negative integer, received ${String(index)}`);
    }
    for (const existing of contract.params) {
        if (existing.index === index) return existing;
    }
    const entry: MutableParameterContract = {index, constraints: []};
    contract.params.push(entry);
    contract.params.sort((a, b) => a.index - b.index);
    return entry;
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
