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

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Authoritative per-target store. Lookup only — a WeakMap cannot be enumerated (DEC-011). */
let contractsByTarget = new WeakMap<ContractTarget, Map<MethodKey, MutableMethodContract>>();

/** Companion enumerable store. Strong references; see the header note. */
let contractedClasses = new Set<Function>();

let classEnumerationEnabled = true;

const EMPTY_CONTRACTS: ReadonlyMap<MethodKey, MethodContract> =
    new Map<MethodKey, MethodContract>();

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
 * recording because these arrive from different places (P1.5) and either may be absent.
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
 */
export function resetRegistry(): void {
    contractsByTarget = new WeakMap<ContractTarget, Map<MethodKey, MutableMethodContract>>();
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

/** Params are kept dense and ordered by index; only decorated positions get an entry. */
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
