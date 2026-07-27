/**
 * SPIKE (third pass) — Option A: runtime observation via the `@Sensitive` getter.
 *
 * THROWAWAY. Excluded from tsconfig, eslint and prettier exactly as the rest of `spike/` is.
 * Nothing here is imported by `src/` and nothing here ships.
 *
 * ## What this models
 *
 * adorn installs a per-instance accessor for every decorated field
 * (`src/Adapters/legacy/FieldDecoratorFactory.ts` — `installFieldContract` writes a non-enumerable prototype
 * trampoline; the trampoline's setter calls `defineInstanceSlot`, which writes an OWN, ENUMERABLE
 * accessor closing over a private slot). So adorn controls the READ of a sensitive field.
 *
 * The mechanism under test is NOT branding — §5.5 of the redaction plan already rejected that on
 * measured grounds (primitives discard property assignment, boxing breaks typeof/===).
 *
 * It is VALUE-MEMBERSHIP IN A CALL-SCOPED SET:
 *
 *   1. the getter records the value it returned into a scope-held Set
 *   2. adorn's emitters (DEC-025's closed sink set) check membership before printing
 *
 * A copied string is the same string, so `const copy = s.ssn` is caught — the copy severs the
 * static link but not the value identity. That is the positional appeal: the getter fires at the
 * SOURCE, before any severing occurs.
 *
 * The accessor shape below mirrors FieldDecoratorFactory's exactly (own + enumerable, closure
 * slot, prototype trampoline) so the measurements transfer. The only addition is the `record()`
 * call in the getter.
 */

'use strict';

const {AsyncLocalStorage} = require('node:async_hooks');

// ---------------------------------------------------------------------------
// The scope
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage();

/**
 * A global fallback store, for the "no scope was opened" variant measured in observe-collide.js.
 * Retention is a bounded ring so the set does not grow without limit.
 *
 * NOTE, and it is a finding rather than an implementation detail: this Set is a plaintext index of
 * sensitive values. See observe-collide.js and the write-up.
 */
let globalStore = null;

function makeStore(policy) {
    return {
        observed: new Set(),
        order: [],
        reads: 0,
        recorded: 0,
        policy: policy || DEFAULT_POLICY,
    };
}

const DEFAULT_POLICY = {
    /** minimum string length to be eligible for recording; 0 records everything */
    minLength: 0,
    /** record non-string primitives (number, boolean, bigint) */
    primitives: true,
    /** matching mode at the emitter: 'exact' | 'substring' */
    match: 'exact',
    /** ring-buffer cap for the global variant; Infinity for the scoped variant */
    cap: Infinity,
};

function withScope(policy, fn) {
    return als.run(makeStore(policy), fn);
}

function currentStore() {
    return als.getStore() || globalStore;
}

function useGlobalStore(policy) {
    globalStore = makeStore(policy);
    return globalStore;
}

function clearGlobalStore() {
    globalStore = null;
}

// ---------------------------------------------------------------------------
// Eligibility — this is the collision-containment knob (question 4)
// ---------------------------------------------------------------------------

function eligible(value, policy) {
    const t = typeof value;
    if (t === 'string') return value.length >= policy.minLength;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return policy.primitives === true;
    // objects are not recorded as values: the emitter walks them structurally instead
    return false;
}

function record(value) {
    const store = currentStore();
    if (!store) return;
    store.reads++;
    if (!eligible(value, store.policy)) return;
    if (store.observed.has(value)) return;
    store.observed.add(value);
    store.order.push(value);
    store.recorded++;
    if (store.order.length > store.policy.cap) {
        const evicted = store.order.shift();
        store.observed.delete(evicted);
    }
}

// ---------------------------------------------------------------------------
// The @Sensitive field decorator — accessor shape mirrored from FieldDecoratorFactory
// ---------------------------------------------------------------------------

const installed = new WeakMap();

function isInstalled(target, key) {
    const keys = installed.get(target);
    return keys ? keys.has(key) : false;
}

function markInstalled(target, key) {
    let keys = installed.get(target);
    if (!keys) {
        keys = new Set();
        installed.set(target, keys);
    }
    keys.add(key);
}

/** Mirrors `defineInstanceSlot`: own + enumerable accessor over a closure slot. */
function defineInstanceSlot(instance, owner, key, initial) {
    if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) return;

    let slot = initial;

    Object.defineProperty(instance, key, {
        configurable: true,
        // own AND enumerable — FieldDecoratorFactory.ts:565. This is what keeps JSON.stringify,
        // Object.keys, spread and Object.assign behaving as they do for an undecorated field, and
        // it is ALSO what makes every one of those paths pass through the getter below.
        enumerable: true,
        get: function adornFieldGet() {
            record(slot);
            return slot;
        },
        set: function adornFieldSet(next) {
            if (this === instance) {
                slot = next;
                return;
            }
            defineInstanceSlot(this, owner, key, next);
        },
    });
}

/** Mirrors `installFieldContract`'s prototype trampoline. */
function Sensitive() {
    return function sensitiveFieldDecorator(target, key) {
        if (isInstalled(target, key)) return;
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            get: function adornFieldTrampolineGet() {
                return undefined;
            },
            set: function adornFieldTrampolineSet(value) {
                defineInstanceSlot(this, target, key, value);
            },
        });
        markInstalled(target, key);
    };
}

// ---------------------------------------------------------------------------
// The emitter — DEC-025's closed sink set, modelled by @Log
// ---------------------------------------------------------------------------

const CENSOR = '[REDACTED]';

/**
 * Render one argument, redacting anything that is a member of the scope's observed set.
 *
 * `exact`     — a string/primitive leaf equal to an observed value is replaced wholesale
 * `substring` — a string leaf CONTAINING an observed value has that occurrence replaced
 *
 * Objects are walked structurally (depth-bounded, cycle-safe) because a sensitive value can arrive
 * nested — `emitObj({...s})`, `emitWrapped({value: s.ssn})`.
 */
function renderRedacted(value, store, stats) {
    const seen = new Set();
    const out = walk(value, 0);
    return out;

    function walk(v, depth) {
        if (depth > 8) return '[depth]';
        const t = typeof v;

        if (v === null) return 'null';
        if (t === 'undefined') return 'undefined';

        if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
            return matchLeaf(v, t);
        }

        if (t === 'function') return '[function]';

        if (seen.has(v)) return '[cycle]';
        seen.add(v);

        if (Array.isArray(v)) return '[' + v.map(x => walk(x, depth + 1)).join(',') + ']';

        const parts = [];
        for (const k of Object.keys(v)) {
            parts.push(k + ':' + walk(v[k], depth + 1));
        }
        return '{' + parts.join(',') + '}';
    }

    function matchLeaf(v, t) {
        stats.leaves++;
        if (!store) return String(v);

        if (store.observed.has(v)) {
            stats.redacted++;
            return CENSOR;
        }

        if (store.policy.match === 'substring' && t === 'string') {
            let text = v;
            let hit = false;
            for (const obs of store.observed) {
                if (typeof obs !== 'string' || obs.length === 0) continue;
                stats.comparisons++;
                if (text.indexOf(obs) !== -1) {
                    text = text.split(obs).join(CENSOR);
                    hit = true;
                }
            }
            if (hit) {
                stats.redacted++;
                return text;
            }
        }

        return String(v);
    }
}

/** The emission log, so tests can assert on what actually got printed. */
const emissions = [];

function resetEmissions() {
    emissions.length = 0;
}

/**
 * Mirrors `@Log()` — `src/MethodDecorators/Log.ts:92` renders EVERY argument. The only change is
 * that rendering consults the scope's observed set first.
 */
function Log() {
    return function logMethodDecorator(target, key, descriptor) {
        const original = descriptor.value;
        descriptor.value = function adornLogged(...args) {
            const store = currentStore();
            const stats = {leaves: 0, redacted: 0, comparisons: 0};
            const rendered = args.map(a => renderRedacted(a, store, stats));
            emissions.push({method: key, rendered, stats, scoped: store !== null && store !== undefined});
            return original.apply(this, args);
        };
        return descriptor;
    };
}

/** Imperative decorator application — plain JS has no decorator syntax; this is what __decorate does. */
function decorateField(proto, key, decorator) {
    decorator(proto, key);
}

function decorateMethod(proto, key, decorator) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    const next = decorator(proto, key, d) || d;
    Object.defineProperty(proto, key, next);
}

module.exports = {
    als,
    withScope,
    currentStore,
    useGlobalStore,
    clearGlobalStore,
    makeStore,
    DEFAULT_POLICY,
    Sensitive,
    Log,
    decorateField,
    decorateMethod,
    renderRedacted,
    emissions,
    resetEmissions,
    CENSOR,
    record,
    eligible,
};
