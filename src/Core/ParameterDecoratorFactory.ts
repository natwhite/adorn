/**
 * P1.3 — parameter decorators **record**; they no longer install.
 *
 * ## What changed and why
 *
 * The previous implementation did everything in the parameter decorator: it stamped
 * `parameterDecorated` / `parameterDecorators` expandos onto the method object, built a wrapper,
 * assigned it with `target[propertyKey] = wrapper`, and then armed a one-shot global patch of
 * `Object.defineProperty` so that `__decorate`'s trailing write would not immediately undo the
 * assignment (DEC-005).
 *
 * That last step is the tell. A parameter decorator's return value is ignored by the language, so
 * it has no legitimate way to change what a method *is* — the patch was the only thing making it
 * appear to work, at the cost of monkey-patching a global.
 *
 * So the responsibility is split:
 *
 * - **here** — record the constraint against `(target, propertyKey, parameterIndex)`;
 * - **`ContractInstaller`** — a class-level `@Contract()` that runs *after* all member decoration
 *   and installs one wrapper per contracted method (P1.3 option A1).
 *
 * Nothing is written to the method object any more, so there is nothing for `__decorate` to clobber
 * and nothing to patch. That is what unblocks P1.4.
 *
 * ## Two recording paths, deliberately
 *
 * - {@link ParameterDecoratorFactory.CreateConstraintDecorator} takes a `ConstraintDescriptor` and
 *   records it in the `ContractRegistry`. This is the path that makes a contract **data** — it is
 *   what documentation, schema, and fuzzing projections read (DEC-006).
 * - {@link ParameterDecoratorFactory.CreateSimpleDecorator} takes a hand-written closure and is
 *   kept because it is the library's existing public authoring surface. A closure carries no
 *   identity and no params, so `ContractRegistry` rejects it by design (bare predicates are refused
 *   there explicitly). It is therefore staged in an adapter-local table instead.
 *
 *   **Consequence, stated rather than hidden:** a `CreateSimpleDecorator` constraint is enforced
 *   exactly as before, but it is *invisible to every projection*. That is not a gap to be plugged
 *   later; it is ISSUES.md Q-3 showing up in the API. Anything that wants to be documented or
 *   fuzzed must be authored as a descriptor.
 *
 * ## Signature capture — BUG-14
 *
 * Install time is also where parameter **names** and **types** are written to the registry. That is
 * not an arbitrary home for it: `planChecks` recovers the names in order to build violation messages,
 * so recording them from the same array is what makes the runtime error and the generated document
 * literally one source rather than two recoveries that happen to agree. Before this, the registry had
 * a writer (`setParameterMetadata`) that nothing in production ever called, so a single declaration
 * produced an error naming `sku` and a document naming `arg0`.
 *
 * See {@link captureSignature} for what is recorded, what is deliberately not guessed when the
 * toolchain supplies no types, and how much of Q-10's arity problem falls out of it.
 *
 * ## Evaluation order — SMELL-11, now settled deliberately
 *
 * `__decorate` applies its decorator array back-to-front, so decorators arrive here in **reverse**
 * declaration order: the last parameter registers first, and stacked decorators on one parameter
 * arrive bottom-up. The old design inherited that ordering implicitly into enforcement, so with
 * several arguments invalid it was the *highest-index* parameter that got reported.
 *
 * Both record sites therefore normalise to **declaration order** as they write — the registry via
 * `recordParameterConstraint(..., 'prepend')`, the staging table via `unshift`. That is the order a
 * reader of the signature expects, and it is the order documentation lists constraints in, so
 * enforcement and projection agree. This is a deliberate behavioural change, not an inherited
 * accident.
 *
 * **SMELL-13, and why normalisation moved from plan time to record time.** P1.3 originally reversed
 * at plan time inside {@link buildParameterEnforcement}, which fixed enforcement but left the stored
 * arrays backwards — so `@GreaterThanEqual(100) @LessThanEqual(1000)` enforced GTE-first while every
 * projection reading the registry documented LTE-first. Normalising as we record fixes both from one
 * place, and `__decorate`'s ordering stays known only to this adapter, exactly as DEC-015 requires.
 */

import {ConstraintDescriptor} from './Descriptor';
import {
    getContract,
    MethodContract,
    MethodKey,
    recordParameterConstraint,
    setParameterMetadata,
} from './ContractRegistry';
import {notePendingContract} from './ContractDiagnostics';
import {DecoratorFactory} from './common';
import {InvocationContext} from './MethodDecoratorFactory';

/**
 * Object handed to a {@link ParamDeco} closure. Unchanged from the original design — this is public
 * authoring surface and the fields are load-bearing for existing error messages.
 */
export interface ParamObject<T> {
    objectName: string;
    funcName: string;
    paramName: string;
    value: T;
    signature: string;
}

/** A hand-written parameter check. Throws to signal a violation. */
export type ParamDeco<T = any> = (params: ParamObject<T>) => void;

/** The legacy-decorator signature, kept exactly as it was so existing call sites still type-check. */
export type AdornParameterDecoratorFn = (target: any, propertyKey: string, parameterIndex: number) => void;

// ---------------------------------------------------------------------------
// Adapter-local staging for hand-written closures
// ---------------------------------------------------------------------------

interface StagedCheck {
    readonly index: number;
    readonly decorator: ParamDeco;
}

interface StagedMethod {
    /** Declaration order — see {@link stageCheck}, which unshifts rather than pushes. */
    readonly checks: StagedCheck[];
    installed: boolean;
}

/**
 * Closures that cannot go in `ContractRegistry`, keyed the same way it is.
 *
 * A `WeakMap` of `Map`s rather than a flat `WeakMap`, because the installer needs to enumerate the
 * *method keys* of one target — which the inner `Map` supports and a `WeakMap` never could.
 */
const stagedByTarget = new WeakMap<object, Map<MethodKey, StagedMethod>>();

// ---------------------------------------------------------------------------
// Authoring surface
// ---------------------------------------------------------------------------

/**
 * Factory for parameter decorators.
 *
 * Retained as a class of statics purely for source compatibility — `CreateSimpleDecorator` is the
 * documented entry point and is referenced from README, tests, and user code.
 */
export class ParameterDecoratorFactory {
    /**
     * Build a parameter decorator from a hand-written check.
     *
     * The check runs on every call, receives a fully populated {@link ParamObject}, and signals a
     * violation by throwing. Behaviourally identical to the previous implementation; the difference
     * is that the constraint is now *recorded* and installed later by `@Contract()`, rather than
     * installing a wrapper on the spot.
     *
     * Prefer {@link CreateConstraintDecorator} for anything that should also be documented or
     * fuzzed — see the module note on why a closure cannot be.
     */
    static CreateSimpleDecorator<T>(decorator: ParamDeco<T>): AdornParameterDecoratorFn {
        if (typeof decorator !== 'function') {
            throw new TypeError('CreateSimpleDecorator: expected a (params: ParamObject) => void function');
        }

        return function (target: any, propertyKey: string, parameterIndex: number) {
            stageCheck(target, propertyKey, parameterIndex, decorator as ParamDeco);
            notePendingContract(target, propertyKey);
        };
    }

    /**
     * Build a parameter decorator from a reified {@link ConstraintDescriptor}.
     *
     * This is the path DEC-006 cares about: the constraint's identity and params land in the
     * `ContractRegistry` as data, so validation, documentation, schema, and fuzzing can all descend
     * from the one declaration.
     */
    static CreateConstraintDecorator(constraint: ConstraintDescriptor): AdornParameterDecoratorFn {
        if (!constraint || typeof constraint.predicate !== 'function') {
            throw new TypeError(
                'CreateConstraintDecorator: expected a ConstraintDescriptor built by defineConstraint(). ' +
                    'Use CreateSimpleDecorator for a hand-written closure.',
            );
        }

        return function (target: any, propertyKey: string, parameterIndex: number) {
            // `'prepend'`, not the default append: decorators stacked on one parameter arrive here
            // bottom-up, so prepending each one lands them in declaration order in the registry.
            // That is SMELL-13 — the registry used to document `@GTE @LTE` as LTE-first while
            // enforcing GTE-first. Recording correctly is why `planChecks` no longer reverses.
            recordParameterConstraint(target, propertyKey, parameterIndex, constraint, 'prepend');
            notePendingContract(target, propertyKey);
        };
    }
}

// ---------------------------------------------------------------------------
// Installer support
// ---------------------------------------------------------------------------

/** Method keys on `target` that carry hand-written checks. Complements `getContracts(target)`. */
export function getStagedMethodKeys(target: object): MethodKey[] {
    const staged = stagedByTarget.get(target);
    if (!staged) return [];
    const keys: MethodKey[] = [];
    staged.forEach((_entry, key) => keys.push(key));
    return keys;
}

/** Mark hand-written checks on `target[propertyKey]` as installed. */
export function markStagedInstalled(target: object, propertyKey: MethodKey): void {
    const staged = stagedByTarget.get(target);
    const entry = staged && staged.get(propertyKey);
    if (entry) entry.installed = true;
}

/**
 * Compile everything recorded for `target[propertyKey]` into a single enforcement function, or
 * `undefined` if nothing was recorded.
 *
 * Everything expensive happens **here, once at install time** — parameter-name recovery (which
 * parses `Function.prototype.toString`), owner-name lookup, and ordering. The returned function
 * does only the per-call work. The old design re-derived none of this per call either, but it did
 * emit `console.debug` on every single invocation (SMELL-3); those diagnostics are gone entirely.
 */
export function buildParameterEnforcement(
    target: object,
    propertyKey: MethodKey,
    original: Function,
): ((context: InvocationContext) => void) | undefined {
    const checks = planChecks(target, propertyKey, original);
    if (checks.length === 0) return undefined;

    return function enforceParameters(context: InvocationContext): void {
        try {
            for (let i = 0; i < checks.length; i++) {
                checks[i](context.args);
            }
        } catch (error) {
            // SMELL-2: cut the trace at the wrapper instead of counting frames, and never touch a
            // value that is not a stack-carrying Error — a thrown string now reaches the caller
            // exactly as thrown rather than being replaced by a TypeError from inside adorn.
            DecoratorFactory.attributeToCaller(error, context.wrapper);
            throw error;
        }
    };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type PlannedCheck = (args: any[]) => void;

function planChecks(target: object, propertyKey: MethodKey, original: Function): PlannedCheck[] {
    const contract = getContract(target, propertyKey);
    const staged = stagedByTarget.get(target);
    const stagedMethod = staged ? staged.get(propertyKey) : undefined;

    const hasDescriptors = !!contract && contract.params.length > 0;
    const hasStaged = !!stagedMethod && stagedMethod.checks.length > 0;
    if (!hasDescriptors && !hasStaged) return [];

    const paramNames: string[] = DecoratorFactory.getParamNames(original);
    const objectName: string = DecoratorFactory.getObjectName(target);
    const funcName: string = original.name;
    const joinedNames = paramNames.join(', ');

    // BUG-14. The names just recovered are about to be baked into every violation message for this
    // method; record them so the registry — and therefore every projection — says the same thing.
    // Done here rather than in the decorator because *this* is the computation the messages use, so
    // there is literally one source rather than two that happen to agree today.
    if (contract) captureSignature(target, propertyKey, contract, paramNames);

    // Built lazily and identically to the previous implementation, so every existing violation
    // message is byte-for-byte unchanged.
    const signatureFor = (index: number) =>
        `${objectName}.${funcName}(${joinedNames}) parameter '${paramNames[index]}'`;

    const paramObjectFor = (index: number, args: any[]): ParamObject<any> => ({
        objectName,
        funcName,
        paramName: paramNames[index],
        value: args[index],
        signature: signatureFor(index),
    });

    // --- declaration order (SMELL-11, SMELL-13) -----------------------------
    //
    // Both stores are now in declaration order *as recorded*, so this loop only has to interleave
    // them by index. It used to `.reverse()` both, because both were in arrival order — which
    // `__decorate`'s back-to-front application makes the reverse of declaration order.
    //
    // Reversing at plan time fixed enforcement but left the registry itself backwards, so a
    // generated document listed stacked constraints in the opposite order to the one enforced
    // (SMELL-13). Recording in the right order instead fixes both at once, and keeps the knowledge
    // of `__decorate`'s ordering where DEC-015 put it — in the adapter, at the two record sites
    // (`CreateConstraintDecorator` prepends; `stageCheck` unshifts) rather than in the core.

    const indices = new Set<number>();
    if (contract) contract.params.forEach(param => indices.add(param.index));
    if (stagedMethod) stagedMethod.checks.forEach(check => indices.add(check.index));

    const ordered = Array.from(indices).sort((a, b) => a - b);
    const plan: PlannedCheck[] = [];

    for (const index of ordered) {
        const parameter = contract && contract.params.filter(p => p.index === index)[0];
        if (parameter) {
            for (const constraint of parameter.constraints) {
                plan.push(descriptorCheck(constraint, index, signatureFor, paramNames));
            }
        }

        if (stagedMethod) {
            const atIndex = stagedMethod.checks.filter(check => check.index === index);
            for (const check of atIndex) {
                plan.push(args => check.decorator(paramObjectFor(index, args)));
            }
        }
    }

    return plan;
}

function descriptorCheck(
    constraint: ConstraintDescriptor,
    index: number,
    signatureFor: (index: number) => string,
    paramNames: string[],
): PlannedCheck {
    return function (args: any[]) {
        const value = args[index];
        if (constraint.predicate(value)) return;
        throw new Error(
            constraint.message({
                value,
                signature: signatureFor(index),
                paramName: paramNames[index],
            }),
        );
    };
}

// ---------------------------------------------------------------------------
// Signature capture — BUG-14, and as much of Q-10 as honestly falls out
// ---------------------------------------------------------------------------

const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Whether the recovered name list can be trusted as *the method's signature*, as opposed to merely
 * as the strings enforcement will quote.
 *
 * `getParamNames` regex-parses `Function.prototype.toString`, and that parse does not survive
 * destructuring or rest syntax: `test({a, b})` yields `['{a', 'b}']` — two "names" for one parameter,
 * and `test(a, ...rest)` yields a position that is not a fixed slot at all. Under either, the *count*
 * is wrong even though the individual strings may look fine.
 *
 * So the two uses are separated. Recording a name onto an **already-decorated** position is always
 * right: enforcement is quoting that identical string, so the registry and the violation message
 * continue to agree — which is the property BUG-14 is about, and it holds whether or not the string
 * is a good name. **Inventing a new position** is only right when the whole parse is coherent;
 * otherwise the registry would gain a parameter that exists nowhere and that no enforcement path
 * would ever contradict. One bad entry disqualifies the list, not just itself.
 */
function isTrustworthySignature(paramNames: string[]): boolean {
    if (paramNames.length === 0) return false;
    return paramNames.every(name => PLAIN_IDENTIFIER.test(name));
}

/**
 * Record real parameter names and reflected types against `target[propertyKey]`.
 *
 * ## Names (BUG-14)
 *
 * `paramNames` is the array the violation messages are built from, a few lines up. Writing it here
 * is what makes "one declaration, four artifacts" true for names: the error saying `parameter 'sku'`
 * and the document saying `sku` are now the same string, not two independent recoveries that agree
 * by luck. It carries SMELL-1's minification caveat along with it — but *consistently*, which is the
 * property that matters. A document that says `arg0` about a check that says `sku` is worse than one
 * that says `s` about a check that says `s`.
 *
 * ## Types
 *
 * `design:paramtypes` fills the documentation's Type column. It is available only when
 * `emitDecoratorMetadata` is on **and** `reflect-metadata` is loaded; esbuild ignores the former
 * permanently (DEC-004) and Babel drops legacy parameter decorators outright. When it is unavailable
 * the field is simply left unset — the doc renders `—`. Nothing is guessed from the runtime value,
 * because a type inferred from one observed argument would be a claim the compiler never made.
 *
 * ## Arity (Q-10)
 *
 * `getParamNames` returns *every* declared parameter, not only the decorated ones, so positions with
 * no constraints get an entry too. That is what lets a signature render as `Task.send(sku, count)`
 * rather than `Task.send(arg0, ...)` with the trailing parameter missing entirely. It is deliberately
 * limited to what the name parse can vouch for — see {@link PLAIN_IDENTIFIER} — so the registry never
 * gains a position that does not exist.
 */
function captureSignature(
    target: object,
    propertyKey: MethodKey,
    contract: MethodContract,
    paramNames: string[],
): void {
    const types = designParamTypes(target, propertyKey);
    const trustworthy = isTrustworthySignature(paramNames);

    const decorated = new Set<number>();
    let highestDecorated = -1;
    contract.params.forEach(parameter => {
        decorated.add(parameter.index);
        if (parameter.index > highestDecorated) highestDecorated = parameter.index;
    });

    // Cover every position either source knows about: the parsed signature, and any decorated index
    // beyond it (which happens when the name parse fails but the decorator did not).
    const limit = Math.max(paramNames.length, highestDecorated + 1);

    for (let index = 0; index < limit; index++) {
        // Never create a position the parse cannot vouch for; always keep an existing one in sync.
        if (!decorated.has(index) && !trustworthy) continue;

        const name = paramNames[index];
        const type = types && types[index];
        setParameterMetadata(target, propertyKey, index, {
            name: typeof name === 'string' ? name : undefined,
            type: typeof type === 'function' ? type : undefined,
        });
    }
}

/**
 * `design:paramtypes` for `target[propertyKey]`, or `undefined` when the toolchain did not emit it.
 *
 * Everything about this read is adapter knowledge — `Reflect.getMetadata`, `target`, `propertyKey`,
 * and the legacy `emitDecoratorMetadata` protocol all stop at this layer, so `ContractRegistry` and
 * the projections stay decorator-agnostic (DEC-012). A standard-decorator adapter has no equivalent
 * to read (nothing in the TC39 model emits design-time types) and simply records no type.
 *
 * Feature-detected rather than assumed: `reflect-metadata` is what makes `__metadata` store anything,
 * and adorn does not require it. `getMetadata` — not `getOwnMetadata` — because a contract may be
 * installed against a subclass whose method is inherited, in which case the base's metadata is the
 * honest answer and matches the function the names were parsed from.
 */
function designParamTypes(target: object, propertyKey: MethodKey): Function[] | undefined {
    const reflect: any = typeof Reflect === 'object' ? Reflect : undefined;
    if (!reflect || typeof reflect.getMetadata !== 'function') return undefined;

    let types: unknown;
    try {
        types = reflect.getMetadata('design:paramtypes', target, propertyKey);
    } catch (error) {
        // A metadata polyfill throwing must never take an installation down with it.
        return undefined;
    }

    return Array.isArray(types) ? (types as Function[]) : undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stageCheck(target: object, propertyKey: MethodKey, index: number, decorator: ParamDeco): void {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
        throw new TypeError('CreateSimpleDecorator: target must be a prototype or constructor');
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(
            `CreateSimpleDecorator: parameter index must be a non-negative integer, received ${String(index)}`,
        );
    }

    let staged = stagedByTarget.get(target);
    if (!staged) {
        staged = new Map<MethodKey, StagedMethod>();
        stagedByTarget.set(target, staged);
    }

    let entry = staged.get(propertyKey);
    if (!entry) {
        entry = {checks: [], installed: false};
        staged.set(propertyKey, entry);
    }

    // `unshift`, mirroring the registry's `'prepend'`: decorators arrive bottom-up, so pushing to
    // the front lands them in declaration order. Across parameters this is equally correct — the
    // whole method's decorator array is applied back-to-front, so reversing the arrival sequence
    // yields source order, and `planChecks` then filters by index without disturbing it.
    entry.checks.unshift({index, decorator});
}
