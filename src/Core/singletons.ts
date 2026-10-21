/**
 * Process-global singleton backing (DEC-095) — one shared store across every loaded copy of adorn.
 *
 * adorn keeps mutable process state: the contract registry, the constraint-definition map, the observation
 * sink + call-id sequence, the diagnostic sink, and the violation/verbosity configuration. Each lives as
 * module-scope state in a Core module. Under ONE loaded copy that is fine — but a dual-package consumer (an
 * app that `import`s the ESM build while a dependency `require`s the CJS build) loads adorn TWICE, so each
 * module gets its OWN copy of that state. A `@Contract` registered through one copy would then be invisible to
 * the evaluator reached through the other, silently disabling enforcement — the worst failure a contract
 * library can have. The same split happens when two physical installs resolve (a `file:`/submodule-vendored
 * copy beside a `node_modules` copy).
 *
 * The fix is one shared store, keyed on `globalThis` under a VERSIONED registry symbol so every loaded copy of
 * this module — of any identical version — resolves the same object. {@link globalSlot} returns the single
 * instance for a name, creating it once. Modules then either:
 *   - **seed by reference** — a map/set shared this way stays shared for the life of the process, because
 *     records and reads mutate the one object (used for the registry bands, which only the test-only
 *     `resetRegistry` ever replaces); or
 *   - **route through the slot** — state a module REASSIGNS at runtime (a swappable sink, the policy, the id
 *     counter, a primitive flag) is read and written as `slot.field` so both copies observe every change.
 *
 * `Symbol.for` (the cross-realm symbol registry) is deliberate: a module-local `Symbol()` would not match
 * across copies. The key is pinned to a schema version — two DIFFERENT adorn majors in one process intentionally
 * do not share (their state shapes may differ), and mixing majors in one process is unsupported regardless.
 */

const ROOT_KEY = Symbol.for('adorn.singletons.v1');

type SlotRoot = Record<string, unknown>;

function root(): SlotRoot {
    const holder = globalThis as unknown as Record<symbol, SlotRoot | undefined>;
    let current = holder[ROOT_KEY];
    if (!current) {
        current = {};
        holder[ROOT_KEY] = current;
    }
    return current;
}

/**
 * The single process-wide instance for `name`, created once via `create` and shared across every loaded copy
 * of adorn. See the module header for when a caller should seed-by-reference vs. route reads/writes through the
 * returned object.
 */
export function globalSlot<T>(name: string, create: () => T): T {
    const slots = root();
    if (!(name in slots)) {
        slots[name] = create();
    }
    return slots[name] as T;
}
