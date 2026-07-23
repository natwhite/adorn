# Postconditions in adorn — a Design-by-Contract plan

> **Angle.** This plan designs postconditions as **first-class Design by Contract**, in the
> Meyer/Eiffel tradition surveyed in [`contract-driven-development.md`](contract-driven-development.md)
> §2. It is the *mirror* of the precondition work already shipped: preconditions are the client's
> obligation (DEC-022 makes overrides inherit them); postconditions are the supplier's obligation, and
> this document argues they are the **cleanest band in the whole system** — the one place where adorn's
> already-chosen inheritance mechanism is not a departure from Meyer but *exactly* Meyer.
>
> **Scope.** Planning only. No code changes. It is deliberately opinionated; a companion plan approaches
> the same feature from the fuzzing/oracle angle, and the orchestrator will contrast the two. Where the
> two lenses will most visibly diverge is flagged inline.

---

## 0. The rulings, up front

Six decisions this plan asks to ratify, each defended below:

1. **`@Ensures` is a method decorator over an `Outcome` model** — a predicate over `{result, args, self, old}`, not the single-value `(value) => boolean` a `ConstraintDescriptor` carries. The descriptor model does not stretch to cover a *relation*, and pretending it does would be dishonest (§1, §4).
2. **`old()` is author-declared and captured by value, never "clone the world."** The author names exactly which pre-state expressions matter; adorn snapshots them before `proceed()`. A `snapshot()` helper opts into deep-cloning where a mutable reference would otherwise be shared. This is Eiffel's `old expr`, and it inherits Eiffel's oldest footgun, stated loudly (§2).
3. **A postcondition holds only on *normal return*. On throw it is vacuous; on a Promise it is checked after the promise settles; on an Observable it is out of scope (Tier 3).** This falls straight out of the existing around-seam's rule that a method's own exception must propagate untouched (§1.3).
4. **Postcondition inheritance is Meyer, natively.** A subclass **strengthens** (conjoins) postconditions down the chain — which is *precisely* the union-base-most-first mechanism DEC-022 already built and `getEffectiveContract` already resolves. For preconditions that mechanism was a *considered departure* from contravariance (DEC-022 owns the tension). For postconditions it needs no special pleading at all: strengthening is the orthodox, safe direction, and "weakening is unexpressible" is the guarantee, not a compromise (§3). **This is the plan's central finding.**
5. **Postconditions split into two tiers of reifiability.** A *result-shape* postcondition (`Returns(GreaterThanEqual(0))`) is a genuine reified descriptor that projects into docs **and a schema of the return value**. A *relational* postcondition (`balance decreased`) is an inherently opaque hand-written predicate — SMELL-14's problem, in the `post` slot — that projects into documentation prose only. Be honest about which is which (§4).
6. **Blame is made first-class, and it sets the trust default.** A precondition failure blames the **caller**; a postcondition failure blames the **callee**. Because a postcondition audits your *own* code rather than untrusted input, its default trust is **`assert`** (stripped in production, like a C `assert`) where a precondition defaults to **`guard`** (survives production). This is DEC-008's own logic applied to the blame asymmetry (§5).

Invariants are **explicitly deferred** (IDEA-5), but scoped precisely and shown to sit *on top of* this machinery, so building postconditions first is the correct ordering (§6).

---

## 1. The semantics of `@Ensures`

### 1.1 A postcondition is a predicate over an *outcome*, not a value

Meyer's postcondition references three things: the **result**, the **arguments**, and the **prior
state** (`old`). `contract-driven-development.md` §2.1 states it as "what the routine guarantees
*after* it returns, *provided* the precondition held… frequently reference[s] the result and the
*prior* state (hence `old()`)."

adorn's reified constraint is a `Predicate = (value: unknown) => boolean` (`Descriptor.ts:72`). That
shape is a *unary* value test. A postcondition is intrinsically *n-ary*: it relates the return to the
inputs and to a snapshot of the object taken before the call. **The descriptor model does not cover
this, and §4 argues it should not be forced to.** The postcondition predicate needs its own shape:

```ts
// src/Core/Postcondition.ts (new)

/** Everything a postcondition predicate is allowed to see. Frozen before the check runs. */
export interface Outcome<R = unknown, S = unknown, O = Record<string, unknown>> {
    /** The (settled) return value. For a Promise result, the resolved value — see §1.4. */
    readonly result: R;
    /** The arguments the method was called with, post-precondition. */
    readonly args: readonly unknown[];
    /** The receiver (`this`). `undefined` for a detached/static call, exactly as the wrapper sees it. */
    readonly self: S;
    /** Pre-state snapshot, captured before `proceed()` — see §2. `{}` when nothing was captured. */
    readonly old: O;
}

/** Returns `true` when the method *kept its promise*. Must be pure and total, like every predicate. */
export type PostconditionPredicate = (outcome: Outcome) => boolean;
```

### 1.2 The `@Ensures` shape

`@Ensures` is a **method** decorator (a postcondition is about the method as a whole, not one
parameter). Consistent with DEC-014, it **records** into the registry's `post` slot; `@Contract()` /
`@Validate()` **install** the enforcement. Two authoring forms, matching the two reifiability tiers:

```ts
class Account {
    // (a) result-shape: reuse an existing value-constraint, retargeted to the return value.
    //     Fully reified — projects into docs AND a return schema (§4).
    @Ensures(Returns(GreaterThanEqual(0)))
    balanceAfter(): number { ... }

    // (b) relational: a hand-written predicate over result/args/old. Opaque (§4).
    @Ensures({
        describe: 'the balance strictly decreases',
        capture: ({ self }) => ({ balance: self.balance }),   // the `old()` expressions (§2)
        check:   ({ self, old }) => self.balance < old.balance,
    })
    withdraw(@GreaterThan(0) amount: number): void { ... }
}
```

`Returns(descriptor)` is the bridge: it wraps a `ConstraintDescriptor` into a
`PostconditionDescriptor` whose subject is `outcome.result`, reusing the descriptor's `predicate`,
`params`, `describe()`, and `schema()` unchanged. `@Returns(GreaterThanEqual(0))` is offered as sugar
for `@Ensures(Returns(GreaterThanEqual(0)))`, because "the return satisfies constraint X" is the
common case and deserves a one-liner.

The recorded datum:

```ts
export interface PostconditionDescriptor {
    /** 'result' when it reifies a value-constraint on the return; 'relation' when hand-written. */
    readonly subject: 'result' | 'relation';
    /** Identity for projections, e.g. 'returns:min' or an author tag. */
    readonly constraint: string;
    /** Human phrase: "returns a number >= 0" / "the balance strictly decreases". */
    readonly describe: () => string;
    /** The oracle. */
    readonly check: PostconditionPredicate;
    /** `old()` capture, evaluated *before* proceed. Absent when the postcondition needs no prior state. */
    readonly capture?: (pre: { self: unknown; args: readonly unknown[] }) => Record<string, unknown>;
    /** Present only for subject:'result' — the params the wrapped descriptor was built from. */
    readonly params?: ConstraintParams;
    /** Return-schema fragment. Present only for subject:'result' with a schema() hook. */
    readonly schema?: () => JsonObject;
    /** Violation message. Redacts the result by default (§5, DEC-030). */
    readonly message: (ctx: PostViolationContext) => string;
}
```

### 1.3 What a postcondition means for a method that throws

**It is vacuous.** Meyer's postcondition is a promise about *normal termination*; a routine that
raises does not return a result, so there is nothing for a postcondition to constrain. Eiffel routes
that case to `rescue`; `decorator-contracts` splits `@ensures` from `@rescue` for exactly this reason
(`contract-driven-development.md` §1.6).

This aligns *perfectly* with the seam adorn already has. `MethodDecoratorFactory` documents that it
"does **not** wrap `proceed()` in a `try`/`catch`. An exception thrown by the *method itself* is the
caller's business and must propagate with its stack untouched" (`MethodDecoratorFactory.ts:83-86`).
So the postcondition weave is: capture `old`, call `proceed()` **outside** any try/catch, and run the
post-checks **only on the normal-return path**. A throw skips every postcondition and propagates
unchanged. No new philosophy — the existing one already says the right thing.

**One honest limit this creates (§3.4 revisits it as an LSP hole):** a method that *throws where its
contract promised a value* is, in spirit, a postcondition violation — but vacuous-on-throw will not
catch it, because there is no result to test. Catching "threw instead of returned" needs a separate
*totality*/`@Rescue` clause, sketched in §5.3 and deliberately not built in the first tranche.

### 1.4 What a postcondition means for an async result

This is genuinely hard, and it is the same difficulty `@Time` already solved. A postcondition over a
`Promise<number>` cannot run when the method *returns the promise* — it must run when the promise
**settles**, against the resolved value. `Time.ts` classifies exactly this (`sync` / `thenable` /
`observable`) and stops its clock on settle.

Design:

| Result kind | Postcondition behaviour |
|---|---|
| synchronous value | checked immediately against `outcome.result`, then returned |
| thenable (`Promise`) | the wrapper returns `result.then(v => { check({result: v, ...}); return v; })`; a **rejection is vacuous** (the promise "threw") and re-throws unchecked |
| Observable / stream | **out of scope, Tier 3.** A stream has no single "result"; a per-emission or on-complete postcondition is a different contract shape. Pass through unchecked, and *say so* (never silently claim to have checked). |

Two subtleties to record rather than gloss:

- **`old` is captured synchronously before `proceed()`, but the check runs after settle.** `outcome.old`
  therefore correctly reflects true pre-call state, but `outcome.self` is read at *check* time — if
  other async work mutated the receiver between return and settle, `self` has drifted. This is
  unavoidable (there is no "the state at the moment of resolution" adorn can freeze without cloning
  `this` on settle) and must be documented: **`old` is a snapshot; `self` is live.**
- **Async postconditions need the async result classifier that `@Time` hand-rolls.** That is the
  second consumer of the unbuilt `ResultAdapter` (P1.7 / SMELL-15). Two consumers is the bar for
  building the shared abstraction; §8 schedules it.

This async story is exactly where the two planners are most likely to diverge: the fuzzing lens may
prefer to keep the first tranche **synchronous-only** (a fuzzer can drive sync methods and get an
oracle immediately, and async re-wrapping is pure cost until the fuzzer is async-aware). From the DbC
lens the async semantics are part of *what a postcondition means* and must at least be *specified* now
even if Observables ship later — a contract system that silently no-ops on `Promise`-returning methods
would be claiming a guarantee it does not enforce, which is the DEC-006 failure mode.

---

## 2. `old()` — the mechanism, and its traps

### 2.1 Author-declared capture, not "clone the world"

The tempting design is to deep-clone everything reachable from `this` before every call, so any
`old.anything` works. **Reject it**, for the same reasons every serious system does:

- **Unbounded cost** on the hot path — most of the cloned graph is never read by the postcondition.
- **It breaks on the interesting inputs** — cycles, functions, class identity, live handles.
- It is the opposite of DEC-020's governing principle: *put the decision where the information is.*
  Only the author knows which slice of prior state the postcondition compares against.

So `old()` is **author-declared**. A postcondition carries a `capture` thunk, evaluated once, *before*
`proceed()`, whose returned object becomes `outcome.old`:

```ts
@Ensures({
    describe: 'the queue grows by exactly one',
    capture: ({ self }) => ({ length: self.items.length }),   // named pre-state
    check:   ({ self, old }) => self.items.length === old.length + 1,
})
enqueue(item: T): void { ... }
```

This is `babel-plugin-contracts`' `old(account.balance)` and Eiffel's `old expr`: the author writes an
expression, adorn evaluates it early and hands back the value.

### 2.2 By-value capture, and the reference-sharing trap

Capture is **by value, not cloned.** For a primitive (`self.balance`, `self.items.length`) this is
correct and free. For a **mutable reference** it is Eiffel's oldest footgun:

```ts
// WRONG — captures the reference, then the method mutates the same object in place.
capture: ({ self }) => ({ acct: self.account }),
check:   ({ self, old }) => self.account.balance < old.acct.balance,   // always false: old.acct IS self.account
```

adorn cannot fix this silently (it does not know which references the method mutates), so it does two
things: **documents it loudly**, and ships an explicit escape:

```ts
import { snapshot } from 'adorn';
capture: ({ self }) => ({ acct: snapshot(self.account) }),   // defensive deep copy
```

`snapshot()` is `structuredClone`-based. Its limits are stated, not hidden:

| Trap | Behaviour | Guidance |
|---|---|---|
| reference sharing | by-value capture aliases a mutable object | primitives are safe; wrap mutable refs in `snapshot()` |
| cost | `snapshot()` deep-copies; large graphs are expensive | capture the *narrowest* thing the check needs (a length, a sum), not the whole object |
| cyclic state | `structuredClone` handles cycles fine | no action needed |
| class instances | `structuredClone` returns **plain data** — prototype/methods lost | `old.acct instanceof Account` is `false`; read fields, don't call methods on `old` |
| non-cloneable (functions, handles) | `structuredClone` **throws** | capture the derived primitive instead (`self.handle.id`, not `self.handle`) |

The capture thunk must be **pure** — like every contract predicate (`contract-driven-development.md`
§2.5, "a contract that changes what it observes is worse than none"). A `capture` that mutates is a
bug adorn cannot detect and will not try to.

### 2.3 Capture cost is production-free by construction

Because postconditions default to `trust: 'assert'` (§5), and the gate `shouldEnforce(trust)` is
evaluated **once at the top of the wrapper** before anything (`Configuration.ts:157`,
`ContractInstaller.ts:312-313`), a production build with `assert` stripped never evaluates the capture
thunk at all. The `old()` cost — the genuinely expensive part of postconditions — is therefore a
development-time cost by default. This is the DEC-008 trust model paying off exactly where it should.

---

## 3. Behavioural subtyping — the rigorous mirror of DEC-022

This is where the DbC lens earns its keep, so it is done carefully.

### 3.1 Meyer's two rules, stated precisely

For a routine `r` redefined in a subclass (`contract-driven-development.md` §2.5, "subclasses may
*weaken* preconditions and *strengthen* postconditions/invariants, never the reverse"):

- **Precondition (contravariant):** effective `pre' = pre OR pre_child` (`require else`). The child may
  accept a *wider* range of inputs. Safe because any input a parent-client supplies (satisfying `pre`)
  is still accepted.
- **Postcondition (covariant):** effective `post' = post AND post_child` (`ensure then`). The child
  must deliver *at least* what the parent promised, and may promise more. Safe because any guarantee a
  parent-client relies on (`post`) still holds.

### 3.2 What adorn already chose, and why postconditions get Meyer for free

DEC-021/DEC-022 resolve inheritance by **union down the prototype chain, base-most first**, with
weakening *structurally unexpressible* (storage is own-scoped; resolution concatenates every list;
there is no write API that reaches an ancestor). Union of predicates is logical AND.

- For **preconditions**, AND is *strengthening*, i.e. the **opposite** of Meyer's contravariant `OR`.
  DEC-022 is explicit that this is "a considered departure from classical DbC," defensible on
  substitutability-first grounds but not attributable to Meyer, and it records the tension honestly
  (`DECISIONS.md` DEC-022 "The theoretical tension, recorded honestly").
- For **postconditions**, AND is *strengthening*, which **is** Meyer's `ensure then`, exactly.

So the single mechanism that is un-Meyer for `pre` is orthodox-Meyer for `post`. **The registry already
knows this.** `getEffectiveContract` concatenates `post` base-most first
(`ContractRegistry.ts:434-440`), and its own comment states the reasoning: "a postcondition strengthens
covariantly even under classical DbC, so a future writer inherits the right behaviour rather than a
placeholder." That comment is the seed of this whole section: **postcondition inheritance is already
implemented and already correct.** Q-11 is not "design inheritance for postconditions"; it is "add a
writer, an enforcement weave, and a projection to machinery that already resolves the chain the right
way."

### 3.3 Why this is the strongest possible endorsement of the DEC-022 mechanism

DEC-022 took on a theoretical debt: it strengthens preconditions where Meyer weakens them, and had to
argue its way out of the contradiction (it could not borrow DEC-021's "a field constraint is really an
invariant" escape, because a parameter precondition genuinely *is* a Meyer precondition). A skeptic of
DEC-022 could reasonably ask whether the union mechanism was chosen for principled reasons or merely
because it was the cheapest thing to build for fields and got copied to methods.

Postconditions answer that. The **same** union mechanism, applied to the band where Meyer's rule points
the *other* way from preconditions, turns out to be **exactly** Meyer with **no** departure and **no**
special pleading. That the mechanism lands on orthodox behaviour in the one band where orthodoxy and
adorn's substitutability instinct coincide is strong evidence the mechanism is principled, not
accidental. Postconditions are the cleanest band in the system precisely because nothing has to be
argued: strengthen-only *is* the guarantee, and "weakening is unexpressible" is the feature.

### 3.4 Two rigorous wrinkles, stated not glossed

- **The combined subtype relation.** With `pre` strengthened (departure) and `post` strengthened
  (orthodox), adorn's subtype *narrows both ends* going down the chain. That is internally coherent —
  a subclass's total contract is uniformly tighter — but note it is not full classical LSP, because
  classical LSP *widens* the input end. When the opt-in precondition-weakening feature DEC-022 reserves
  (`@Weakens`, a disjunction) eventually lands, `pre`-weaken + `post`-strengthen together give textbook
  Meyer. Postconditions need no such opt-in: strengthening is already the default and already correct.
- **The throw-instead-of-return LSP hole (from §1.3).** Meyer forbids a subtype from throwing where the
  supertype promised to return — that breaks the postcondition "terminates normally satisfying `post`."
  adorn's vacuous-on-throw semantics will *not* catch this: an override that throws skips the inherited
  postcondition rather than failing it. This is a real gap. Closing it needs a *totality* clause ("this
  method returns normally for all inputs satisfying its precondition"), which is the `@Rescue`/`nothrow`
  companion in §5.3. It is deferred, but it is named here so it is not mistaken for a bug later.

### 3.5 `old()` under inheritance

Each postcondition clause carries its own `capture` thunk. The union just concatenates clauses
base-most first; every clause's `capture` is evaluated before `proceed()`, so an inherited
postcondition's `old` snapshot is taken correctly for the subclass call. No new mechanism — capture is
per-clause, and clauses compose by the same concatenation `getEffectiveContract` already does.

---

## 4. Reification and projection — where the descriptor model earns its limits

### 4.1 Two tiers, honestly labelled

**Tier A — result-shape postconditions (`subject: 'result'`).** "The return value satisfies constraint
X, independent of args and old." These are *not a new kind of thing at all*: they are an existing
`ConstraintDescriptor` (`GreaterThanEqual(0)`, `Between(1,10)`, `NotEmpty()`) pointed at
`outcome.result` instead of a parameter. `Returns(descriptor)` reuses the descriptor's derived
`predicate`, its `params`, its `describe()`, and its `schema()` verbatim. Everything DEC-010 guarantees
for a parameter constraint — params-derived predicate, no drift, JSON round-trip — holds unchanged.
**Fully reified.**

**Tier B — relational postconditions (`subject: 'relation'`).** "The result relates to args/old" —
sorted, decreased, same-length-as-input, idempotent. The *relationship is the predicate*; there are no
`params` to derive it from, and DEC-010's "derive predicate from params" has nothing to bite on. These
are hand-written closures — **the exact shape of SMELL-14** (`CreateSimpleDecorator` closures that
"carry no identity and no params… invisible to every projection"), now living in the `post` slot. They
carry an author-supplied `describe` string and a `check` closure, and nothing more can be mechanically
extracted from them.

This split is the honest answer to "can a postcondition be a descriptor with a params-derived
predicate (DEC-010)?" — **sometimes** (Tier A), and **fundamentally not** (Tier B). Forcing Tier B into
the `params → predicate` mold would require inventing a params vocabulary for arbitrary relations,
which is the constraint-algebra premature-abstraction DEC-010 and plan-risk-10 both warn against.

### 4.2 What each tier projects into

| Projection | Tier A (result-shape) | Tier B (relational) |
|---|---|---|
| **Documentation** | renders `describe()`: *"Ensures: returns a number ≥ 0"* | renders the author `describe` string, flagged opaque (the SMELL-14 caveat, made visible) |
| **Schema of the return** | emits a JSON Schema fragment for the return value (§4.3) | contributes `{}` — under-claim (DEC-029): a schema that over-claims is worse than none |
| **Fuzzing oracle** | usable oracle *and* a return-arbitrary | usable oracle at runtime, opaque to generation (Q-3) |

The documentation projection is nearly free: `MethodDoc` **already carries `pre` and `post`**
(`docs.ts:166-167`), populated from the registry but never rendered because no writer exists. Rendering
`post` is a new "Ensures" section mirroring the parameter table — the model is already there, only the
renderer branch is missing (and it was left unrendered deliberately because "an unreachable render
branch is untestable"; a writer makes it reachable and testable).

### 4.3 The new projection worth naming: a schema of the *return*

adorn already projects parameter constraints into JSON Schema (`schema.ts`, DEC-029). A result-shape
postcondition is a value-constraint on the return, so it projects the **return-value schema** by the
identical mechanism — the mirror image. In DEC-029's structure (methods ride under annotation keywords),
this rides under a `returns` keyword per method:

```jsonc
{ "methods": { "balanceAfter": { "returns": { "type": "number", "minimum": 0 } } } }
```

That is the response-schema half of an OpenAPI path — the artifact "one declaration, four artifacts"
(DEC-006) has been unable to produce because it had no source for what a method *returns*. Postconditions
are that source. This is the concrete payoff that makes result-shape postconditions worth building even
before the fuzzer exists: they complete the schema projection's story, not just the docs one. (OpenAPI
*paths* still need arity, Q-10; return schemas are independent of that and land immediately.)

Q-23 (a method **return** cannot be marked `@Sensitive`) gets its answer as a side effect: once the
return is a first-class subject with an enforcement site, a method-level `@Sensitive` naturally means
"the return is sensitive," read at the postcondition site to resolve disclosure (§5). Not required for
the first tranche — the default already redacts — but the door it was locked out of is now open.

### 4.4 Where the descriptor model *strains*, said plainly

The `ConstraintDescriptor` was built for unary value tests. Tier B postconditions are not unary and not
value tests, so they do **not** fit it — and the plan does not pretend they do. They get their own
`PostconditionDescriptor` shape (§1.2) that is a *superset in intent* but shares almost nothing
mechanically with `ConstraintDescriptor` beyond `describe()` and `message()`. The registry's `post`
slot, currently typed `ReadonlyArray<ConstraintDescriptor>`, must be **retyped** to
`ReadonlyArray<PostconditionDescriptor>`. That is a small, honest change; the alternative — cramming a
relation into a value-predicate — is the drift-adjacent dishonesty (Q-4) the whole reified model exists
to avoid.

---

## 5. Blame

### 5.1 The asymmetry, and making it first-class

`contract-driven-development.md` §2.1 is explicit: "a precondition failure blames the caller, a
postcondition failure blames the callee." Racket is the canonical enforcer; adorn currently does **not**
distinguish — every violation is a uniform `Value Error: … expected … but received …` from
`Descriptor.formatMessage`, and the `ViolationSite` carries only `{owner, member, trust}`
(`Configuration.ts:74-80`). A precondition failure *is* the caller's fault, but the message reads as a
generic value error, and there is no machinery to say a postcondition failure is a **bug in the method**.

Make it first-class. `ViolationSite` gains `blame: 'caller' | 'callee'`; the postcondition message shape
frames supplier fault distinctly from client fault:

- Precondition: *`Task.send(message)`: caller supplied an argument violating the contract — expected `message` to be a string of length ≥ 5.* (blame: caller)
- Postcondition: *`Account.withdraw` broke its contract: it must ensure the balance strictly decreases, but did not. This is a bug in `withdraw`, not in the call.* (blame: callee)

This routes through the existing violation policy unchanged (`applyViolationPolicy`,
`setViolationPolicy`) — `blame` is just another field on the `ViolationSite` a handler receives, so
telemetry can split "our callers are misusing us" from "we shipped a bug" without any new plumbing.

### 5.2 Blame sets the trust default — and it is principled, not arbitrary

DEC-008's whole argument is that a precondition guarding **untrusted external input** must not be
stripped in production (`guard`), while an **internal self-check** may be (`assert`). A postcondition is
the definitional internal self-check: it audits the method's *own* output against its *own* promise. It
is a C `assert` in the most literal sense — `contract-driven-development.md` §2.5, "internal invariants
often can [be disabled]"; and DEC-008, "internal self-checks and invariants commonly can [be stripped]."

Therefore:

- **Precondition default trust: `guard`** (unchanged — survives production; blames the caller; guards untrusted input).
- **Postcondition default trust: `assert`** (stripped in production by default; blames the callee; guards against your own bugs).

This is not a new knob — it reuses `ContractTrust` and `shouldEnforce` verbatim. `@Ensures` accepts the
same `TrustOptions` `@Contract`/`@Validate` do, so an author who *wants* a postcondition enforced in
production (a paranoid invariant on a critical path) writes `@Ensures(..., { trust: 'guard' })` and
opts back in deliberately. The default falls out of the blame direction, which falls out of Meyer. Three
things adorn already had — trust, the gate, the once-per-call evaluation — compose into the right
default with no new mechanism.

### 5.3 The `@Rescue`/totality companion (deferred, named)

The throw-instead-of-return hole (§1.3, §3.4) is closed by a *totality* clause: an assertion that a
method returns normally for all inputs satisfying its precondition, i.e. it does not throw. This is
Eiffel's `rescue` and `decorator-contracts`' `@rescue` region. It is a distinct clause (it fires on the
*exception* path, which postconditions deliberately do not touch), and it is **deferred** — named here
so the postcondition semantics are complete on paper even though the first tranche only ships the
normal-return half.

---

## 6. Invariants — deferred, but scoped precisely

Invariants are postconditions' companion (`contract-driven-development.md` §2.1, IDEA-5). They are
**explicitly deferred**, but the reasoning matters because it determines build order.

### 6.1 What already exists, and what does not

- **Field-assignment invariants already ship.** DEC-021 is explicit that a field constraint *is* a
  class invariant — "a consistency constraint that holds for every instance across its observable
  lifetime… re-checked on every write." `@Enforce.greaterThanEqual(0) balance` is a per-field invariant,
  covariant (strengthen-only) down the chain, already correct.
- **Whole-object *relational* invariants do not** — "balance ≤ creditLimit" spanning two fields, checked
  at every public boundary. There is no field-by-field way to express a cross-field invariant.

### 6.2 Why a relational invariant is (almost) "a postcondition on every method"

A whole-object invariant `I(self)` is semantically: *`I` holds after construction, and after every
public method returns.* That is a **`self`-only relational postcondition hoisted onto every method**,
plus a post-construction check. So the postcondition machinery in this plan is the correct substrate:
build postconditions first, and an invariant becomes "an `@Ensures({check: ({self}) => I(self)})`
attached to every public method automatically, plus a constructor hook." Building postconditions first
does not foreclose invariants; it is the prerequisite for them.

### 6.3 The two blockers that keep invariants deferred

1. **No instantiation hook.** adorn installs by a class decorator that wraps prototype methods; it never
   intercepts `new`. An invariant must be checked *after construction*, and adorn has no per-instance
   constructor seam. `decorator-contracts` solves this with a `Proxy` + a static `.new()`
   (`contract-driven-development.md` §1.6) — a **different enforcement model** than adorn's
   method-rewriting, and one that changes how consumers instantiate. Adopting it is a real architectural
   decision (IDEA-5's "likely `Proxy`-based"), not an increment on postconditions.
2. **Re-entrancy.** Meyer: an invariant may be *temporarily broken inside* a routine and need only hold
   at public boundaries — so a public method that calls another public method on the same object must
   **not** re-check the invariant at the inner boundary (the outer call may be mid-mutation). This needs
   a per-instance "in a public call" depth flag so the invariant fires only at the *outermost* boundary.
   The precise rule is recorded here so a future implementer inherits it rather than rediscovering the
   classic nested-call false positive.

**Decision: invariants stay IDEA-5, deferred.** Postconditions are built first, deliberately, because
they are the substrate, they need no new enforcement model (they ride the existing around-seam), and
they deliver standalone value (return schemas, the fuzzing oracle) that invariants do not gate on.

---

## 7. The fuzzing oracle (in-lane note)

A postcondition is the oracle a fuzzer checks — the reason DEC-006 promoted postconditions "from a
nicety to a prerequisite" and vision.md's "the contract supplies both the generator and the oracle."
What this design hands a fuzzer, concretely:

- Per contracted method, the resolved `post` clauses (base-most-first union, §3), each evaluable against
  a generated `(result, args, old)` — the oracle for "did the method keep its promise," not merely "did
  it not throw."
- For Tier-A clauses, the return descriptor's `schema()`/`arbitrary()` hooks, so the fuzzer can also
  reason about the *shape of the return* (shrink toward a schema-valid result, or check the return
  against its own schema).
- The honest limit is inherited wholesale: Tier-B relational predicates are opaque to *generation*
  (Q-3) — the fuzzer can *check* them but cannot *derive inputs* from them. "Decorate your code, get a
  fuzz suite" remains partial by construction.

The fuzzing *vision* — arbitraries, shrinking, `fast-check` integration, coverage — belongs to the
companion planner. This plan's job is to guarantee the oracle exists and is correctly resolved across
inheritance; it does.

---

## 8. Concrete plan

### 8.1 The registry writer for the `post` slot (Q-11)

The one change that unblocks everything else. Mirror `recordParameterConstraint`:

```ts
// ContractRegistry.ts — retype the slot, add the writer.
export interface MethodContract {
    readonly params: ReadonlyArray<ParameterContract>;
    readonly pre:  ReadonlyArray<ConstraintDescriptor>;       // unchanged (cross-parameter, Tier 2)
    readonly post: ReadonlyArray<PostconditionDescriptor>;    // RETYPED from ConstraintDescriptor
    readonly installed: boolean;
}

/** Record a postcondition against a method. Base-most-first union is already handled by
 *  getEffectiveContract (ContractRegistry.ts:434-440); this only appends to the own-scoped list. */
export function recordPostcondition(
    target: ContractTarget,
    key: MethodKey,
    descriptor: PostconditionDescriptor,
    position: ConstraintPosition = 'append',
): void { /* methodEntry(target,key).post ... push/unshift, same shape as recordParameterConstraint */ }
```

`getEffectiveContract` already concatenates `post` correctly, so **no inheritance code is written** —
it exists. The writer is deliberately **not** exported from `index.ts` (Q-6: writers stay internal so
callers cannot bypass the adapter), matching how `recordParameterConstraint` is handled.

### 8.2 Files

| File | Change |
|---|---|
| `src/Core/Postcondition.ts` *(new)* | `Outcome`, `PostconditionPredicate`, `PostconditionDescriptor`, `PostViolationContext`; `snapshot()` helper (`structuredClone` wrapper with the §2.2 caveats in its doc); `Returns(descriptor)` bridge. Decorator-agnostic (DEC-012) — imports no decorator type. |
| `src/Core/ContractRegistry.ts` | Retype `post` (§8.1); add `recordPostcondition` + its mutable-twin plumbing. |
| `src/MethodDecorators/Ensures.ts` *(new)* | `@Ensures(...postconditions)` and `@Returns(descriptor)` sugar — **record** into the registry, mirroring `CreateConstraintDecorator`. Adapter layer (touches `target`/`propertyKey`). |
| `src/Core/ResultAdapter.ts` *(new, P1.7)* | Classify `sync`/`thenable`/`observable`, shared with `@Time`. Postconditions are the second consumer that justifies extracting it (SMELL-15 anticipated this). |
| `src/Core/ContractInstaller.ts` | Extend `enforcementBehavior`: after the precondition check and `proceed()`, run `buildPostconditionEnforcement` on the normal-return path with async classification (§8.3). Postcondition trust resolves to `assert` by default (§5.2). |
| `src/Core/Configuration.ts` | Add `blame: 'caller' \| 'callee'` to `ViolationSite`; default postcondition trust `assert`. |
| `src/Core/Descriptor.ts` | `formatMessage` already redacts by default (DEC-030); add a postcondition message variant that redacts the **result** and frames callee-blame (§5). |
| `src/Projections/docs.ts` | Render the `post` slot — a new "Ensures" section; the `MethodDoc.post` model field already exists (`docs.ts:167`). |
| `src/Projections/schema.ts` | Emit the `returns` schema from Tier-A postconditions (§4.3, DEC-029 merge/under-claim policy reused). |
| `index.ts` | Export `Ensures`, `Returns`, `snapshot`, and the `PostconditionDescriptor` type. Writers stay unexported (Q-6). |

### 8.3 The enforcement weave (the load-bearing edit)

In `ContractInstaller.enforcementBehavior`'s returned `MethodBehavior`:

```ts
return function (context, proceed) {
    if (!shouldEnforce(trust)) return proceed();            // gate once, at top (DEC-008) — also skips capture

    try { enforcePre(context); }                            // preconditions — blame: caller
    catch (v) { applyViolationPolicy(v, callerSite); }

    if (post.length === 0) return proceed();

    const old = capturePre(post, context);                 // §2 — BEFORE proceed
    const result = proceed();                               // OUTSIDE try/catch — a method throw is vacuous (§1.3)
    return checkPost(result, context, old, post, calleeSite);  // sync/thenable classify (§1.4); blame: callee
};
```

`checkPost` uses `ResultAdapter`: sync → check now, return; thenable → `result.then(v => (check(v), v))`
with rejection passed through unchecked; observable → pass through, unchecked, Tier 3. Every
postcondition violation routes through `applyViolationPolicy` with `calleeSite` (blame: callee), so
`'throw'`/`'warn'`/handler policies all work identically to preconditions.

### 8.4 Phasing

1. **P-post.1 — registry + docs.** `PostconditionDescriptor`, `recordPostcondition`, `@Ensures`
   recording only, docs "Ensures" section. Tier A + Tier B both *recordable and documentable*; no
   enforcement yet (rendered `installed: false`, the honest recorded-but-unenforced state the docs
   renderer already surfaces loudly). Lowest-risk, proves the shape end-to-end exactly as docs did for
   parameters.
2. **P-post.2 — synchronous enforcement.** Weave `checkPost` for the `sync` case; blame + trust
   defaults; postcondition messages with result redaction. This is a *complete, useful* DbC feature for
   all synchronous methods and the fuzzer's first oracle.
3. **P-post.3 — the return schema.** Tier-A → `returns` schema (§4.3). Pure projection, no runtime risk;
   completes the schema story.
4. **P-post.4 — async.** `ResultAdapter` extraction (shared with `@Time`), thenable postconditions.
   Observables and the `@Rescue` totality clause remain deferred and *documented as unchecked*, never
   silently no-op.

---

## 9. Honest limits and the open questions this raises

- **Q-5 stands.** Postcondition *expressiveness*, not plumbing, is the hard part: a useful relational
  postcondition can be as hard to write correctly as the method it describes, and adoption may stall
  there regardless of tooling. This plan makes them *possible and safe*, not *easy*.
- **Q-3 is inherited, not solved.** Tier-B relational predicates are opaque to input generation. The
  fuzzer can check them; it cannot derive arbitraries from them.
- **SMELL-14 gains a second home.** Relational postconditions are opaque closures in the `post` slot,
  exactly as `CreateSimpleDecorator` closures are in the parameter staging table. `getContractsForClass`
  and the docs projection must flag Tier-B as "runtime-checked, not machine-analysable," or repeat the
  "looks complete, is not" failure DEC-016 rejects.
- **Async `self` drift** (§1.4) and the **throw-instead-of-return LSP hole** (§3.4) are real, named,
  and deferred — not bugs to be surprised by later.
- **Invariants (IDEA-5) are gated on an instantiation hook adorn does not have** (§6.3), which is a
  different enforcement model (Proxy) and a separate decision.
- **Q-23 is answerable** as a side effect once the return is a first-class subject (§4.3), but is not
  required for the safe default (the result is redacted by default regardless).

The headline the DbC lens wants on the record: **postcondition inheritance is already built and already
Meyer-correct** (`getEffectiveContract`'s base-most-first `post` union). The mechanism DEC-022 had to
*defend* for preconditions is the mechanism postconditions get to *inherit for free* — and that it lands
on orthodox Meyer in the one band where orthodoxy and adorn's substitutability instinct agree is the
strongest evidence that the mechanism was principled all along.
