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
    /** Whether an installer has wrapped this method yet. Drives P1.3's missing-`@Contract()` warning. */
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
 */
export function getContractedClasses(): Function[] {
    const classes: Function[] = [];
    contractedClasses.forEach(entry => classes.push(entry));
    return classes;
}

// ---------------------------------------------------------------------------
// Writes — called by adapters and installers
// ---------------------------------------------------------------------------

/**
 * Record a constraint against a parameter position. Appends; a parameter may carry several
 * constraints, and the same position may be written more than once.
 */
export function recordParameterConstraint(
    target: ContractTarget,
    key: MethodKey,
    index: number,
    constraint: ConstraintDescriptor,
): void {
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'recordParameterConstraint: expected a ConstraintDescriptor. Bare predicates are not ' +
            'accepted — a closure carries no identity or params, so nothing can be projected from it ' +
            '(DEC-006).',
        );
    }
    parameterEntry(methodEntry(target, key), index).constraints.push(constraint);
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
