/**
 * P2.1 — the field decorator factory (SMELL-5, and the fix for BUG-1).
 *
 * ## What was broken
 *
 * `Enforce.generator` defined this, on the **prototype**:
 *
 * ```ts
 * Object.defineProperty(target, key, {configurable: false, set: v => func(v, key, target)});
 * ```
 *
 * Three defects in one line. There is no `get`, so every read of a decorated field returned
 * `undefined`. The setter never stored the value anywhere, so there was nothing to read even if a
 * getter had existed. And `configurable: false` on a prototype accessor meant the state was shared
 * across instances *and* a second decorator on the same field threw. A decorated field validated on
 * assignment and was then permanently `undefined`. `a2ddc5f` (DEC-002) fixed only the argument
 * wiring — which value reached the validator — and left the storage defect untouched.
 *
 * ## Storage: a per-instance own accessor, not a side table
 *
 * The prototype accessor is a **trampoline**. Its setter validates, then defines an *own*
 * enumerable accessor on the receiving instance that closes over a private slot. Every subsequent
 * read and write on that instance hits the own accessor; the prototype one is only ever entered
 * once per instance per field.
 *
 * The plan (P2.1) offered two options — a module-level `WeakMap<instance, Map<key, value>>` side
 * table, or a `Symbol`-keyed own property. Both were rejected in favour of the trampoline, for a
 * reason that only shows up when you look at what the instance looks like *from the outside*:
 *
 * ```
 *                        Object.keys      JSON.stringify              {...spread}
 *   WeakMap side table   []               {}                          {}
 *   own accessor         ["count"]        {"count":42,"name":"a"}     {"count":42,"name":"a"}
 * ```
 *
 * `JSON.stringify` and `Object.keys` walk **own enumerable** properties. A prototype accessor is not
 * an own property, so with a side table every contracted field silently vanishes from serialisation
 * — on exactly the DTO-shaped classes this decorator is for. That is a worse bug than the one being
 * fixed, because BUG-1 at least reads back a conspicuous `undefined`. An own *enumerable accessor*
 * is included by `JSON.stringify` (it invokes the getter), so the trampoline keeps a decorated field
 * observationally identical to an undecorated one.
 *
 * The own property must stay an **accessor**, never a plain data property: a data property would
 * shadow the prototype setter and every assignment after the first would skip validation entirely.
 *
 * ## Garbage collection
 *
 * There is **no side table**, so there is no GC question to answer. The value lives in a closure
 * reachable only from the instance's own accessor, which means it is collected exactly when the
 * instance is — no ephemeron reasoning, no strong-reference registry to explain away, and nothing
 * like the `Set<Function>` trade DEC-011 had to accept. The only module-level state here is keyed by
 * *prototype* (`WeakMap`, so a discarded class is still collectable) and holds constraint
 * descriptors, which are per-class and bounded by the source code, not by instance count.
 *
 * ## Constraints are descriptors, not closures (DEC-006 / DEC-010)
 *
 * A field constraint is a `ConstraintDescriptor` from `src/Contracts/` — the same reified data the
 * parameter path records. Identity and params are therefore available to projections, and the
 * predicate is *derived* from the params so the two cannot drift (Q-4). There is deliberately **no**
 * `CreateSimpleFieldDecorator` closure escape hatch: SMELL-14 documents what that costs on the
 * parameter side (constraints that are enforced but invisible to every projection), and there is no
 * existing public closure surface for fields to keep working — `Enforce.generator` was `private`.
 * Starting descriptor-only means the field band has no SMELL-14 to pay off later.
 *
 * ## Recording and installation are separate — but installation is eager here, deliberately
 *
 * P1.3/P1.4 moved *method* installation out of the decorator and into `@Contract()`, because a
 * parameter decorator's return value is ignored by the language and the imperative assignment it
 * used instead was clobbered by `__decorate`'s trailing write — which is what the
 * `Object.defineProperty` monkey-patch existed to suppress (DEC-005).
 *
 * **Neither half of that applies to a field**, and both halves were re-verified against the
 * TypeScript 6.0.3 emitter rather than assumed:
 *
 * 1. *There is no trailing write to lose to.* A field is emitted as a four-argument call with
 *    `desc === void 0`, not `null`:
 *
 *    ```js
 *    __decorate([Enforce.positive()], Widget.prototype, "count", void 0);
 *    ```
 *
 *    so `r` starts `undefined`, and a decorator returning nothing leaves it `undefined` — making
 *    `c > 3 && r && Object.defineProperty(target, key, r)` a no-op. Confirmed on both the tslib loop
 *    branch and the `Reflect.decorate` branch. (ISSUES.md BUG-2 records the same observation from
 *    the other direction.)
 * 2. *The P1.2 "return a descriptor" mechanism is not available to a field.* Returning one does work
 *    at runtime, but TypeScript rejects it at compile time — **TS1271: "Decorator function return
 *    type is 'PropertyDescriptor' but is expected to be 'void' or 'any'"** — so every field
 *    decorator in the public API would have to launder its return type through `any` to rely on
 *    behaviour the language explicitly declines to sanction.
 *
 * A property decorator's only sanctioned effect *is* `defineProperty` on the target. So the
 * separation P1.4 cares about is preserved **structurally** rather than temporally:
 * {@link recordFieldConstraint} and {@link installFieldContract} are independent, the constraint
 * store is the single source between them, and installation is idempotent. The legacy adapter drives
 * both because it has no later hook; a standard-decorator adapter (DEC-003) would record at
 * decoration time and install from `context.addInitializer` without this module changing.
 *
 * {@link installFieldContracts} is the class-level seam, so `@Contract()` can drive installation
 * instead — it is a no-op against anything already installed.
 *
 * ## Layering
 *
 * Adapter-side, like `MethodDecoratorFactory`: this module touches `target` and property keys, so it
 * is not part of the decorator-agnostic core (DEC-012, GAP-8). It knows nothing about *which*
 * constraints exist — those arrive as descriptors.
 *
 * ## The store now lives in `ContractRegistry` (GAP-9)
 *
 * It used to be adapter-local, because `ContractRegistry` modelled only a `MethodContract` —
 * parameters, `pre`, `post` — and `recordParameterConstraint` was its only constraint writer. The
 * cost of that was stated at the time and was real: **field contracts were invisible to every
 * projection**, so `@Enforce.positive()` was enforced at runtime and absent from any generated
 * document. Same shape as BUG-14, same failure DEC-016 rejects — an artifact that looks complete.
 *
 * The registry now has a field band, and the store moved into it. What stayed here is exactly what
 * should: the trampoline, the seed rescue, the `__decorate` ordering knowledge (`'prepend'`), and the
 * `design:type` read. The registry learned about *fields*, not about decorators (DEC-012).
 *
 * `@Enforce.positive()` is consequently now visible to `getFieldContractsForClass`.
 *
 * ## Installation enumerates the class (BUG-16 — DEC-016 extended to fields)
 *
 * Being *in* the registry was not sufficient. `getContractedClasses()` — what `documentContracts()`
 * and `generateMarkdown()` walk — is fed by `registerContractedClass`, whose only callers were
 * `@Contract()` and `@Validate()`. A class whose only contracts were fields was therefore enforced at
 * runtime and **absent from every generated artifact**: `documentClass(Ctor)` rendered it perfectly,
 * which is exactly what kept the gap hidden. {@link installFieldContract} now registers its owning
 * class, so DEC-016's rule reads the same in both bands — *any installation implies enumeration*.
 *
 * ## A subclass may strengthen an inherited field contract, never weaken it (DEC-021 / Q-14)
 *
 * Enforcement resolves constraints along the **prototype chain**, not from the redeclaring class
 * alone. Storage stays own-scoped — a declaration is only ever written to the object it was written
 * on — so a subclass can add conjuncts to its own list and has no API by which to reach an
 * ancestor's. Weakening is not detected and rejected; it is unexpressible. The reasoning for why this
 * is the *opposite* of Meyer's contravariant precondition rule, and nonetheless correct, is recorded
 * in DEC-021: a field constraint is a class invariant, not a precondition.
 */

import {ConstraintDescriptor} from './Descriptor';
import {DecoratorFactory} from './common';
import {
    FieldContract,
    getEffectiveFieldConstraints as registryEffectiveFieldConstraints,
    getFieldContract,
    getFieldContracts as registryFieldContracts,
    markFieldInstalled,
    recordFieldConstraint as registryRecordFieldConstraint,
    registerContractedClass,
    setFieldMetadata,
} from './ContractRegistry';

/** A field name. Symbols are supported because a class may declare `[sym] = value`. */
export type FieldKey = string | symbol;

/**
 * The legacy property-decorator signature.
 *
 * Returns `void`, not a descriptor — see TS1271 in the module note. Installation happens as a side
 * effect on `target`, which is the only effect the language allows a property decorator to have.
 */
export type AdornFieldDecoratorFn = (target: object, propertyKey: FieldKey) => void;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/*
 * The constraint store used to live here, as a `WeakMap<object, Map<FieldKey, ConstraintDescriptor[]>>`
 * shaped so it could move into `ContractRegistry` unchanged once a field band existed. **GAP-9 built
 * that band, and this is the move.** Everything below now reads and writes
 * `ContractRegistry`'s field contracts, so `@Enforce.positive()` is data a projection can see rather
 * than something only this module knows.
 *
 * The layering is unchanged by the move — DEC-012 is about the registry not learning about
 * decorators, and it has not: `recordFieldConstraint(target, key, descriptor, position)` takes a
 * prototype-or-constructor and a descriptor. Knowledge of `__decorate`'s back-to-front application
 * stays here, in the `'prepend'` this module passes (DEC-015/DEC-017).
 */

/** Which `(target, key)` pairs already carry a trampoline. Makes installation idempotent. */
const installedByTarget = new WeakMap<object, Set<FieldKey>>();

/**
 * Brand marking an accessor function as one adorn installed (BUG-17).
 *
 * `installFieldContract` has to tell *its own* accessor apart from a user's `get`/`set` member: the
 * first is a value to rescue and re-wrap, the second is something it must refuse to contract. A
 * `Symbol` on the function is used rather than matching on `fn.name`, because names are not a
 * contract — a minifier rewrites `adornFieldGet` to a single letter, and the two cases would become
 * indistinguishable exactly where the failure is silent.
 */
const ADORN_ACCESSOR = Symbol('adorn.fieldAccessor');

/** Tag both halves of an accessor pair as adorn's, and return the descriptor for defining. */
function brand<T extends {get?: Function; set?: Function}>(descriptor: T): T {
    if (descriptor.get) (descriptor.get as any)[ADORN_ACCESSOR] = true;
    if (descriptor.set) (descriptor.set as any)[ADORN_ACCESSOR] = true;
    return descriptor;
}

/** Whether an existing property descriptor is an accessor pair adorn installed. */
function isAdornAccessor(descriptor: PropertyDescriptor): boolean {
    return typeof descriptor.get === 'function' && (descriptor.get as any)[ADORN_ACCESSOR] === true;
}

/**
 * Values that were already sitting on the target when the trampoline was installed — the **static
 * field** path, and only that path.
 *
 * TypeScript emits a static initializer as a plain assignment *before* the decorator call:
 *
 * ```js
 * class Config { }
 * Config.limit = 10;                                  // <- runs first
 * __decorate([Enforce.positive()], Config, "limit", void 0);
 * ```
 *
 * so by the time the decorator runs, `Config.limit` is an own data property holding `10`. Installing
 * the accessor over it without rescuing that value would read back `undefined` — which is BUG-1
 * reintroduced for statics. Instance fields have no such property (their initializer runs in the
 * constructor, long after decoration), so this map stays empty for them.
 */
const seedsByTarget = new WeakMap<object, Map<FieldKey, unknown>>();

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record a constraint against a field. Appends in **declaration order**.
 *
 * `__decorate` applies its decorator array back-to-front, so stacked decorators arrive here bottom
 * to top — the same emitter-ordering leak SMELL-11 found on the parameter side. Recording with
 * `unshift` rather than `push` normalises it at the point of entry, so the stored array is already
 * in the order a reader of the source sees. Enforcement therefore reports the first violated
 * constraint a reader would expect, and any projection reading this array lists constraints in the
 * same order enforcement applies them — which is the discrepancy SMELL-13 still has open for
 * parameters, and which the field band simply never acquires.
 *
 * Knowledge of `__decorate`'s application order stays here, in the adapter, which is the only layer
 * entitled to it (DEC-015).
 */
export function recordFieldConstraint(target: object, key: FieldKey, constraint: ConstraintDescriptor): void {
    assertTarget(target, 'recordFieldConstraint');
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'recordFieldConstraint: expected a ConstraintDescriptor built by defineConstraint(). ' +
                'A bare closure carries no identity and no params, so nothing could be projected from it ' +
                '(DEC-006).',
        );
    }

    // `'prepend'` is this adapter's declaration-order normalisation; the registry itself has no
    // opinion about `__decorate` and takes `'append'` by default.
    registryRecordFieldConstraint(target, key, constraint, 'prepend');
}

// ---------------------------------------------------------------------------
// Reads — the introspection surface a projection would consume
// ---------------------------------------------------------------------------

const NO_CONSTRAINTS: ReadonlyArray<ConstraintDescriptor> = Object.freeze([]);

/**
 * Constraints declared **directly** on `target[key]`, in declaration order.
 *
 * Own-scoped: a subclass prototype returns only what was written on it, not what it inherits.
 *
 * **This is no longer what enforcement applies.** Since DEC-021 a field is checked against the union
 * of every declaration on its prototype chain — {@link getEffectiveFieldConstraints}. This read is
 * kept because "declared on this class" is a real and separate question (a document distinguishing
 * a subclass's own additions from what it inherits needs exactly this), but reading it and assuming
 * it describes runtime behaviour is now a mistake, so the two names say which is which.
 */
export function getFieldConstraints(target: object, key: FieldKey): ReadonlyArray<ConstraintDescriptor> {
    if (!isTarget(target)) return NO_CONSTRAINTS;
    const contract = getFieldContract(target, key);
    return contract ? contract.constraints : NO_CONSTRAINTS;
}

/**
 * Every constraint **in force** on `target[key]` — the subclass's own plus every one it inherits,
 * base-most class first (DEC-021, Q-14).
 *
 * This is what {@link assertFieldValue} checks, so it is the honest answer to "what will this field
 * reject?". The union is the whole of the strengthen-only rule: see
 * `ContractRegistry.getEffectiveFieldConstraints` for why weakening is unexpressible rather than
 * rejected.
 */
export function getEffectiveFieldConstraints(
    target: object,
    key: FieldKey,
): ReadonlyArray<ConstraintDescriptor> {
    if (!isTarget(target)) return NO_CONSTRAINTS;
    return registryEffectiveFieldConstraints(target, key);
}

/**
 * Every contracted field on `target`. Empty map rather than `undefined`, so callers can iterate.
 *
 * Now the registry's map of `FieldContract` (constraints + reflected type + installed flag) rather
 * than this module's old bare `ConstraintDescriptor[]`, since the store moved (GAP-9).
 */
export function getFieldContracts(target: object): ReadonlyMap<FieldKey, FieldContract> {
    // The registry applies the same target guard, so a non-object simply reads back empty.
    return registryFieldContracts(target);
}

/** Field keys carrying constraints on `target`. Complements `getFieldContracts`. */
export function getFieldKeys(target: object): FieldKey[] {
    const keys: FieldKey[] = [];
    getFieldContracts(target).forEach((_constraints, key) => keys.push(key));
    return keys;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Install the trampoline accessor for one field. Idempotent — a second call is a no-op, so stacking
 * decorators on a field installs once and `@Contract()` may safely re-drive it afterwards.
 *
 * Defines an **own** property on `target`. When `target` is a subclass prototype that redeclares a
 * decorated field, the subclass accessor shadows the parent's — but it does **not** shadow the
 * parent's *contract*: enforcement resolves constraints along the whole prototype chain, so the
 * subclass adds to what it inherits and cannot drop it (DEC-021, Q-14). Shadowing the accessor is
 * merely how the interception is wired; the contract is resolved separately, at check time.
 *
 * ## It enumerates the owning class (BUG-16, DEC-016 extended to fields)
 *
 * Installing here is exactly the moment DEC-016 calls "installation", so it is the moment the class
 * becomes visible to `getContractedClasses()` — and with it to `documentContracts()` and every later
 * projection. Before this, field decorators installed enforcement and registered nothing, so a class
 * whose *only* contracts were fields was **enforced at runtime and absent from every generated
 * artifact**. Nothing threw and the document looked complete, which DEC-016 identifies as strictly
 * the worse of the two failure directions. `documentClass(Ctor)` reported such a class perfectly,
 * which is what kept it hidden.
 */
export function installFieldContract(target: object, key: FieldKey): void {
    assertTarget(target, 'installFieldContract');
    registerOwningClass(target);
    if (isInstalled(target, key)) return;

    const existing = Object.getOwnPropertyDescriptor(target, key);
    if (existing && existing.configurable === false) {
        throw new TypeError(
            `adorn: cannot contract ${describeField(target, key)} — the property is already defined and ` +
                'is non-configurable, so it cannot be replaced with a validating accessor.',
        );
    }
    if (existing && isAdornAccessor(existing)) {
        // **Adorn's own accessor, materialised here by an inherited write — BUG-17.**
        //
        // A subclass redeclaring a decorated `static` field hits this every time. TypeScript emits
        // the static initializer as a plain assignment *before* the decorator call:
        //
        //     class Sub extends Base { @Enforce.lessThanEqual(100) static limit = 50; }
        //     // → Sub.limit = 50;  then  __decorate([...], Sub, "limit", void 0);
        //
        // and `Sub.limit = 50` resolves up the constructor chain to `Base`'s accessor, whose setter
        // gives the receiver its own slot (so a subclass assignment does not write through to the
        // parent — see `defineInstanceSlot`). By the time the decorator runs, `Sub` therefore carries
        // an own *accessor*, and the foreign-accessor guard below rejected it with a message about
        // getters and setters that described nothing the author had written. A subclass strengthening
        // an inherited static field — the static half of DEC-021 — was simply unavailable.
        //
        // The value is rescued through the getter and re-seeded, exactly as a plain static
        // initializer is, so it is re-validated against the constraint list this class ends up with.
        rememberSeed(target, key, (existing.get as () => unknown).call(target));
    } else if (existing && (typeof existing.get === 'function' || typeof existing.set === 'function')) {
        // A *user's* `get`/`set` member is emitted as a method-shaped `__decorate` call
        // (`desc === null`), whose trailing write restores the original descriptor — so installing
        // here would be silently undone. Fail loudly rather than pretend to contract something.
        throw new TypeError(
            `adorn: ${describeField(target, key)} is a getter/setter, not a field. A field decorator ` +
                'cannot contract an accessor; put the check inside the setter, or contract the backing ' +
                'field instead.',
        );
    } else if (existing && 'value' in existing) {
        rememberSeed(target, key, existing.value);
    }

    Object.defineProperty(
        target,
        key,
        brand({
            configurable: true,
            // Non-enumerable on the prototype so `for...in` over an instance does not report the field
            // before anything has been assigned to it. An undecorated field with no initializer does not
            // exist until written either; the trampoline should not change that.
            enumerable: false,

            // Reached only before the first assignment to a given instance. An undecorated field with no
            // initializer reads `undefined`, so this does too.
            get: function adornFieldTrampolineGet(): unknown {
                return undefined;
            },

            set: function adornFieldTrampolineSet(this: object, value: unknown): void {
                assertFieldValue(target, key, value, adornFieldTrampolineSet);
                defineInstanceSlot(this, target, key, value);
            },
        }),
    );

    markInstalled(target, key);
    // The registry's own flag, so a projection can tell a recorded-but-unenforced field from an
    // enforced one — the same distinction `MethodContract.installed` carries. Only set when the
    // registry already holds the field, so installing over a field with no recorded constraints
    // cannot conjure an empty contract into a generated document.
    if (getFieldContract(target, key)) markFieldInstalled(target, key);
    applySeed(target, key);
}

/**
 * Push a rescued static initializer through the accessor, validating it against everything recorded
 * so far.
 *
 * Called again after each subsequent decorator on the same field, because installation is idempotent
 * but the constraint list is not final until every stacked decorator has run. With
 * `@Enforce.greaterThanEqual(10) @Enforce.lessThanEqual(100) static limit = 5`, `__decorate` applies
 * bottom-up: `lessThanEqual` installs and seeds (5 passes), and only then does `greaterThanEqual`
 * record. Without this second pass the initializer would escape the constraint declared above it.
 *
 * Throwing here surfaces an invalid static initializer at class-evaluation time, which is the
 * earliest moment it can be known.
 */
function applySeed(target: object, key: FieldKey): void {
    const seeds = seedsByTarget.get(target);
    if (!seeds || !seeds.has(key)) return;

    const value = seeds.get(key);
    assertFieldValue(target, key, value, applySeed);
    defineInstanceSlot(target, target, key, value);
}

function rememberSeed(target: object, key: FieldKey, value: unknown): void {
    let seeds = seedsByTarget.get(target);
    if (!seeds) {
        seeds = new Map<FieldKey, unknown>();
        seedsByTarget.set(target, seeds);
    }
    seeds.set(key, value);
}

/**
 * Install every field contract recorded for a class — statics on the constructor, instance fields on
 * the prototype.
 *
 * The imperative/class-level seam, mirroring `installContracts` in `ContractInstaller`. Provided so
 * `@Contract()` can drive field installation the way it drives method installation; because it is
 * idempotent, wiring it in later cannot double-install over what the decorators already did.
 */
export function installFieldContracts(constructor: Function): void {
    if (typeof constructor !== 'function') {
        throw new TypeError('installFieldContracts: expected a constructor function');
    }
    // Unconditional, matching `installContracts`: a class-level install marks intent to be visible,
    // and a class whose constraints have not been recorded yet should not vanish from documentation
    // for it (DEC-016).
    registerContractedClass(constructor);
    installAllOn(constructor);
    if (constructor.prototype) installAllOn(constructor.prototype);
}

function installAllOn(host: object): void {
    getFieldKeys(host).forEach(key => installFieldContract(host, key));
}

// ---------------------------------------------------------------------------
// Authoring surface
// ---------------------------------------------------------------------------

/**
 * Build a field decorator from a reified {@link ConstraintDescriptor}.
 *
 * ```ts
 * class Widget {
 *     @CreateFieldDecorator(GreaterThan(0))
 *     count: number = 0;
 * }
 * ```
 *
 * Records the constraint, then installs. Both steps are separately callable — see the module note on
 * why the legacy adapter runs them together.
 */
export function CreateFieldDecorator(constraint: ConstraintDescriptor): AdornFieldDecoratorFn {
    if (!constraint || typeof constraint.predicate !== 'function') {
        throw new TypeError(
            'CreateFieldDecorator: expected a ConstraintDescriptor built by defineConstraint() — ' +
                'e.g. GreaterThan(0) from src/Contracts/number.',
        );
    }

    return function (target: object, propertyKey: FieldKey): void {
        recordFieldConstraint(target, propertyKey, constraint);
        captureFieldType(target, propertyKey);
        installFieldContract(target, propertyKey);
        // Installation is idempotent, so a second decorator on the same field does not re-run it —
        // but it *has* changed the constraint list, and a rescued static initializer must be
        // re-checked against the new one. No-op for instance fields, which never have a seed.
        applySeed(target, propertyKey);
    };
}

/**
 * Record `design:type` for a field, when the toolchain emitted one.
 *
 * The field-band counterpart of the parameter path's `design:paramtypes` read, and adapter-only for
 * the same reason (DEC-012): `Reflect.getMetadata` and the legacy `emitDecoratorMetadata` protocol
 * stop here.
 *
 * Unavailable under a transpile-only toolchain — esbuild ignores `emitDecoratorMetadata` permanently
 * (DEC-004) — and unavailable without `reflect-metadata`, which adorn does not require. In either
 * case nothing is recorded and a generated document shows no type, rather than a type inferred from
 * whatever value happened to be assigned first.
 */
function captureFieldType(target: object, key: FieldKey): void {
    const reflect: any = typeof Reflect === 'object' ? Reflect : undefined;
    if (!reflect || typeof reflect.getMetadata !== 'function') return;

    let type: unknown;
    try {
        type = reflect.getMetadata('design:type', target, key);
    } catch (error) {
        return;
    }

    if (typeof type === 'function') setFieldMetadata(target, key, {type: type as Function});
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Give the instance its own validating accessor over a closure slot.
 *
 * `owner` is the target the contract was recorded against, not `this` — so validation stays bound to
 * the class that declared the field even if the instance is later re-prototyped, and so a static
 * field (where `this` *is* the target) resolves its constraints identically.
 *
 * The replacement is an accessor rather than a data property on purpose: a data property would
 * shadow this setter and silently disable validation from the second assignment onwards.
 */
function defineInstanceSlot(instance: object, owner: object, key: FieldKey, initial: unknown): void {
    if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) {
        // Assignment through a primitive receiver in sloppy mode. Nothing sane to store on; the
        // value was still validated, which is the part that matters.
        return;
    }

    let slot = initial;

    Object.defineProperty(
        instance,
        key,
        brand({
            configurable: true,
            // Own **and enumerable** — this is what keeps JSON.stringify, Object.keys, spread and
            // Object.assign behaving exactly as they do for an undecorated field.
            enumerable: true,
            get: function adornFieldGet(): unknown {
                return slot;
            },
            set: function adornFieldSet(this: object, next: unknown): void {
                assertFieldValue(owner, key, next, adornFieldSet);

                if (this === instance) {
                    slot = next;
                    return;
                }

                // Assignment reached this accessor through the prototype chain — a subclass writing to
                // an inherited *static* field is the realistic case (`Sub.limit = 5` when `limit` is
                // declared on `Base`). Writing `slot` here would silently mutate the parent's value,
                // whereas assigning to an inherited plain data property creates an own property on the
                // receiver. Give the receiver its own slot so the two behave the same.
                defineInstanceSlot(this, owner, key, next);
            },
        }),
    );
}

/**
 * Run every constraint recorded for the field, in declaration order, and throw on the first failure.
 *
 * On failure the previously stored value is left untouched: the throw happens before `slot` is
 * reassigned (and before the slot exists at all, on a first assignment).
 *
 * `boundary` is the accessor being executed. `attributeToCaller` cuts the stack there, so the trace
 * points at the line that performed the assignment rather than at adorn's internals — the same
 * frame-boundary technique the parameter path uses (SMELL-2), with no frame counting.
 */
function assertFieldValue(owner: object, key: FieldKey, value: unknown, boundary: Function): void {
    // **Effective**, not own-scoped (DEC-021). `owner` is the object the reached trampoline was
    // installed on, so when a subclass redeclares a decorated field this resolves that subclass's
    // constraints *and* every ancestor's — which is what makes an inherited constraint impossible to
    // shed by redeclaring.
    const constraints = getEffectiveFieldConstraints(owner, key);

    for (let i = 0; i < constraints.length; i++) {
        const constraint = constraints[i];
        if (constraint.predicate(value)) continue;

        const error = new Error(constraint.message({value, signature: describeField(owner, key)}));
        DecoratorFactory.attributeToCaller(error, boundary);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Enumerate the class owning a contracted field (BUG-16).
 *
 * A property decorator is handed the constructor itself for a `static` field and the prototype for
 * an instance field — the same two key bands `getFieldContractsForClass` exists to reconcile. Both
 * resolve to the constructor, which is what `getContractedClasses()` holds.
 *
 * **The prototype-identity check is load-bearing.** `installFieldContract` is a public, imperative
 * entry point, and its target is not always a class: hand it a plain `{}` — as the unit tests and any
 * schema-driven caller do — and `target.constructor` is `Object`. Registering that would put `Object`
 * into the enumerable registry, and every projection would then try to document it. So a non-function
 * target enumerates only when it really is the `prototype` of the constructor it names. A detached
 * `Object.create(proto)` target correctly registers nothing: it is an object with contracted fields,
 * not a class.
 */
function registerOwningClass(target: object): void {
    if (typeof target === 'function') {
        registerContractedClass(target as Function);
        return;
    }

    const constructor = (target as {constructor?: Function}).constructor;
    if (typeof constructor === 'function' && constructor.prototype === target) {
        registerContractedClass(constructor);
    }
}

function isTarget(target: unknown): boolean {
    return target !== null && (typeof target === 'object' || typeof target === 'function');
}

function assertTarget(target: unknown, caller: string): void {
    if (!isTarget(target)) {
        throw new TypeError(`${caller}: target must be a prototype or constructor`);
    }
}

function isInstalled(target: object, key: FieldKey): boolean {
    const keys = installedByTarget.get(target);
    return !!keys && keys.has(key);
}

function markInstalled(target: object, key: FieldKey): void {
    let keys = installedByTarget.get(target);
    if (!keys) {
        keys = new Set<FieldKey>();
        installedByTarget.set(target, keys);
    }
    keys.add(key);
}

/**
 * `Widget.count` — the subject a violation message names.
 *
 * The constructor-vs-prototype split this used to handle inline is BUG-12, and now lives in
 * `getObjectName` where every call site gets it right rather than three of them re-deriving it.
 */
function describeField(target: object, key: FieldKey): string {
    const member = typeof key === 'symbol' ? key.toString() : String(key);
    const owner = DecoratorFactory.getObjectName(target);
    return owner ? `${owner}.${member}` : member;
}
