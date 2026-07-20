// Custom decorator type wrappers

export type AdornClassDecorator = ClassDecorator;
export type AdornPropertyDecorator = PropertyDecorator
export type AdornMethodDecorator = MethodDecorator
export type AdornParameterDecorator = ParameterDecorator


const STRIP_COMMENTS = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s*=[^,)]*(('(?:\\'|[^'\r\n])*')|("(?:\\"|[^"\r\n])*"))|(\s*=[^,)]*))/mg;
const ARGUMENT_NAMES = /([^\s,]+)/g;

export abstract class DecoratorFactory {
    static getParamNames(func) {
        const fnStr = func.toString().replace(STRIP_COMMENTS, '');
        const result = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
        return result === null ? [] : result;
    }

    /**
     * The class name for a decoration target — **BUG-12**.
     *
     * A decorator is handed two different objects depending on where the member lives, and this
     * helper has to reconcile them. For an instance member `target` is `Class.prototype`, whose
     * `.constructor` is the class. For a **static** member `target` *is* the constructor, so
     * `.constructor` is `Function` — and the previous unconditional `object.constructor.name`
     * therefore reported every static violation as belonging to `Function`:
     *
     * ```
     * Value Error: Function.parse(input) parameter 'input' expected ...   // before
     * Value Error: Task.parse(input) parameter 'input' expected ...       // after
     * ```
     *
     * The same two-band split `getContractsForClass` exists to centralise (DEC-018): a class's
     * members live on two objects, and *getting it wrong does not fail* — it produces a plausible,
     * wrong answer. That is why the check belongs here once rather than at each call site.
     *
     * Returns a falsy value when no name can be determined (an anonymous class, a null-prototype
     * object); callers decide what to substitute.
     */
    static getObjectName(object: Object) {
        // A constructor is its own owner. `typeof` rather than an `instanceof Function` test so a
        // cross-realm constructor resolves correctly too.
        if (typeof object === 'function') return (object as Function).name;
        return object && object.constructor && object.constructor.name;
    }

    /**
     * Re-point a thrown error's stack at the **caller** rather than at adorn's internals.
     *
     * Replaces (SMELL-2):
     *
     * ```ts
     * const stackSteps = e.stack.split('\n');
     * e.stack = stackSteps[0] + '\n' + stackSteps.slice(3).join('\n') + '\n';
     * ```
     *
     * Two defects in that, both fixed here:
     *
     * 1. **It hardcoded wrapper depth.** `slice(3)` encodes "exactly two frames of adorn
     *    internals". Any change to how deeply the wrapper nests silently produced a wrong stack.
     *    `Error.captureStackTrace(error, boundary)` elides everything up to *and including*
     *    `boundary` without counting anything, so the wrapper can be restructured freely.
     * 2. **A non-`Error` throw destroyed the original failure.** `e.stack` is `undefined` for a
     *    thrown string, so `.split` raised a `TypeError` from inside adorn's own error handling and
     *    the caller never saw what actually went wrong. Anything without a string `stack` is now
     *    left completely untouched and propagates as thrown.
     *
     * `Error.captureStackTrace` is V8-only. On other engines this is a no-op and the stack is left
     * as it is — a slightly noisier trace is strictly better than a corrupted one.
     *
     * @param error    the caught value; anything that is not a stack-carrying Error is ignored
     * @param boundary the frame to cut at, normally the installed wrapper
     */
    static attributeToCaller(error: unknown, boundary: Function): void {
        if (error === null || typeof error !== 'object') return;
        if (typeof (error as { stack?: unknown }).stack !== 'string') return;

        const capture = (Error as unknown as {
            captureStackTrace?: (target: object, constructorOpt?: Function) => void
        }).captureStackTrace;
        if (typeof capture !== 'function') return;

        capture(error as object, boundary);
    }

    /*
     * P1.4 — `OverrideObjectDefineProperty` was deleted here (DEC-005).
     *
     * It replaced the global `Object.defineProperty` with a one-shot no-op that restored itself on
     * first call, armed at the end of every first parameter decorator. Its only job was to swallow
     * the trailing `Object.defineProperty(target, key, r)` in tslib's `__decorate`, which would
     * otherwise restore the pre-decoration method descriptor and discard the wrapper the parameter
     * decorator had just assigned.
     *
     * It could not be deleted on its own. A parameter decorator's return value is ignored by the
     * language, so under the old design there was no other way to make the wrapper stick — removing
     * the patch first would have broken parameter decorators outright. Removal and re-architecture
     * were one task, in the order P1.2 -> P1.3 -> P1.4:
     *
     *   P1.2  MethodDecoratorFactory — a decorator that RETURNS a descriptor, which `__decorate`
     *         honours (`r = d(target, key, r) || r`), so no patching is needed.
     *   P1.3  parameter decorators record into ContractRegistry; `@Contract()` installs afterwards,
     *         by which point `__decorate`'s trailing write has already happened.
     *   P1.4  nothing writes to the method during member decoration any more, so there is nothing
     *         to protect. Deleted.
     *
     * Also closes BUG-8 (the method did not type-check on TypeScript >= 4.0 without a cast) and
     * BUG-2 (patching a global left a window in which any unrelated `defineProperty` was silently
     * swallowed).
     *
     * A test asserts `Object.defineProperty` is identity-stable across decoration, on both
     * `__decorate` branches.
     */
}
