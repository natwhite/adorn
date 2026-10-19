/**
 * Pre-state capture for postconditions (axiform feedback 2026-10-18 §9 — the `old()` mechanism).
 *
 * ## The soundness hole this closes
 *
 * A postcondition is evaluated as `predicate(result, ...args)` against the SAME argument objects the body
 * ran with. A body that MUTATES an argument therefore changes what its own postcondition checks against — a
 * clamp that returns `5` for `{raw: -1}` and also sets `raw = 5` makes `result === input.raw` hold after the
 * fact and passes, masking the violation. That is a silent false-pass, the exact failure adorn exists to
 * prevent.
 *
 * ## The fix: an explicit snapshot taken at ENTRY, sound by construction
 *
 * A postcondition that needs pre-state declares a `capture(...args)` run BEFORE the body. Its result is
 * {@link snapshotOldState | deep-cloned and deep-frozen} and handed to the predicate as `old`
 * (`predicate(result, old, ...args)`). Cloning at entry is what makes it sound REGARDLESS of how the author
 * wrote the capture:
 *   - `capture: s => ({raw: s.raw})` — copies the primitive; the clone is trivially immune to later mutation.
 *   - `capture: s => s` — aliases the whole argument; the CLONE is still a deep snapshot of entry-state, so
 *     the body mutating the original cannot reach it.
 * There is no shallow-alias default (which would re-introduce the hole) and no attempt to auto-capture every
 * argument (unsound for non-cloneable values, and wasteful). A capture that returns a non-cloneable value
 * (a function, a class instance with private state, …) fails LOUDLY at entry rather than silently degrading.
 *
 * Opt-in per clause: a postcondition with no `capture` is evaluated exactly as before, so nothing a consumer
 * already wrote changes shape.
 */

import type {Postcondition} from './ContractRegistry';

/**
 * Recursively freeze a value, so a captured snapshot cannot be mutated after the fact (by the body, a later
 * clause, or the consumer). Cycle-safe via a `seen` set — `structuredClone` can produce a cyclic clone, and a
 * naive recursion would stack-overflow on one. Primitives pass through untouched.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key], seen);
    }
    return Object.freeze(value);
}

/**
 * Snapshot a captured value for use as postcondition pre-state: deep-clone it (so the body cannot reach into
 * it), then deep-freeze the clone (so the snapshot is immutable). A value `structuredClone` rejects throws a
 * clear {@link TypeError} — pre-state must be plain, cloneable data, and failing loudly here beats a snapshot
 * that silently aliases live state.
 */
export function snapshotOldState(value: unknown): unknown {
    let clone: unknown;
    try {
        clone = structuredClone(value);
    } catch (error) {
        throw new TypeError(
            'postcondition `capture` must return a structured-cloneable value (plain data) so it can be ' +
                'snapshotted at call entry — structuredClone rejected the captured value: ' +
                String((error as {message?: unknown})?.message ?? error),
        );
    }
    return deepFreeze(clone);
}

/**
 * Compute the per-postcondition pre-state at call ENTRY: for each postcondition that declares a `capture`,
 * run it against the (as-yet-unmutated) arguments and snapshot the result; `undefined` for the rest. The
 * returned array is index-aligned with `posts`, and is threaded to {@link evaluatePostconditions} after the
 * body settles. A `capture` that THROWS propagates unchanged — it is author setup, not a check, so a bug in
 * it is an author defect surfaced at entry rather than masqueraded as a failed postcondition.
 */
export function captureOldState(
    posts: ReadonlyArray<Postcondition>,
    args: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
    return posts.map(post =>
        post.capture ? snapshotOldState(post.capture(...(args as unknown[]))) : undefined,
    );
}
