# Postconditions — Plan B (pragmatic, ship-to-unblock-fuzzing)

> **Angle.** This is the *engineering path*: the least machinery that gives a real runtime
> postcondition check **and** feeds the fuzzer, sequenced so it ships. A parallel plan takes the
> DbC-purist angle (`old()`, contravariant/covariant inheritance, projectable postcondition data).
> Where the purist answer is expensive, this plan defers it and says why. A tight v1 that ships beats
> a complete design that doesn't.
>
> **Central fact this plan is built on:** fuzzing is blocked on an oracle (IDEA-4, DEC-006 §9). The
> whole point of postconditions *for this project* is to move generated inputs past "it didn't throw."
> So the bar for v1 is exactly: **a runnable check on the return value, readable by the fuzzer.**
> Everything past that bar is deferred.

---

## 0. Thesis in one paragraph

A v1 postcondition is a **hand-written closure over the return value and the arguments** —
`@Ensures((result, ...args) => boolean)`. It is *not* a reified `ConstraintDescriptor`, because a
closure carries no identity and no serialisable params and cannot be derived-from-params (DEC-010),
and forcing it into a descriptor would either lie about the predicate's arity or corrupt the
projections. Postconditions therefore get their own **registry band** — the exact move already made
three times in this codebase (`CreateSimpleDecorator` staged checks, the field band, the sensitivity
band): an own-scoped `WeakMap` with a prototype-chain union read. `@Ensures` **records**; `@Contract()`
(or `@Validate()`) **installs** one combined wrapper that runs preconditions before `proceed()` and
postconditions after. The fuzzer reads the band directly and evaluates the same closures through the
same evaluator the runtime uses — one declaration, two consumers, no drift. Async is handled by
awaiting a returned Promise before checking; a method that **throws** skips its postconditions by
design. `old()`, invariants, `this`-state, Observable settling, and *projectable/documentable*
postconditions are all explicitly deferred.

---

## 1. Why the reserved `post: ConstraintDescriptor[]` slot is the wrong home for v1 (and what to do instead)

**Q-11 is real and is the concrete blocker.** `MethodContract` reserves
`pre: ConstraintDescriptor[]` and `post: ConstraintDescriptor[]`
(`src/Core/ContractRegistry.ts:105-107`), they are always empty, and **nothing can write to them** —
there is no `recordPostcondition`. DEC-022 already *unions* `post` across inheritance and
`getContractsForClass` already surfaces it and `docs.ts` already maps it
(`entry.contract.post.map(toConstraintDoc)` at `src/Projections/docs.ts:275`), all inert for want of a
writer. The temptation is: "just write a `ConstraintDescriptor` into `post` and Q-11 is closed."

**Resist it.** A `ConstraintDescriptor` (`src/Core/Descriptor.ts:125-145`) is a very specific thing:

- Its `predicate` is `(value: unknown) => boolean` — **one value**. A useful postcondition relates the
  **result to the arguments** (`transfer returns >= amount`), so it needs `(result, ...args)`. The
  descriptor's single-value predicate shape cannot express that.
- Its `predicate` is **derived from `params`**, never attached (DEC-010, and `defineConstraint` throws
  without a `derive`). A user closure `result => result.id > 0` cannot be derived from serialisable
  params — it *is* the black box Q-3 names.
- `recordParameterConstraint`/`recordFieldConstraint` **throw on bare predicates by design**
  (`ContractRegistry.ts:812`, `:884`). The registry's own rule is: closures don't live here as
  descriptors.
- `toConstraintDoc` would render a faked descriptor into docs with a meaningless `constraint` identity
  and empty `params` — the "artifact that looks complete and is not" failure DEC-016/DEC-011 exist to
  prevent.

The codebase has already answered "where do hand-written closures go?" three times, and the answer is
never "fake a descriptor":

| Closure kind | Where it lives | Visible to projections? |
|---|---|---|
| `CreateSimpleDecorator` param check | adapter-local `stagedByTarget` (`ParameterDecoratorFactory.ts:126`) | No (SMELL-14, Q-3) |
| field constraint | field band `fieldsByTarget` | Yes (but these *are* descriptors) |
| `@Sensitive` marking | sensitivity band `fieldSensitivityByTarget` etc. | record-only |

**Decision (pragmatic): postconditions get their own band, closure-shaped, and the reserved
`post: ConstraintDescriptor[]` slot stays reserved for a *future descriptor-shaped* postcondition
(deferred, §7).** This is purely additive, mirrors the field band line-for-line, touches no existing
type, and does not weaken DEC-010. Q-11's "reserved slot has no writer" is resolved not by writing to
the descriptor slot but by adding the writer for the thing v1 actually needs. The descriptor `post`
slot's writer remains legitimately deferred, and may never be needed if closures suffice.

---

## 2. The Q-11 writer: the postcondition band

All of this goes in `src/Core/ContractRegistry.ts`, alongside the field band it copies. The **data
type** lives in the registry (like `FieldContract`); the **evaluator + message** live in a new
`src/Core/Postconditions.ts` (logic, not storage), so the registry stays storage-only and
decorator-agnostic (DEC-012).

### 2.1 The stored shape

```ts
// src/Core/ContractRegistry.ts

/** The arguments a postcondition predicate is handed, beyond the result. */
export type PostconditionPredicate = (result: unknown, ...args: any[]) => boolean;

/**
 * One recorded postcondition. A closure, not a ConstraintDescriptor: it carries no identity and no
 * serialisable params (Q-3), so it is enforceable and fuzzable but NOT projectable to docs/schema —
 * exactly the CreateSimpleDecorator trade (SMELL-14), applied to the return value.
 */
export interface Postcondition {
    readonly predicate: PostconditionPredicate;
    /** Optional human phrase for the violation message, e.g. "the id is positive". */
    readonly description?: string;
}
```

`args: any[]` — deliberately the same `any[]` the invocation seam already exposes
(`InvocationContext.args`, `MethodDecoratorFactory.ts:71`). No new value types, nothing serialisable
required.

### 2.2 Storage — one WeakMap, own-scoped, keyed exactly like every other band

```ts
/** Postcondition band. Own-scoped, keyed like contractsByTarget: prototype or constructor → key. */
let postconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Postcondition[]>>();
```

Add to `resetRegistry()` (`ContractRegistry.ts:1104`):

```ts
postconditionsByTarget = new WeakMap<ContractTarget, Map<MethodKey, Postcondition[]>>();
```

### 2.3 The writer

```ts
/**
 * Record a postcondition against target[key]. A method may carry several; recorded in declaration
 * order by the adapter (the @Ensures decorator unshifts to normalise __decorate's reversal, exactly
 * as stageCheck does — DEC-015/DEC-017).
 */
export function recordPostcondition(
    target: ContractTarget,
    key: MethodKey,
    postcondition: Postcondition,
    position: ConstraintPosition = 'append',
): void {
    if (!postcondition || typeof postcondition.predicate !== 'function') {
        throw new TypeError('recordPostcondition: expected a { predicate } with a function predicate');
    }
    const list = postconditionEntry(target, key);
    if (position === 'prepend') list.unshift(postcondition);
    else list.push(postcondition);
}

function postconditionEntry(target: ContractTarget, key: MethodKey): Postcondition[] {
    if (!isRegisterableTarget(target)) {
        throw new TypeError('ContractRegistry: target must be an object (a prototype or constructor)');
    }
    let byKey = postconditionsByTarget.get(target);
    if (!byKey) { byKey = new Map(); postconditionsByTarget.set(target, byKey); }
    let list = byKey.get(key);
    if (!list) { list = []; byKey.set(key, list); }
    return list;
}
```

The `position` parameter and its rationale are lifted verbatim from `recordParameterConstraint`
(`ContractRegistry.ts:805`): the legacy adapter's decorators arrive bottom-up, so `@Ensures` records
with `'prepend'` and the store is correct *as recorded* — keeping `__decorate`'s ordering knowledge in
the adapter (DEC-015).

### 2.4 The reads (own + effective), copied from the field band

```ts
/** Postconditions declared directly on target[key]. Own-scoped. */
export function getPostconditions(target: ContractTarget, key: MethodKey): ReadonlyArray<Postcondition> {
    if (!isRegisterableTarget(target)) return NO_POSTCONDITIONS;
    const list = postconditionsByTarget.get(target)?.get(key);
    return list ? list : NO_POSTCONDITIONS;
}

/**
 * Every postcondition in force on target[key], base-most class first (DEC-022). This is the read the
 * installer plans from AND the read the fuzzer's oracle consumes.
 *
 * Conjunction here is correct even under classical DbC: a subclass STRENGTHENS a postcondition
 * covariantly, which is exactly union/AND. (Contrast preconditions, where DEC-022 had to argue a
 * departure from Meyer — for postconditions there is no tension.)
 */
export function getEffectivePostconditions(
    target: ContractTarget,
    key: MethodKey,
): ReadonlyArray<Postcondition> {
    // identical structure to getEffectiveFieldConstraints: walk the chain own-most first, collect
    // non-empty levels, emit base-most first, return the stored array uncopied when only one level.
    // ...
}

/** Method keys carrying postconditions on target (own). Complements getStagedMethodKeys. */
export function getPostconditionKeys(target: ContractTarget): MethodKey[] { /* enumerate own map */ }

/** ...anywhere on the chain, own-most first, deduped. Complements getEffectiveStagedMethodKeys. */
export function getEffectivePostconditionKeys(target: ContractTarget): MethodKey[] { /* chain walk */ }
```

These are mechanical copies of `getEffectiveFieldConstraints` / `getEffectiveContractKeys` /
`getEffectiveStagedMethodKeys` (already in the file), so the union semantics, the "empty level is
skipped" rule, and the no-copy fast path all come for free and behave identically to the bands the
team already reviewed. **That is the whole reason to mirror them rather than invent.**

### 2.5 The evaluator + message — `src/Core/Postconditions.ts` (new)

One evaluator, shared by the runtime seam and the fuzzer, so they can never disagree about what "the
postcondition held" means:

```ts
// src/Core/Postconditions.ts
import {Postcondition} from './ContractRegistry';
import {REDACTED, shouldDiscloseValue} from './redaction';

export type PostconditionResult =
    | {readonly ok: true}
    | {readonly ok: false; readonly failed: Postcondition; readonly error?: unknown};

/**
 * Evaluate every postcondition against one outcome. First failure wins (base-most first, so the most
 * general broken guarantee is reported first — matching DEC-021/DEC-022 ordering).
 *
 * A predicate that THROWS counts as a failure, not as a method error: the guarantee could not be
 * established. The thrown value is carried on `error` for the message and for the fuzzer's report.
 */
export function evaluatePostconditions(
    posts: ReadonlyArray<Postcondition>,
    result: unknown,
    args: ReadonlyArray<unknown>,
): PostconditionResult {
    for (const p of posts) {
        let satisfied = false;
        let error: unknown;
        try { satisfied = p.predicate(result, ...(args as any[])); }
        catch (e) { satisfied = false; error = e; }
        if (!satisfied) return {ok: false, failed: p, error};
    }
    return {ok: true};
}

/** Violation message. Redacts the result by default (DEC-030); returns has no @Sensitive site (Q-23). */
export function postconditionMessage(
    owner: string,
    member: string,
    failed: Postcondition,
    result: unknown,
): string {
    const clause = failed.description ? `the postcondition "${failed.description}"` : 'its postcondition';
    const shown = shouldDiscloseValue(false) ? String(result) : REDACTED;
    return `Postcondition failed: ${owner}.${member} did not satisfy ${clause}; returned ${shown}`;
}
```

`shouldDiscloseValue(false)` is exactly what `Verify.that` passes for an imperative check
(`Verify.ts:88`) — there is no `@Sensitive` marking possible on a return value (Q-23), so disclosure
follows the global switch alone and the value is `[REDACTED]` by default. Zero new redaction surface.

---

## 3. The `@Ensures` decorator — it records, it does not install

`src/MethodDecorators/Ensures.ts` (new). It is a **recording** method decorator, structurally the
sibling of a parameter decorator (`CreateConstraintDecorator`), *not* an installing one like `@Time`.

```ts
// src/MethodDecorators/Ensures.ts
import {MethodKey, recordPostcondition, PostconditionPredicate} from '../Core/ContractRegistry';
import {notePendingContract} from '../Core/ContractDiagnostics';

/**
 * Record a postcondition on a method. The predicate receives the return value first, then the
 * arguments the method was actually called with:
 *
 *   @Contract()
 *   class Wallet {
 *       @Ensures((balance, amount) => balance >= amount, 'balance covers the withdrawal')
 *       withdraw(amount: number): number { ... }
 *   }
 *
 * Like every contract, it is RECORDED here and INSTALLED by @Contract() (or @Validate()). Forgetting
 * @Contract() leaves it recorded-but-unenforced — the standard dev-mode warning fires (it calls
 * notePendingContract, same as parameter decorators).
 *
 * For an async method the predicate is checked against the RESOLVED value, not the Promise (§5).
 */
export function Ensures(predicate: PostconditionPredicate, description?: string): MethodDecorator {
    if (typeof predicate !== 'function') {
        throw new TypeError('@Ensures: expected a (result, ...args) => boolean predicate');
    }
    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(`@Ensures must be applied to a method; ${String(propertyKey)} is not one.`);
        }
        // 'prepend' — method decorators stack bottom-up under __decorate, so prepending lands
        // multiple @Ensures in declaration order (DEC-015/DEC-017), matching stageCheck's unshift.
        recordPostcondition(target, propertyKey, {predicate, description}, 'prepend');
        notePendingContract(target, propertyKey);
        return descriptor; // unchanged — recording only, no wrapper here
    } as MethodDecorator;
}
```

Two things this deliberately does **not** do, both consistent with the parameter-decorator precedent:

- It does not `registerContractedClass`. Enumeration is the installer's job (DEC-016); a parameter
  decorator does not enumerate either. `@Contract()`/`@Validate()` enumerate.
- It does not install a wrapper. Installing at method-decoration time would fight `@Contract()` and
  the trust gate, and would reintroduce ordering hazards with parameter decorators.

Export from `index.ts` in the "Method decorators" group (line ~118, next to `Time`).

---

## 4. The seam — where a postcondition is *literally* code after `proceed()`

The mechanism is almost entirely already present. `enforcementBehavior`
(`ContractInstaller.ts:300`) is the `MethodBehavior` `@Contract()` installs. Today it is
gate → check-params → proceed. v1 makes it gate → check-params → proceed(capture) → check-post.

### 4.1 The extended behaviour

```ts
// src/Core/ContractInstaller.ts
function enforcementBehavior(
    enforce: ((context: InvocationContext) => void) | undefined,   // now may be undefined
    posts: ReadonlyArray<Postcondition>,                           // NEW
    host: object,
    key: MethodKey,
    trust: ContractTrust,
): MethodBehavior {
    const site: ViolationSite = { owner: ownerNameOf(host), member: /* key string */, trust };

    return function (context, proceed) {
        if (!shouldEnforce(trust)) return proceed();     // one gate, once, for BOTH pre and post

        if (enforce) {
            try { enforce(context); }
            catch (violation) { applyViolationPolicy(violation, site); }
        }

        const result = proceed();                        // OUTSIDE try — a method's own throw is not ours
        if (posts.length === 0) return result;

        if (isThenable(result)) {
            return Promise.resolve(result).then(value => {
                checkPostconditions(posts, value, context.args, site);
                return value;
            });
            // a rejected promise is NOT caught here → postconditions skip on rejection (§5)
        }
        checkPostconditions(posts, result, context.args, site);
        return result;
    };
}

function checkPostconditions(posts, result, args, site: ViolationSite): void {
    const outcome = evaluatePostconditions(posts, result, args);
    if (outcome.ok) return;
    const message = postconditionMessage(site.owner, site.member, outcome.failed, result);
    applyViolationPolicy(new Error(message), site);      // throw / warn / handler — same routing as pre
}
```

`isThenable` is the same three-line duck-type `@Time` uses (`Time.ts:192`); copy it or lift it to a
shared helper. `posts` is resolved **once at install time** (`getEffectivePostconditions(host, key)`),
never per call — the same "everything expensive at install" rule `buildParameterEnforcement` follows.

### 4.2 Wiring `installOn` / `installMethod` / `Validate` to notice postconditions

`installOn` (`ContractInstaller.ts:238`) collects the keys to install from two sources today; add the
third band:

```ts
getContracts(host).forEach((_c, key) => own.add(key));
getStagedMethodKeys(host).forEach(key => own.add(key));
getPostconditionKeys(host).forEach(key => own.add(key));          // NEW

// ...and in the inherited set:
getEffectivePostconditionKeys(host).forEach(key => inherited.add(key)); // NEW
```

`installMethod` (`ContractInstaller.ts:266`) currently bails when there are no parameter constraints
(`if (!enforce) return`). It must now proceed when there are postconditions:

```ts
function installMethod(host, key, trust): void {
    if (isInstalled(host, key)) return;
    const original = findMethod(host, key);
    if (!original) throw /* unchanged */;

    const enforce = buildParameterEnforcement(host, key, original);      // may be undefined
    const posts = getEffectivePostconditions(host, key);                 // may be empty
    if (!enforce && posts.length === 0) return;                          // nothing to install

    installMethodWrapper(host, key, enforcementBehavior(enforce, posts, host, key, trust));
    noteInstalled(host, key);
}
```

`@Validate()` (`ContractInstaller.ts:153`) gets the mirror change: build `posts`, and install the
combined behaviour when either preconditions or postconditions exist (today it returns early on
`!enforce`). `noteInstalled`/`markInstalled` already handle the "no registry `MethodContract` entry"
case correctly — a postcondition-only method has no `MethodContract`, so `markInstalled` is skipped
(guarded by `if (getContract(host, key))` at `ContractInstaller.ts:359`) while `installedByHost` and
`noteContractInstalled` still fire. That is exactly the staged-closure treatment (SMELL-14) and needs
no new code.

---

## 5. Throw / async / Observable / ordering — the defaults, argued

**When the method throws → postconditions do NOT run. The exception propagates untouched.**
This is the pragmatic *and* the classically-correct default:
- A postcondition is a promise about the **return value**. A throw means there is no return value, and
  the method has already signalled failure. Running `result => …` with no result would just NPE.
- The seam is explicitly built so "an exception thrown by the method itself is the caller's business
  and must propagate with its stack untouched" (`MethodDecoratorFactory.ts:83-86`); `proceed()` stays
  outside every `try`. Postconditions honour that: they sit *after* a successful `proceed()`.
- **For fuzzing this is the right separation.** A throw is surfaced to the fuzz driver as a raw
  exception; the driver decides whether it is an expected/documented rejection or a bug. The
  postcondition oracle firing is reserved for "returned a value that violates the guarantee" — an
  unambiguous defect. (Exceptional postconditions — "on throw, guarantee X" — are a purist extension,
  deferred §7.)

**Async → await the Promise, then check the resolved value.** Non-negotiable, for the reason `@Time`
exists: checking `result => result.id > 0` against a *Promise object* reads `Promise.id` (undefined)
and is "a number that looks like an answer" (`Time.ts:22-30`). The seam detects a thenable and returns
`Promise.resolve(result).then(value => { check(value); return value; })`, mirroring `timeThenable`
(`Time.ts:234`). **A rejected Promise skips postconditions** — the async twin of the sync-throw rule —
and the rejection propagates. An async postcondition violation surfaces as a **rejected Promise**
carrying the postcondition `Error`, which is the correct and expected shape.

**Observables → checked as the returned value, synchronously; real settling support is DEFERRED.**
`@Time` handles Observables through a guarded lazy `rxjs` require (`Time.ts:329`), but rxjs is no
longer a dependency (DEC-019) and "the result satisfies P" over a *multi-value* stream is not one
check the way "time to settle" is. v1 does **not** special-case Observables: an Observable is a
non-thenable object, so the postcondition predicate receives the Observable itself. That is rarely
what you want, so it is **called out loudly** in the `@Ensures` docs as a known weak spot, with
`@Time`'s subscribe-time wrapper as the template for the eventual fix. The fuzzer targets sync and
async methods for v1 regardless. Deliberately *not* pulling rxjs back in for this.

**Ordering.** Within one wrapper, preconditions run before `proceed()`, postconditions after — one
gate, one violation policy for both. Across *decorators* (`@Time` + `@Contract`), nesting order already
decides whether timing includes contract checks (`Time.ts:160-161`); postconditions add nothing new.
Multiple `@Ensures` on one method run in **declaration order** (the `'prepend'` normalisation);
inherited postconditions run **base-most first** (DEC-021/DEC-022 ordering, and covariant strengthening
means this is unambiguously correct here).

**One documented ordering caveat for `@Validate()` + `@Ensures()`.** Parameter decorators are `__param`
entries placed last in the `__decorate` array (applied first), so they always record before
`@Validate()` runs. `@Ensures` is an ordinary method decorator interleaved with `@Validate()` by source
order, so `@Ensures` must sit **below** `@Validate()` (applied first) for `@Validate()` to see it.
`@Contract()` (class-level, runs last unconditionally) has no such caveat and is the recommended form
for postconditions. State this in the `@Ensures` docs; do not engineer around it in v1.

---

## 6. Violation reporting — reuse, don't reinvent

A postcondition failure **is** a contract violation, so it rides the machinery that already exists:

- **Routing:** `applyViolationPolicy(error, site)` (`Configuration.ts:269`) — `'throw'` (default),
  `'warn'` (logs, proceeds — the method result is still returned), or a handler. Identical to how
  precondition violations route. `ViolationSite` is built once at install, same as today.
- **Redaction:** `postconditionMessage` renders the result via `shouldDiscloseValue(false)` +
  `REDACTED` (DEC-030). Absent/false ⇒ `[REDACTED]`; `setValueDisclosure('all')` ⇒ raw value. No new
  config, no new setter, no `@Sensitive` plumbing (returns can't be marked — Q-23 — so `sensitive` is
  constant `false`, exactly like `Verify.that`).
- **Trust gate:** postconditions run under the method/class `shouldEnforce(trust)` gate, once per call,
  shared with preconditions. In production a `trust: 'assert'` method skips both pre and post; the
  default `guard` keeps both. Per-category trust (a separate trust for postconditions) is explicitly
  the deferred `categories` axis DEC-008 already declined to build.

New surface introduced by reporting: **one message-builder function.** That is the entire cost.

---

## 7. Deferred — explicitly, with reasons

Each of these is a real DbC feature and each is genuinely *not needed* for a v1 that unblocks fuzzing.

| Deferred | Why it's out of v1 | What it would cost |
|---|---|---|
| **`old()` state capture** | The single most expensive DbC feature. Needs snapshotting referenced state *before* `proceed()` and threading it into the predicate — a capture API, a decision on deep vs shallow copy, and a predicate shape change. **Fuzzing does not need it:** relate-output-to-*input* (`result >= amount`) covers the bulk of useful oracles and is expressible with `(result, ...args)` today. `old()` buys relate-output-to-*prior-state*, which is a smaller and later need. | New capture protocol, predicate-shape change, copy-semantics ruling. The purist plan owns this. |
| **Invariants** (class-wide, checked around every method) | A different mechanism (wrap *every* method, check a class-level predicate before and after), not a postcondition. DEC-021 already frames field constraints as invariants enforced by setters; a general method-boundary invariant is separate scope. Nothing in the fuzzing oracle needs it. | A new decorator + wrap-all-methods installer pass. |
| **`this`-state postconditions** | v1 predicate is `(result, ...args)` — no receiver. Access to final `this` without `old()` is weak (only absolute assertions like `this.length > 0`), and adding a receiver argument now would collide with the ergonomic arg-spread. Bundled with `old()` as "state postconditions." | Predicate-shape change; best done together with `old()`. |
| **Projectable / documentable postconditions** (write the reserved `post: ConstraintDescriptor[]`) | A closure is a black box (Q-3): no identity, no params, nothing for `docs`/`schema` to print. A *descriptor-shaped* postcondition (`@EnsuresResult(GreaterThan(0))` reusing a reified constraint on the return value) **is** projectable and would populate the reserved slot — but it's a nicety, not on the fuzzing critical path. The reserved slot stays reserved for exactly this. | A second decorator + a descriptor-on-return-value path. Additive later; nothing here blocks it. |
| **Behavioural-subtyping rules beyond union** | v1 uses conjunction across the chain (base-most first), which for postconditions is covariant strengthening — **already correct under classical DbC**, no tension (unlike preconditions, DEC-022). So there is nothing to *decide* here; the purist's contravariance debate simply doesn't arise for postconditions. Explicit weakening (`@Weakens`) stays a future additive mode. | Nothing for v1 — the default is the correct default. |
| **Observable settling** | §5. rxjs is not a dep (DEC-019); stream-postconditions are semantically unclear. `@Time`'s wrapper is the template when demand appears. | Re-introduce the guarded rxjs interop for a second decorator. |
| **Exceptional postconditions** ("on throw, guarantee X") | v1's default is "throw ⇒ skip post," which is what fuzzing wants (a throw is the driver's signal, not the oracle's). Exceptional postconditions are a purist extension. | A second predicate slot keyed on the thrown value. |

The through-line: **everything deferred is either not on the fuzzing critical path, or is already
correct-by-default and needs no decision.**

---

## 8. The fuzzer-facing interface — exact

A separate agent owns the fuzzing *vision*; this defines the **contract surface** that agent consumes.
The fuzzer never touches the runtime wrapper — it reads the band and evaluates the oracle itself, so
enforcement config (trust gate, production stripping) cannot silence the oracle.

**What the fuzzer consumes, per contracted class `C` (from `getContractedClasses()`) and per method
`m` (from `getContractsForClass(C)`):**

1. **Argument generators** — from each parameter's `constraints[j].arbitrary?.()`
   (`Descriptor.ts:139`). *This half is separately blocked on the fast-check bridge (IDEA-3, Q-3) and is
   not part of this plan.* For v1 the driver may restrict to methods whose parameters expose
   `arbitrary`, or accept a caller-supplied generator.

2. **The oracle** — the postconditions in force on the method:

   ```ts
   import {getEffectivePostconditions} from './src/Core/ContractRegistry';
   import {evaluatePostconditions} from './src/Core/Postconditions';

   const posts = getEffectivePostconditions(C.prototype, 'm');   // base-most first, inheritance-aware
   const hasOracle = posts.length > 0;                            // 'in' check — is this method fuzzable?
   ```

3. **The evaluation loop** (the driver's inner step — the interface it codes against):

   ```ts
   // for each generated args tuple:
   const instance = makeInstance(C);            // driver's concern
   let result: unknown, threw: unknown;
   try { result = instance.m(...args); }
   catch (e) { threw = e; }

   if (threw !== undefined) {
       // NOT a postcondition failure. Driver classifies: expected rejection vs crash vs
       // precondition violation (a thrown adorn violation Error). The oracle does not fire on throws.
       record({kind: 'threw', args, error: threw});
       continue;
   }

   const outcome = await settle(result);        // await if thenable; §5
   const verdict = evaluatePostconditions(posts, outcome, args);
   if (!verdict.ok) {
       record({kind: 'counterexample', args, result: outcome, failed: verdict.failed, error: verdict.error});
   }
   ```

**The precise contract, stated once:** *the fuzzer calls the method with generated arguments and, on
normal return, asserts `evaluatePostconditions(getEffectivePostconditions(target, key), result, args)`
returns `{ok: true}`; a `{ok: false}` is a counterexample.* The runtime wrapper (§4) uses the identical
`evaluatePostconditions` call, so **the oracle the fuzzer checks is byte-for-byte the oracle enforced at
runtime** — one declaration, two consumers, no drift (DEC-006).

Notes the driver needs:
- Read via `getEffectivePostconditions` (inheritance-aware), not `getPostconditions` (own-only) — a
  subclass instance is bound by its ancestors' postconditions.
- The oracle is independent of installation and of the trust gate, so a postcondition-only class still
  yields an oracle even where enforcement would be stripped in production. (The class must still be
  *enumerated* — i.e. carry `@Contract()`/`@Validate()` — for the fuzzer to discover it, same as docs.)
- `args` passed to the oracle are the arguments the method actually received (post any precondition
  arg-mutation), because that is what `context.args` is; the fuzzer passes the same tuple it invoked
  with.

---

## 9. Sequencing — smallest first, each step independently shippable

**Commit 1 — the Q-11 writer (registry band + evaluator). This alone closes Q-11.**
Files: `src/Core/ContractRegistry.ts` (band, `recordPostcondition`, the four reads, reset wiring,
`Postcondition`/`PostconditionPredicate` types), new `src/Core/Postconditions.ts`
(`evaluatePostconditions`, `postconditionMessage`). No decorator, no installer change. Fully unit
testable at the registry level: record → `getPostconditions` → `getEffectivePostconditions` across a
2- and 3-deep hierarchy; `evaluatePostconditions` ok/fail/throwing-predicate. **This is the concrete
unblock — a writer now populates postconditions and the fuzzer's read exists — even before anything
runs them.**

**Commit 2 — `@Ensures` records.** File: new `src/MethodDecorators/Ensures.ts`; export from
`index.ts`. Testable in isolation: decorating a method puts the closure in the band with the right
`description`; `notePendingContract` fires; multiple `@Ensures` land in declaration order.

**Commit 3 — the seam runs them.** File: `src/Core/ContractInstaller.ts` (`enforcementBehavior` takes
`posts` and checks after `proceed()`; `installOn`/`installMethod`/`Validate` notice the band; copy
`isThenable`). Now end-to-end: `@Contract() class { @Ensures(r => r > 0) m() { return -1 } }` throws on
call; async resolves-then-checks; throw skips; `'warn'` proceeds; production `assert` strips.

**Commit 4 (optional, tiny) — expose the fuzzer read.** Export `getEffectivePostconditions` and
`evaluatePostconditions` from `index.ts` (registry-introspection group) so the fuzz projection can
import them as public, semver-relevant surface (Q-6). No new logic.

The ordering is forced by dependency: 2 needs the writer from 1; 3 needs both. 1 is the smallest and is
shippable on its own. Nothing here removes or rewrites existing behaviour — every change is additive,
so each commit is safe to land independently.

---

## 10. Test strategy

Colocated `*.test.ts`, `ts-jest` (DEC-004). Standard reset in `beforeEach`: `resetRegistry()`,
`resetConfiguration()`, `resetValueDisclosure()`, `resetContractDiagnostics()`. Declare contracted
classes **inside** each test (module-scope classes survive `resetRegistry`, and field-style enforcement
reads the registry live — the caveat at `ContractRegistry.ts:1088`).

- **Registry band** (`ContractRegistry.test.ts` additions): record/read own; effective union base-most
  first over 2- and 3-deep hierarchies; empty-level skip; own-vs-effective distinction; reset clears.
- **Evaluator** (`Postconditions.test.ts`): all-pass `{ok:true}`; first failure reported base-most
  first; throwing predicate ⇒ `{ok:false}` with `error` set; message redacts by default and discloses
  under `setValueDisclosure('all')`.
- **`@Ensures`** (`Ensures.test.ts`): records into the band; declaration order for stacked `@Ensures`;
  `notePendingContract` fires (assert via `flushContractDiagnostics` + a sink); non-method target
  throws.
- **Seam** (`ContractInstaller` / new `postconditions.integration.test.ts`): sync violation throws;
  sync pass returns; **throw skips postcondition and propagates original error unchanged** (assert the
  thrown value is the method's, stack intact); **async resolves-then-checks** (violation ⇒ rejected
  Promise with the postcondition Error); **async rejection skips**; `'warn'` policy proceeds and returns
  the value; handler routing; `trust:'assert'` + production strips both; postcondition-only method (no
  param constraints) still installs and enforces; combined pre+post on one method; inheritance —
  subclass override checked against ancestor postconditions; `@Validate()` + `@Ensures` ordering caveat
  pinned as a characterization test.
- **Redaction** (extend `redaction`/message tests): default `[REDACTED]` in the postcondition message;
  proof-of-record that a class with no `@Sensitive` is still safe (DEC-030 ethic).
- **Fuzzer handoff** (a small `postconditions.oracle.test.ts`): the documented loop — read
  `getEffectivePostconditions`, call, `evaluatePostconditions` — and assert the verdict matches what the
  installed wrapper does for the same input (the no-drift property, made executable).

---

## 11. File-by-file change list

| File | Change | New/edit |
|---|---|---|
| `src/Core/ContractRegistry.ts` | `Postcondition`/`PostconditionPredicate` types; `postconditionsByTarget`; `recordPostcondition`; `getPostconditions`; `getEffectivePostconditions`; `getPostconditionKeys`; `getEffectivePostconditionKeys`; reset wiring | edit |
| `src/Core/Postconditions.ts` | `evaluatePostconditions`, `postconditionMessage` | **new** |
| `src/MethodDecorators/Ensures.ts` | `@Ensures(predicate, description?)` — records only | **new** |
| `src/Core/ContractInstaller.ts` | `enforcementBehavior` takes `posts`, checks after `proceed()` (sync + thenable); `installOn`/`installMethod`/`Validate` notice the band; local `isThenable` | edit |
| `index.ts` | export `Ensures` (method group); export `getEffectivePostconditions` + `evaluatePostconditions` (introspection group) | edit |
| `*.test.ts` (several) | per §10 | new/edit |

**Deliberately untouched:** `Descriptor.ts` (no descriptor-postconditions in v1), `docs.ts` /
`schema.ts` (closures aren't projectable — the reserved `post` slot stays empty and inert), the
`post: ConstraintDescriptor[]` slot's type, `Configuration.ts`, `redaction.ts` (reused as-is).

---

## 12. Known limitations shipped on purpose (state them in `docs/`, don't bury them)

- Postconditions are **invisible to `docs`/`schema`** — a closure has no printable identity (Q-3), the
  same accepted trade as `CreateSimpleDecorator`. If a postcondition needs to appear in an artifact,
  that is the deferred descriptor-postcondition path (§7).
- **No `old()`, no `this`-state, no invariants** — relate-to-input only.
- **Observable results are checked as the raw Observable** — settling support deferred (§5).
- **`@Validate()` + `@Ensures()` is order-sensitive**; `@Contract()` is the recommended form.
- **A throw is not a postcondition failure** — by design; the fuzz driver classifies throws.

Every one of these is on the far side of the "unblock fuzzing" bar. v1 clears the bar.
