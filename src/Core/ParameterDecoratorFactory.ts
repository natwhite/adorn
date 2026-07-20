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
 * ## Evaluation order — SMELL-11, now settled deliberately
 *
 * `__decorate` applies its decorator array back-to-front, so decorators arrive here in **reverse**
 * declaration order: the last parameter registers first, and stacked decorators on one parameter
 * arrive bottom-up. The old design inherited that ordering implicitly into enforcement, so with
 * several arguments invalid it was the *highest-index* parameter that got reported.
 *
 * {@link buildParameterEnforcement} normalises to **declaration order** — parameters left to right,
 * and within a parameter top to bottom. That is the order a reader of the signature expects, and it
 * is the order documentation will list constraints in, so enforcement and projection agree. This is
 * a deliberate behavioural change, not an inherited accident.
 */

import {ConstraintDescriptor} from './Descriptor';
import {getContract, MethodKey, recordParameterConstraint} from './ContractRegistry';
import {notePendingContract} from './ContractDiagnostics';
import {DecoratorFactory} from './common';
import {InvocationContext} from './MethodDecoratorFactory';

/**
 * Object handed to a {@link ParamDeco} closure. Unchanged from the original design — this is public
 * authoring surface and the fields are load-bearing for existing error messages.
 */
export interface ParamObject<T> {
    objectName: string,
    funcName: string,
    paramName: string,
    value: T
    signature: string
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
    /** Arrival order, i.e. reverse declaration order. Normalised at plan time. */
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
            recordParameterConstraint(target, propertyKey, parameterIndex, constraint);
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

    // --- declaration order (SMELL-11) ---------------------------------------
    //
    // Registry params are already sorted ascending by index. Within one parameter, both the
    // registry array and the staging array are in *arrival* order, which `__decorate`'s
    // back-to-front application makes the reverse of declaration order; `.slice().reverse()`
    // restores it. Reversing here rather than at record time keeps the knowledge of `__decorate`'s
    // application order in the adapter, which is the only layer entitled to know about it.

    const indices = new Set<number>();
    if (contract) contract.params.forEach(param => indices.add(param.index));
    if (stagedMethod) stagedMethod.checks.forEach(check => indices.add(check.index));

    const ordered = Array.from(indices).sort((a, b) => a - b);
    const plan: PlannedCheck[] = [];

    for (const index of ordered) {
        const parameter = contract && contract.params.filter(p => p.index === index)[0];
        if (parameter) {
            const declarationOrder = parameter.constraints.slice().reverse();
            for (const constraint of declarationOrder) {
                plan.push(descriptorCheck(constraint, index, signatureFor, paramNames));
            }
        }

        if (stagedMethod) {
            const declarationOrder = stagedMethod.checks
                .filter(check => check.index === index)
                .reverse();
            for (const check of declarationOrder) {
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
        throw new Error(constraint.message({
            value,
            signature: signatureFor(index),
            paramName: paramNames[index],
        }));
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stageCheck(target: object, propertyKey: MethodKey, index: number, decorator: ParamDeco): void {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
        throw new TypeError('CreateSimpleDecorator: target must be a prototype or constructor');
    }
    if (typeof index !== 'number' || index < 0 || !isFinite(index) || Math.floor(index) !== index) {
        throw new TypeError(`CreateSimpleDecorator: parameter index must be a non-negative integer, received ${String(index)}`);
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

    entry.checks.push({index, decorator});
}
