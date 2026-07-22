/**
 * `@Log` — logs each call to the decorated method and how it finished.
 *
 * ## Safe by default (BUG-18, DEC-025 / DEC-PII-1) — the breaking change
 *
 * `@Log` used to build `context.args.map(safeStringify).join(',')` and write every argument value,
 * plus the return value, to `console.log`. That is BUG-18: a method taking a password, a token, or a
 * whole user record logged it in the clear, and the only opt-out was not using the decorator.
 *
 * It now emits **structure, not values**: the parameter *names* (recovered from the source — SMELL-1),
 * their declared *types* when the toolchain emitted them, and a `[REDACTED]` placeholder for every
 * value. No raw argument or return value leaves the process **without an explicit opt-in**, and the
 * opt-in does not depend on any `@Sensitive` annotation — a class with no `@Sensitive` at all is
 * still safe (the DEC-PII-1 principle: forgetting the annotation must never be what causes a leak).
 *
 * Raw values return only via `setValueDisclosure('all')` (redaction runtime), and even then a
 * `@Sensitive`-marked parameter, return, or class stays redacted — that veto is the *only* thing the
 * annotation does here; it is defence-in-depth, never the primary control.
 *
 * ## It cannot change what the method does (BUG-13, preserved)
 *
 * Every part of the logging path is still total: values are rendered by {@link safeStringify}, the
 * write itself is guarded, and a throw is logged and then re-thrown unchanged. `@Log` is built on
 * `MethodDecoratorFactory`, so `.name` and `toString` are preserved — the latter is load-bearing,
 * because parameter-name recovery parses `Function.prototype.toString` (SMELL-1).
 */

import {CreateMethodDecorator, InvocationContext} from '../Core/MethodDecoratorFactory';
import {DecoratorFactory} from '../Core/common';
import {
    getEffectiveClassSensitivity,
    getEffectiveFieldSensitivity,
    getParameterSensitivity,
    MethodKey,
} from '../Core/ContractRegistry';
import {REDACTED, shouldDiscloseValue} from '../Core/redaction';

/** A member name that is safe to interpolate. `${symbol}` throws; `String(symbol)` does not. */
function memberName(propertyKey: string | symbol): string {
    return typeof propertyKey === 'symbol' ? propertyKey.toString() : String(propertyKey);
}

// ---------------------------------------------------------------------------
// Total value rendering (BUG-13) — used only when a value is actually disclosed
// ---------------------------------------------------------------------------

/**
 * Render a value for a log line without ever throwing (BUG-13).
 *
 * `JSON.stringify` is not total. It raises on a circular structure and on a `BigInt`, and the
 * original `@Log` called it unguarded on both the arguments *and* the return value — so a method
 * returning a self-referential object had its return **destroyed by its own logger**, and a
 * method *taking* one was never called at all, because the argument line was built first. A
 * logging decorator that can change whether a method succeeds is worse than no logging.
 *
 * Cycles are detected against the current ancestor chain rather than a flat "already seen" set,
 * so a value referenced by two siblings renders normally instead of being mislabelled
 * `[Circular]` — the usual bug in the quick version of this function.
 */
function safeStringify(value: any): string {
    if (value === undefined) return 'undefined';

    const ancestors: any[] = [];
    try {
        const json = JSON.stringify(value, function (this: any, _key: string, val: any) {
            if (typeof val === 'bigint') return String(val) + 'n';
            if (typeof val === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
            if (typeof val === 'symbol') return val.toString();
            if (val === null || typeof val !== 'object') return val;

            // `this` is the object `val` was read from. Unwind to it, so entries left behind
            // by a completed branch do not masquerade as ancestors of this one.
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.indexOf(val) !== -1) return '[Circular]';
            ancestors.push(val);
            return val;
        });
        // `JSON.stringify` returns `undefined` for a function or a lone symbol at the top level.
        return json === undefined ? String(value) : json;
    } catch {
        // Belt and braces. Whatever this was, it is not worth failing a method over.
        return '[unserializable]';
    }
}

/** Describes a thrown value for the log line. A throw is not required to be an `Error`. */
function describeThrown(error: any): string {
    if (error instanceof Error) return error.name + ': ' + error.message;
    return safeStringify(error);
}

/** Writing the log must not be able to fail the call either — a sink can be broken too. */
function write(line: string): void {
    try {
        if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(line);
    } catch {
        // Ignored, deliberately. See `safeStringify`.
    }
}

// ---------------------------------------------------------------------------
// Signature resolution — computed once per decorated method, cached
// ---------------------------------------------------------------------------

/**
 * The structural facts about a decorated method that never change per call: its name, its parameter
 * names and declared types, and which of its parameters / return / owning class are `@Sensitive`.
 *
 * Resolved lazily on the first invocation rather than at decoration time, because a plain method
 * decorator is not handed the sensitivity markings until they have all been recorded, and because
 * the factory hands `target`/`propertyKey` to the behaviour per call rather than up front. Cached in
 * the per-decorator closure afterwards, so the `toString` parse and the registry reads happen once.
 */
interface LogSignature {
    readonly member: string;
    readonly names: ReadonlyArray<string>;
    readonly types: ReadonlyArray<string | undefined>;
    readonly paramSensitive: ReadonlyArray<boolean>;
    readonly returnSensitive: boolean;
}

function resolveSignature(context: InvocationContext): LogSignature {
    const target = context.target;
    const key = context.propertyKey;
    const names = DecoratorFactory.getParamNames(context.original);
    const reflected = reflectTypes(target, key);

    // A class-level `@Sensitive` sensitises every value emitted for the class — a conservative,
    // never-load-bearing default that only ever *strengthens* redaction (DEC-PII-1).
    const owner = typeof target === 'function' ? target : (target as {constructor?: Function}).constructor;
    const classSensitive = typeof owner === 'function' && !!getEffectiveClassSensitivity(owner);

    const paramSensitive: boolean[] = names.map(
        (_name, index) => classSensitive || isParameterSensitive(target, key, index),
    );

    // A method-level `@Sensitive` records against the method key in the field-sensitivity band, so
    // the effective field read is the honest way to ask "is this method's return marked?".
    const returnSensitive = classSensitive || !!getEffectiveFieldSensitivity(target, key);

    return {member: memberName(key), names, types: reflected, paramSensitive, returnSensitive};
}

/** Reflected `design:paramtypes` rendered as type names, or `undefined` per position when absent. */
function reflectTypes(target: object, key: MethodKey): (string | undefined)[] {
    const reflect: any = typeof Reflect === 'object' ? Reflect : undefined;
    if (!reflect || typeof reflect.getMetadata !== 'function') return [];
    let types: unknown;
    try {
        types = reflect.getMetadata('design:paramtypes', target, key);
    } catch {
        return [];
    }
    if (!Array.isArray(types)) return [];
    return (types as unknown[]).map(entry =>
        typeof entry === 'function' && entry.name ? entry.name : undefined,
    );
}

/**
 * Whether parameter `index` of `target[key]` carries a `@Sensitive` marking, walking the prototype
 * chain so an inherited marking is honoured. Read-only consumption of the registry's sensitivity
 * band; never load-bearing — a miss only ever under-vetoes an explicit disclosure opt-in.
 */
function isParameterSensitive(target: object, key: MethodKey, index: number): boolean {
    for (let cursor: object | null = target; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
        if (getParameterSensitivity(cursor, key, index)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `name: Type=[REDACTED]` per argument, or the disclosed value in place of the placeholder when
 * `setValueDisclosure('all')` is on and the parameter is not `@Sensitive`. Renders exactly the
 * arguments the method was handed, so an omitted optional parameter does not appear.
 */
function renderArguments(args: any[], signature: LogSignature): string {
    const parts: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const name = signature.names[index] || `arg${index}`;
        const type = signature.types[index];
        const label = type ? `${name}: ${type}` : name;
        const disclose = shouldDiscloseValue(signature.paramSensitive[index] === true);
        parts.push(`${label}=${disclose ? safeStringify(args[index]) : REDACTED}`);
    }
    return parts.join(', ');
}

/** The return value, redacted unless disclosed and the return is not `@Sensitive`. */
function renderReturn(result: any, signature: LogSignature): string {
    return shouldDiscloseValue(signature.returnSensitive) ? safeStringify(result) : REDACTED;
}

// ---------------------------------------------------------------------------
// @Log
// ---------------------------------------------------------------------------

/**
 * Logs each call to the decorated method — its structure, and how it finished.
 *
 * Emits parameter names and types with a `[REDACTED]` placeholder for every value by default; a
 * throw is reported (the original logged only on success, so a failing call — the one a reader most
 * wants — left no trace). See the module note for the safe-by-default contract and the opt-in.
 */
export function Log(): MethodDecorator {
    // Per-decorated-method cache; see {@link LogSignature}.
    let signature: LogSignature | undefined;

    return CreateMethodDecorator(function (context: InvocationContext, proceed: () => any) {
        if (!signature) signature = resolveSignature(context);
        const member = signature.member;
        // Rendered before the call, so what is logged is what the method was actually handed
        // rather than whatever it may have mutated its arguments into.
        const params = renderArguments(context.args, signature);

        let result: any;
        try {
            result = proceed();
        } catch (error) {
            write(`Call: ${member}(${params}) threw ${describeThrown(error)}`);
            throw error;
        }

        write(`Call: ${member}(${params}) => ${renderReturn(result, signature)}`);
        return result;
    });
}
