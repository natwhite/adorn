# adorn — Decision Log

Architectural and directional decisions, with the reasoning that produced them and the consequences accepted alongside them. Lightweight ADR format.

> **Maintenance convention:** this file is kept current as work proceeds. Any choice that constrains later work gets an entry — including choices left deliberately **open**, so the open question is visible rather than implicit. Bugs, smells, and gaps go in [ISSUES.md](ISSUES.md) instead.

**Status legend:** `ACCEPTED` · `OPEN` (decision required) · `SUPERSEDED` · `REJECTED`

---

## DEC-001 — `positive` rejects `< 0`, not `<= 0`
**Status:** **SUPERSEDED** by DEC-020 · 2026-07-19 · commit `a2ddc5f`

**Retained deliberately.** This entry is the reason DEC-020 exists — the record of the first of three attempts to answer a question that had no answer. Deleting it would hide the pattern that justifies the removal.

**Context.** `Verify.positive` threw when the value *was* positive — an inverted condition contradicting its own error message. Fixing it required choosing a boundary.

**Decision.** Reject `value < 0`, matching the existing sibling `Positive` parameter decorator.

**Consequences.** Internal consistency is preserved, but `0` is accepted as "positive," so the name and the semantics disagree. Left unresolved and tracked as **Q-1**; whichever way it is settled must be applied across `Positive`, `Verify.positive`, and any future `Negative`.

**What actually happened.** The boundary was flipped to strict (`> 0`) in Wave 3 as a user-visible break, and Q-1 stayed open anyway — because flipping it did not make the *name* say which side of zero it fell on. DEC-020 removes the constraint instead.

---

## DEC-020 — Constraints state their boundary; they do not name it
**Status:** ACCEPTED · user ruling · supersedes **DEC-001** · resolves **Q-1**

**Context.** `Positive()` was ambiguous about `0` for the whole of this project's life. It originally admitted `0` (DEC-001); Wave 3 made it strict, a user-visible break argued from the mirror pair `Positive`/`Negative` sharing a boundary under the lax reading; and Q-1 remained open across every wave in between. Both readings were defensible each time it was raised, and each ruling produced a name that still did not say what it did.

**Decision.** Remove `Positive`, `Negative`, `NonNegative` and `NonPositive` outright — from `src/Contracts/number.ts`, `src/ParameterDecorators/Constraints.ts`, `src/FieldDeocrators/Enforce.ts`, and `src/Validation/Verify.ts` (`Verify.positive` included, despite being pre-existing public surface). `GreaterThan` / `GreaterThanEqual` / `LessThan` / `LessThanEqual` / `Between` already existed and are the replacements:

    Positive()  ->  GreaterThan(0)          NonNegative()  ->  GreaterThanEqual(0)
    Negative()  ->  LessThan(0)             NonPositive()  ->  LessThanEqual(0)

**Rationale — resolution by design rather than by adjudication.** That the question was answered twice, differently, is the evidence that it is not answerable *at the constraint*. A name cannot carry a boundary, so `Positive` can only ever be a guess at what its author meant, and the reader has to go and look it up — which is precisely what a contract exists to make unnecessary. The intent is knowable in exactly one place: the call site. Putting the nuance about `0` back on the developer is not passing the buck, it is putting the decision where the information is. A developer who writes `GreaterThan(0)` or `GreaterThanEqual(0)` has stated which boundary they meant and cannot be surprised by it. Q-1 does not get settled; it becomes **unexpressible**.

The argument generalises past zero. A named constraint can only hard-code one arbitrary limit, so `Positive` is just the special case of `GreaterThan` that happens to have a word in English. There is no word for `GreaterThan(18)`, and adding names for the limits that happen to have one is not a vocabulary, it is a coincidence.

**No deprecation period, no aliases.** The package is `1.0.0` but is an unreleased prototype with no consumers, so the compatibility argument is hypothetical. More decisively: an alias has to forward to *some* boundary, which is the choice that could not be settled — `Positive = () => GreaterThan(0)` re-ships the ambiguity with a deprecation notice attached, and a caller reading `Positive()` in their own source still cannot tell what it does. The migration is mechanical and total; a half-removed vocabulary is worse than either end state.

**Consequences.**
- **Four constraint identities are gone from the registry.** Identity is what a documentation projection *prints*, so `positive` rendering "a positive number" is genuinely lost; that line now reads "a number greater than 0". Judged an improvement — it states the bound instead of implying it — and pinned by test in `src/Contracts/constraints.test.ts` rather than asserted here.
- **A JSON Schema projection is unaffected.** `Positive()` already carried `{exclusiveMin: 0}` and emitted `exclusiveMinimum`, which is exactly what `GreaterThan(0)` carries and emits. The params were never the ambiguous part.
- **`Verify.positive` is removed from the published surface.** Use `Verify.that(GreaterThan(0), key, value)`.
- **One projection test loses its subject.** `src/Projections/docs.test.ts` pinned that `positive` stayed distinct from `min` despite sharing a derivation; with the named constraints gone, no two built-ins share params under different identities, so that test is deleted rather than repointed. The *principle* — identity is what a projection prints — still holds and is documented in `number.ts`.
- **Q-7 and BUG-4 are untouched.** The `isNumeric` gate that makes `NaN`/`undefined` violate every numeric constraint sits in the shared derivations (`above`, `below`, `atLeast`, `atMost`), not in the removed identities, so totality survives by construction.
- **DEC-010 is unweakened.** Nothing gained a hand-written predicate; the replacements derive from params exactly as before.

---

## DEC-002 — `Enforce.generator` calls validators as `(value, key, target)`
**Status:** ACCEPTED · 2026-07-19 · commit `a2ddc5f`

**Context.** The setter called `func(target, key, v)` while its declared signature was `(v, k?, t?)` and its only consumer was written as `(v, k) => Verify.positive(k, v)`. The net effect was that the *target object* was validated instead of the assigned value.

**Decision.** Change the call site to `func(v, key, target)` so the arguments match the declared parameter names, leaving the consumer untouched.

**Consequences.** Fixes the wiring for all present and future consumers of `generator`. It does **not** make `Enforce` work — the accessor still has no getter and never stores the value (**BUG-1**).

---

## DEC-003 — Decorator model: dual-track, co-equal
**Status:** ACCEPTED · 2026-07-19 · source: `decorators-modernization.md`

**Context.** TC39 standard decorators (adopted by TypeScript 5.0) contain **no parameter decorators**, and TS 7.0.2 rejects them outright. The concern was that adorn's headline feature was pinned to a dying legacy mode.

Research showed the risk framing was wrong. `experimentalDecorators` is **not** deprecated: it is absent from the TypeScript 6.0 removal list, and the team deliberately ported the legacy emitter — including the `__param` helper adorn depends on — to the new Go compiler. Legacy parameter decorators compile and run on TS 7.0.2 GA with no deprecation diagnostic. Separately, the TC39 parameter-decorator proposal is **Stage 1**, last presented March 2023, with committee members on record opposing the motivating use case; the parent decorators proposal is itself back at **Stage 2.7**.

The real constraint is not survival but **reach**: `experimentalDecorators` is per-*compilation*, so the **consumer's** tsconfig governs. Projects on standard decorators cannot use adorn's parameter syntax at all, however healthy legacy mode is.

**Decision.** Dual-track. Keep per-parameter decorators on `experimentalDecorators` **and** build a method-level `@Contract({...})` API as a **co-equal** form — not a fallback. Precedent: `decorator-contracts` migrated this way in 2023; MikroORM v7 ships exactly this dual-adapter design over one engine.

**Consequences.** Two adapters to maintain. A **decorator-agnostic core becomes mandatory** — without it the dual track degenerates into two divergent implementations. The per-parameter form remains permanently non-standard. This resolves the implementation plan's decision gate to *both* branches rather than either.

**Noted irony.** The stalled Stage-1 proposal's design would be *better* than legacy — it would let adorn delete both its method-rewriting subsystem and its `toString()` name parsing. Adorn's most complex machinery exists to work around a gap a dormant proposal would close.

---

## DEC-004 — Test framework: ts-jest, not Vitest
**Status:** ACCEPTED (proposed) · source: `implementation-plan-t0-t1.md`

**Context.** The project has no real test suite (**GAP-1**), and contract code needs real assertions.

**Decision.** Use **ts-jest**. Vitest is rejected because it transforms via esbuild, and **esbuild permanently ignores `emitDecoratorMetadata`** by maintainer decision — which adorn's type metadata depends on.

**Consequences.** Heavier/slower than Vitest, accepted deliberately. Related toolchain constraints to respect: **Babel silently drops legacy parameter decorators** with no error, and esbuild `--minify` degrades recovered parameter names (**SMELL-1**).

---

## DEC-005 — Strict ordering: factory → registry install → delete the monkey-patch
**Status:** ACCEPTED · source: `implementation-plan-t0-t1.md`

**Context.** `OverrideObjectDefineProperty` looked like deletable cruft. It is not. Tracing `tslib`'s `__decorate` (`tslib.js:90-95`): for a parameter-decorated method TypeScript emits a 4-argument call with `desc === null`, so `__decorate` captures the original method descriptor *before* decorators run, and its trailing `Object.defineProperty(target, key, r)` **restores that original**, clobbering the wrapper adorn installed. The patch exists solely to swallow that call.

**Decision.** The patch may only be removed *after* a new installation path exists. Required order: build `MethodDecoratorFactory` → move to registry-driven install → then delete the patch. Removal and re-architecture are **one task, not two**.

**Consequences.** Deleting the patch early breaks parameter decorators outright. Testing must cover **both with and without `reflect-metadata` loaded**, since its presence flips `__decorate` to a different `Reflect.decorate` branch. The patch's collateral damage is tracked as **BUG-2**.

**Executed as specified.** P1.2 → P1.3 → P1.4 landed in that order, verified after each step. Two things the analysis got right and one it did not:

- The `__decorate` shape was confirmed unchanged on the TypeScript 6.0.3 emitter, and the hazard is live on **both** branches — `Reflect.decorate` does not define the property itself, so tslib still makes its own trailing write afterwards. Installation additionally exercises a *third* path the analysis did not mention: `__decorate([Contract()], Task)` is a two-argument call, which reflect-metadata dispatches to `DecorateConstructor` rather than `DecorateProperty`. All three are now covered by tests.
- The patch is not merely no longer *needed*; it is no longer *reachable*. Nothing writes to a method during member decoration, so there is nothing for `__decorate`'s trailing write to clobber.
- **The plan's stated verification for P1.4 does not exist to flip.** It expected "the §1.1 cross-feature regression test (param-decorated method + `@Enforce` field) flips from failing to passing". That test never failed — BUG-2 had already been re-scoped after three containment tests showed the leak did not reproduce. P1.4's real evidence is the positive assertion the plan lists second: `Object.defineProperty` is identity-stable across decoration, now checked on both branches.

---

## DEC-006 — Contracts as the single source of truth
**Status:** ACCEPTED · 2026-07-19 · user directive

**Context.** Previously ranked a far-horizon aspiration (Very High value, Very High difficulty). Elevated by the user to a primary project goal.

**Decision.** adorn's goal is that a properly decorated codebase yields **validation, documentation, tests, and fuzzing** from one declaration — the contract stops being only a runtime guard and becomes the source everything else descends from.

**Consequences — the load-bearing one:** a contract must become **data, not just behavior**. Today `Positive()` produces an opaque closure that throws; no doc line, OpenAPI constraint, or test generator can be derived from a closure. Constraints must be **reified descriptors** carrying kind, parameters, and message, with the predicate derived from or attached to the descriptor.

Follow-on consequences:
- **Scheduling:** the descriptor shape must be settled **before** the bulk of new constraints are authored. Writing ~15 constraints as closures and retrofitting later is precisely the rework to avoid.
- **Priority:** **postconditions are promoted from a nicety to a prerequisite.** Fuzzing needs an oracle; without postconditions or invariants, generated inputs only ever test "it didn't throw."
- **Positioning:** adorn stops competing with Zod as another validator and becomes a contract layer projecting into four artifacts. Nothing in the surveyed prior art does all four from one declaration.
- **Honest limit:** generating arbitraries for hand-written predicates is unsolved (**Q-3**); coverage will be partial by construction.

**Precedent to study.** `clojure.spec` (validation + generative testing from one declaration) is the closest model; `fast-check` is the JS property-testing target; `icontract` has relevant testing integration.

---

## DEC-007 — Artifact generation: runtime registry vs compile-time transformer
**Status:** ACCEPTED (recommended) · ratified in `implementation-plan-t0-t1.md` §9

**Context.** DEC-006 requires producing docs/specs/tests from contracts. Runtime decorators are not statically analyzable without executing the module, which is the standard objection to this whole approach.

**Recommendation (not yet ratified).** **Runtime-registry-first**: import the module, walk the registry, emit artifacts. Far lower cost than a TypeScript transformer, and "no build-tool lock-in" becomes a genuine differentiator against typia. Reach for a transformer only if type-*derived* contracts become desirable later.

**Consequences if adopted.** Artifact generation requires *loading* the target module — acceptable for most codebases, problematic for modules with import side effects.

---

## DEC-008 — Production toggling semantics
**Status:** ACCEPTED · landed in P3.2

**Context.** `Configuration` exists but is never consulted (**SMELL-4**). Every mature contract system makes checks toggleable — but a single boolean is unsafe.

**Open question (now answered).** Preconditions guarding *untrusted external* input generally must **not** be stripped; internal self-checks and invariants commonly can be. This requires per-contract or per-category semantics rather than one global switch. Tracked as **Q-2**.

**Decision.** Classify each contract by **trust**, in `src/Core/Configuration.ts`:

- `guard` — validates untrusted or external input. **Not removed by the production switch.** The only way to disable these is `disableGuardEnforcement({confirm: true, reason})`, which throws without both fields and logs a loud one-time warning when it succeeds. No environment variable, config file, or plain setter reaches it.
- `assert` — an internal self-check. Stripped in production by default, exactly like a C `assert`. `setAssertEnforcement(true | false | 'auto')` pins it either way; `'auto'` follows the mode.

`guard` is the default, so an author who says nothing gets a check that survives production and must *downgrade* deliberately. Trust is declared on the enforcement site — `@Contract({trust})` for a class, `@Validate({trust})` for one method — and resolved at install time. The gate is evaluated **once per call at the top of the wrapper**, not once per predicate, so a method with eight constraints pays for one boolean test.

Violation routing is separate from the gate: `setViolationPolicy('throw' | 'warn' | handler)`. `'warn'` logs and **proceeds into the method**, which is what makes it usable for staging a new contract over live traffic. A handler that returns suppresses; one that throws escalates. A failure thrown by the *method itself* never enters this path.

**Granularity, deliberately limited.** Trust is per enforcement site, not per constraint. Trust answers *why a check exists* — "this method sits at a boundary and is handed input it did not produce" — which is a property of the method's role, not of any individual `min: 0` within it; a method whose first parameter is a `guard` and second an `assert` describes a half-trusted boundary, which is not a thing. Per-constraint trust is a pure extension (record a trust alongside the constraint, take the strictest on the path) and should wait for real demand. The plan's `categories: {parameter, field, postcondition, concern}` axis is likewise **not built**: `parameter` is the only category that exists, so three of its four keys would be dead configuration nothing could set meaningfully and no test could exercise. Plan risk 10 names this layer specifically.

**Consequences.** `DecoratorConfiguration.ErrorOnFieldConstraintMismatch` is superseded and now documented as inert; the file is retained only as a migration shim and should be deleted once the field path (P2.1) is rebuilt on the real configuration. Trust becomes authoring surface, so it is semver-relevant alongside the registry reads (Q-6). Enforcement is now *conditional*, which means a generated document should eventually say whether a contract survives production — currently it does not, and that is a gap rather than a disagreement.

---

## DEC-016 — Installation implies enumeration, in **both** bands
**Status:** ACCEPTED · source: **Q-12** (methods), **BUG-16** (fields) · landed alongside P3.2, extended to fields afterwards

**Context.** `@Contract()` called `registerContractedClass`; `@Validate()` did not. A class using only the per-method form was therefore **enforced at runtime yet absent from `getContractedClasses()`** — invisible to documentation and, later, to fuzzing. Both readings were defensible: enumeration could mean *"deliberately published"*, which made `@Validate()` a fine-grained opt-in that opted out of visibility too; or any installation could imply enumeration.

**Decision.** **Any installation implies enumeration.** `@Validate()` registers its owning class, resolved from the constructor for a static member and from `target.constructor` for an instance member. `getContractedClasses()` now means *"classes adorn has installed enforcement on"*.

### Extended to the field band (BUG-16)

This decision was originally written about methods only, and the omission was not noticed because it produces no symptom. **Field decorators install at decoration time and called `registerContractedClass` nowhere** — its only production call sites were `ContractInstaller.ts:120,196`, i.e. `@Contract()` and `@Validate()`. A class whose *only* contracts were fields was therefore enforced at runtime and absent from `documentContracts()` / `generateMarkdown()`, which is the identical asymmetry this entry exists to reject, left standing in the other band.

What kept it hidden is worth recording, because it is a general hazard for this project: **`documentClass(Ctor)` reported such a class perfectly.** Every direct test of the projection passed. Only enumeration — the path a real documentation *run* takes — was short. A gap that is invisible to the obvious test and visible only to the whole-pipeline path is exactly the shape DEC-006 makes expensive.

`installFieldContract` now registers its owning class, so the rule reads the same in both bands: *any installation implies enumeration*. `installFieldContracts(ctor)` registers unconditionally, matching `installContracts`.

**One guard the method path did not need.** `installFieldContract` is a public imperative entry point whose target is not always a class — hand it a plain `{}` and `target.constructor` is `Object`. Registering that would put `Object` into the enumerable registry and every projection would then try to document it. A non-function target therefore enumerates only when it genuinely is the `prototype` of the constructor it names; a detached `Object.create(proto)` correctly registers nothing, being an object with contracted fields rather than a class.

**Test changed:** `src/Projections/docs.decorators.test.ts` — *"a field-only class is NOT enumerated without `@Contract()` — a registry-level gap"* pinned the bug and was **inverted**, with the reasoning recorded inline. Its second assertion (`documentClass` reports the class in full) is unchanged, since that is the half that always worked and the half that hid the gap.

**Rationale.** The deciding argument is not ergonomics, it is that the two failure modes are not symmetric. An unenforced contract eventually surfaces — something gets through and the bug is found. A contract that is enforced but **missing from a generated artifact** never surfaces: nothing throws, and the artifact looks complete. The plan calls that out as strictly the worse of the two (§8), and under DEC-006 the artifacts are the product. Adorn must not guarantee something at runtime that it will not admit to in a document.

There is also no real use case on the other side. Nobody wants "enforced but undocumented" as a *property*; they want fine-grained installation, which `@Validate()` still provides. Excluding a class from a generated artifact is a projection-level filter, and an enforcement decorator is the wrong lever for it.

**Consequences.** A class carrying `@Validate()` on one method now appears in documentation with its *uncovered* sibling methods listed and flagged `installed: false`. That is a more useful document than one silently omitting the class, and it is exactly the recorded-but-unenforced case the docs renderer already surfaces loudly. Registration is unconditional — it does not wait for there to be something to install — matching `@Contract()`, which already enumerated a constraint-free class. The strong-reference cost of DEC-011 now extends to `@Validate()`-only classes; `setClassEnumerationEnabled(false)` remains the opt-out.

**Test changed:** `test/contract-installation.test.ts` — *"does NOT register the class for projection"* asserted the opposite and was inverted, with the reasoning recorded inline. Two tests were added covering registration with no constraints yet, and the uncovered-sibling case.

---

## DEC-021 — A subclass may strengthen a field contract, never weaken it
**Status:** ACCEPTED · source: **Q-14** · user ruling

> **Numbering note.** This ruling was commissioned as "DEC-020", but DEC-020 was taken concurrently by the named-boundary constraint removal (Q-1) and is already referenced from `src/Contracts/number.ts`, `src/Validation/Verify.ts`, `src/ParameterDecorators/Constraints.ts` and `src/FieldDeocrators/Enforce.ts`. Renumbering that entry would have required editing four files this work did not own, so this one took the next free number instead.

**Context.** A subclass redeclaring a decorated field **replaced** its parent's contract. The field store is own-scoped, matching `ContractRegistry`, so `class Sub extends Base` declaring `@Enforce.greaterThanEqual(0) value` over a base `@Enforce.greaterThanEqual(10) value` enforced only `>= 0`. A test labelled `OPEN QUESTION` pinned that in each of two files. Whether a subclass should inherit, strengthen, or be forbidden from weakening was left explicitly undecided rather than invented by the implementer.

**Decision.** **A subclass may strengthen (add) constraints on an inherited field, and can never weaken them.** Inherited constraints always continue to apply; a subclass's declarations are **additive**.

The authoring convention that goes with the ruling — a contract-driven superclass should impose constraints *only where genuinely needed*, leaving inheritors room to set their own limits — is **guidance for documentation, not something adorn enforces**. There is no way to detect "constrained more than necessary", and a warning that fires on correct code is worse than none.

### The mechanism is structural: union, not comparison

Constraints are resolved by walking the prototype chain and **concatenating** every declaration found (`getEffectiveFieldConstraints`). Storage stays own-scoped: a declaration is only ever written to the object it was written on, and there is no write API that takes an ancestor. So a subclass can only ever add conjuncts to its own list, and the resolved set can only grow as you descend. Union of predicates is logical AND, and adding a conjunct is monotonically strengthening.

**Weakening is therefore not detected and rejected — it is unexpressible.** That is the whole point of choosing this shape. The alternative was to compare a subclass's descriptor against its parent's and reject the weaker, which fails for a reason that is not fixable: **relative strength of two arbitrary predicates is undecidable in general.** Such a check could only work for built-in constraints whose params happen to be comparable (`min: 10` vs `min: 0`), and would have to silently pass everything else — a guard that is thorough on easy cases and silent on hard ones, which is the "looks complete, is not" failure DEC-016 rejects.

A consequence worth stating plainly: an attempt to weaken does not produce a diagnostic. `@Enforce.greaterThanEqual(0)` over an inherited `>= 10` is simply redundant — the effective contract stays `>= 10`. If the subclass's *initializer* violates the inherited bound, that surfaces at class-evaluation time, which is the earliest moment it can be known.

### Why this is the opposite of Meyer, and still correct

Classical Design by Contract says a subclass may **weaken** preconditions (contravariance) and **strengthen** postconditions and invariants. This ruling is the opposite for fields, and a future reader will be tempted to "fix" it back. They should not.

**A field constraint is a class invariant, not a precondition.** The distinction is what the constraint is *about*, and it is visible in when the check runs. A precondition guards *one call* and is a demand the supplier makes of its client — so a subclass accepting a wider range of inputs still satisfies every client written against the parent, which is exactly why contravariance is safe. A field constraint guards *every assignment for the whole life of the object*; it is a statement about which states the object may be in, and it is re-checked on every write with no call boundary involved. That is Meyer's own definition of a class invariant: "a consistency constraint that holds for every instance across its observable lifetime… characteriz[ing] the class as a whole rather than its individual routines" (`contract-driven-development.md` §2.4, §2.5).

And invariants are **covariant** in classical DbC — a subclass must preserve them and may strengthen them. So this ruling does not contradict Meyer; it applies the correct one of his three rules. The apparent contradiction comes from adorn's implementation (a field constraint is enforced by a *setter*, which looks like a precondition on an assignment) rather than from its semantics. §2.5 of the reference document lists behavioural subtyping as something ad-hoc guard clauses get wrong; this is the field half of getting it right.

The user's framing arrives at the same place from the substitutability side: constraints imposed on a parent are there for a reason and must not be subvertible. If `Base` guarantees `count > 0`, code holding a `Base` reference is entitled to rely on it, and handing that code a `Sub` that permits `-1` breaks the guarantee — which is the Liskov violation, whatever the constraint is called.

### Consequences

- **Ordering is base-most first.** A violation reports the most general broken constraint first, matching how a reader scans a hierarchy top-down and making a subclass's additions read as additions. Within a level, declaration order is unchanged (DEC-017).
- **Projections report the union.** `getFieldContractsForClass` walks the chain and includes inherited fields — including fields a subclass never mentions, and an ancestor's constraints on a field it redeclares. Reporting only own declarations would put a generated document *behind* what is enforced, recreating BUG-16 in the same change that fixed it. A redeclared field is listed **once**, since two declarations are one contract once resolved.
- **Own-scoped reads remain**, renamed in intent rather than removed: `getFieldConstraints` / `getFieldContract` mean *declared here*, `getEffectiveFieldConstraints` / `getEffectiveFieldContract` mean *in force here*. Both questions are real — a document distinguishing a subclass's own additions from what it inherits needs the first — but reading the own-scoped one and assuming it describes runtime behaviour is now a mistake, so the names say which is which.
- **Cost on the hot path.** Resolution is one `WeakMap` hit per prototype level on every assignment. The common case — no contracted ancestor — returns the stored array with no copy. Nothing is memoised: field enforcement reads the registry on every assignment by design (SMELL-18), and caching resolved chains would make a later `Object.setPrototypeOf` silently enforce the wrong contract.
- **`installed` and `type` come from the nearest declaration**, not merged, because both describe the accessor a read or write actually reaches. `type` falls through to the nearest ancestor that has one, so a subclass compiled without `emitDecoratorMetadata` degrades to the parent's type rather than to none.

**Scope — methods were deliberately not covered here, and are now settled separately.** Whether an overridden *method*'s parameter constraints needed an equivalent rule was tracked as **Q-15** and is resolved by **DEC-022**, which adopts the same union-down-the-chain mechanism. It arrived at the same shape but **not by the same argument**, and the difference matters: a parameter constraint genuinely *is* a Meyer precondition, so the "this is an invariant, and invariants are covariant" reasoning below is **not available** in the method band. DEC-022 is a considered departure from classical contravariance rather than an application of Meyer, and says so.

**Tests changed:** both `OPEN QUESTION` tests were **inverted deliberately**, in `test/field-decorators.test.ts` and `src/Core/FieldDecoratorFactory.test.ts`, with the reasoning recorded inline at each. Added coverage: base-before-subclass reporting order, a restated-looser bound, a subclass initializer violating an inherited constraint, a three-deep hierarchy, statics, and the plain-object chain (proving the union is a registry property, not a class-syntax one).

---

## DEC-022 — An overridden method inherits its parent's parameter preconditions
**Status:** ACCEPTED · source: **Q-15** · user ruling (with one labelled inference) · parallel of **DEC-021**

**Context.** Overriding a contracted method was a **silent way to delete its contract**. Verified, not inferred: with `@Contract() class Base { send(@StringMinLength(5) m) {} }`, a subclass that merely overrode `send` *with no decorators at all* accepted `'ab'`. Redeclaring a weaker constraint replaced the parent's outright. An override in a subclass without `@Contract()` was unchecked too. Only the un-overridden case stayed guarded — and by accident, because the wrapper on the base prototype is still what a call reaches through the chain.

The cause was own-scoping. `getContracts` is keyed by the exact object, `installOn` enumerated only own keys, and `planChecks` read only the own contract — so a subclass prototype with no entry produced no key, no wrapper, and no checks.

**Decision.** **Effective constraints at a method are the union of every declaration on the prototype chain, base-most first** — exactly the shape DEC-021 gave fields. A subclass may strengthen an inherited precondition and can never weaken it.

> **The user's ruling was:** *"undecorated overrides should inherit the parent's constraints."*

### The decorated-override case is an inference, labelled as one

The user ruled on the *undecorated* override. That a **decorated** override also unions with its parent — rather than replacing it — is **an inference drawn here, not a user ruling**, and it is recorded as such so a later reader can reopen it knowing which part carries the user's authority.

The reasoning:

- It is consistent with DEC-021 and with the user's stated Q-14 rationale: limits imposed on a parent *"must be there for a reason and not subverted"*.
- The alternative is **incoherent**. If an undecorated override inherits but a decorated one replaces, then adding a single decorator to an override silently removes the parent's *other* constraints — so `@GreaterThan(0)` added to an override would delete an inherited `@LessThan(100)` that the author never mentioned and probably never read. That is a worse trap than the bug being fixed, and it is triggered by an edit that looks purely additive.

### The theoretical tension, recorded honestly

DEC-021 could argue that a field constraint is not really a precondition at all — it is a **class invariant**, so conjunction is plainly the right rule and Meyer agrees. **That argument is not available here.** A method parameter constraint genuinely *is* a Meyer precondition, and classical DbC permits a subclass to **weaken** preconditions contravariantly, by disjunction (`parent_pre OR child_pre`). Contravariance is safe there for a real reason: a subclass accepting a *wider* range of inputs still satisfies every client written against the parent.

**This ruling forecloses that, deliberately.** It is a considered departure from classical DbC for the method band, not an application of it, and it should not be described as "what Meyer says". Two things bound the departure:

- **Explicit weakening remains an additive future feature**, not a reversal. An opt-in disjunction — some `@Weakens(...)` form where a subclass states plainly that it accepts more than its parent — is compatible with everything here: it would be a *second* resolution mode requested at the declaration, and the default would stay conjunction. Nothing in this decision has to be undone to add it.
- **No reading of DbC endorsed the old behaviour.** Even under full contravariance, an override *declaring nothing* should inherit its parent's precondition unchanged, not clear it. `icontract` and `decorator-contracts` both implement weakening as an **explicit disjunction**, and neither treats "declare nothing" as "check nothing". The bug fixed here was not a defensible reading of contravariance; it was the absence of any reading.

### Mechanism — the same structural union as DEC-021

Storage stays **own-scoped**: a declaration is only ever recorded against the object it was written on, and there is no write API that takes an ancestor. Resolution concatenates every list found walking the chain (`getEffectiveParameterConstraints`, `getEffectiveContract`). A subclass can therefore only add conjuncts to its own list, so the resolved set grows monotonically as you descend, and **weakening is unexpressible rather than rejected**. Comparing descriptors for relative strength was rejected for the reason DEC-021 gives: it is undecidable for arbitrary predicates, so it could only work for built-ins with comparable params and would silently pass everything else.

**"Declares nothing" vs "declares an empty one"** — the crux of the undecorated case — is settled in two places, deliberately not one:

1. **The union keys on *has constraints*, not on *has a registry entry*.** A level whose parameter list is empty is skipped exactly as a level with no entry is. This matters because an entry can exist without declaring anything: `setParameterMetadata` and `markInstalled` both create one. Keying on entry-presence would let such a phantom masquerade as "declares an empty precondition, therefore replaces the parent" — which is the original bug wearing a different hat.
2. **Nothing conjures an own entry for an override that declares nothing.** Signature capture stays own-scoped and gated on an own entry already existing, and `markInstalled` was already gated the same way. So `getContracts(Sub.prototype)` remains the honest answer to *"what does this class declare?"*, while `getEffectiveContract` answers *"what is in force here?"*. This is the rule GAP-9 already set for the field band: installation must not conjure an empty contract into a document.

### Installation: install on an override, not on plain inheritance

`installOn` now consults the chain as well as own keys, and installs a key found only on an ancestor **when the host owns the method**. The own-ness test does work in both directions:

- **Owned (an override).** The base's wrapper is shadowed and unreachable, so a wrapper must be installed here or the inherited constraints are lost. This is the fix.
- **Not owned (plain inheritance).** The base's wrapper is still what the call reaches, so it is already enforced. Installing anyway would check every inherited constraint **twice** and conjure an own property onto a prototype that had none — changing `Object.getOwnPropertyNames` and re-attributing violation messages from the declaring class to the inheriting one. Enforcing an inherited implementation is the declaring class's job.

A key that is owned but is not a plain method is skipped rather than throwing, because the recorded constraint belongs to an ancestor and the "no such method" diagnostic would blame a declaration this class's author never wrote. Own keys keep the existing throw, where the blame is correct.

**Both key bands, not just the prototype.** `Object.getPrototypeOf(Sub) === Base` for `class Sub extends Base`, so the constructor band walks the same chain and static overrides are covered by the same code. Checking only the prototype would have left half the bug in place — it was verified broken for statics before the fix and verified fixed after.

**Hand-written closures are included.** `CreateSimpleDecorator` checks are staged adapter-side and never reach the registry (SMELL-14), so the staging table got the same chain-walking read. Leaving it own-scoped would have kept Q-15 alive for precisely the authoring form that is already invisible to every projection — the one where it is hardest to notice.

### What happens when the subclass lacks `@Contract()`

**Unchanged: the override is unenforced.** This is stated as a limit rather than presented as a decision, because it is not a policy choice — it is mechanical. A `class Sub extends Base` carrying no adorn decorator of any kind runs **no adorn code at any point in its evaluation**. There is no hook at subclass definition, so there is no moment at which a wrapper could be installed, and nothing to warn from either.

This is the residue of DEC-014: `@Contract()` is the installer, and forgetting it disables every contract on the class. DEC-022 narrows the hole substantially — an *annotated* subclass can no longer shed a contract by overriding — but it cannot close it.

**The diagnostic remains truthful, and was checked rather than assumed.** Where the subclass decorates its override but forgets `@Contract()`, the parameter decorator does run, the pending set knows about the class, and the existing warning fires naming `Sub` and `send`; its claim that the constraints *"will never run"* is still exactly true. Where the subclass carries no decorator at all, the warning does not fire — correctly, since it is a *class*-scoped diagnostic about declarations that were made, and this class made none. Neither case produces a message that overstates what adorn did. A diagnostic that could catch the second case would have to hook class definition globally, which adorn has no mechanism for and which would fire on every class in the program.

### Consequences

- **Ordering is base-most first**, matching DEC-021. A violation reports the most general broken constraint first, which is how a reader scans a hierarchy top-down and makes a subclass's additions read as additions. Within a level, declaration order is unchanged (DEC-017). Note the visible consequence: a subclass violating both its own and its parent's constraint now reports the **parent's** message where it used to report the subclass's.
- **Violation messages name the class that overrode**, not the declaring class, because the wrapper is installed on the subclass and that is the method that actually runs. Plain inheritance still names the declaring class, since no wrapper is installed on the subclass — the two differ, and correctly so.
- **Projections report the union.** `getContractsForClass` walks the chain, exactly as `getFieldContractsForClass` has since DEC-021, and for the reason DEC-016 gives: reporting only own declarations would put a generated document *behind* what is enforced. That is the enforced-but-undocumented asymmetry BUG-16 was, and it never surfaces on its own because nothing throws to reveal it.
- **Own-scoped reads remain, and are now load-bearing for a different question.** `getContract` / `getContracts` mean *declared here*; `getEffectiveContract` / `getEffectiveParameterConstraints` mean *in force here*. Reading the own-scoped one and assuming it describes runtime behaviour is a mistake, so the names say which is which — the naming rule DEC-021 established.
- **`super.foo(...)` in an override double-checks the inherited constraints** — once at the override's wrapper, once at the base's. Semantically harmless (the predicates are pure and idempotent, and if the override transforms arguments before delegating, the base's check correctly applies to the transformed values), but it is a real cost and is stated rather than left to be found.
- **Cost is at install time, not per call.** The chain walk happens once, inside `planChecks`; the compiled check list is closed over exactly as before, so a call pays nothing new. This is the opposite of the field band, which resolves on every assignment by design (SMELL-18).
- **`pre`/`post` union on the same rule.** Both are reserved and have no writer (Q-11), so this is inert today — but conjunction is independently correct for each (a cross-parameter precondition follows this ruling; a postcondition strengthens covariantly even under classical DbC), so a future writer inherits the right behaviour rather than a placeholder.

**Tests changed:** one inversion, named. `src/Core/ContractRegistry.test.ts` — *"is own-scoped, exactly as the per-target reads are"*, which asserted `getContractsForClass(Sub)` was `[]`, was **inverted deliberately** and renamed, with the reasoning recorded inline. It is the exact inverse of its field-band twin, which has asserted the union since DEC-021. Nothing else in the suite required a change: `contract-installation.test.ts`'s *"does not let a subclass corrupt its parent contract"* passes untouched, because its own-scoped registry assertions are still true and its `run(5)` case fails only the subclass's own bound. Added coverage: a 13-test `test/contract-inheritance.test.ts` (undecorated override, attempted weakening, strengthening, base-most reporting order, three-deep through a level declaring nothing, statics, hand-written closures, `@Validate()` on the override, no-double-wrap on plain inheritance, ancestor immutability, projection reporting, and both subclass-without-`@Contract()` cases), plus 8 registry-level tests for the effective reads.

---

## DEC-017 — Constraint order is normalised at record time, not plan time
**Status:** ACCEPTED · source: **SMELL-13** · supersedes the residue of DEC-015

**Context.** DEC-015 normalised enforcement to declaration order inside `buildParameterEnforcement`, by reversing the arrays at install time. That fixed what *ran* but not what was *stored*: the `ContractRegistry` array stayed in arrival order, which `__decorate`'s back-to-front application makes the reverse of source order. So `@GreaterThanEqual(100) @LessThanEqual(1000) n` **enforced GTE-first and documented LTE-first**.

**Decision.** Normalise as the constraint is recorded, not as the plan is built. `recordParameterConstraint` gains an optional `position: 'append' | 'prepend'` argument, defaulting to `'append'`; the legacy adapter passes `'prepend'`, and the adapter-local staging table for `CreateSimpleDecorator` closures `unshift`s for the same reason. Both `.reverse()` calls in `planChecks` are gone.

**Rationale.** There is no *semantic* disagreement here — it is not Q-4 drift, and nothing enforced differently from what it claimed to. But enforcement and documentation describing one declaration in two different orders is precisely the trust the flagship goal is built on: under "one declaration, four artifacts" a reader has no way to distinguish a cosmetic reordering from a real one, so the artifact has to be right for the reader to rely on any of it.

Recording correctly rather than reversing later also keeps the layering honest. Knowledge of `__decorate`'s application order stays in the adapter — at the two record sites, which is the only place entitled to it (DEC-015) — while the registry remains the single definition of what its own ordering means. A standard-decorator adapter, whose decorators arrive in declaration order, simply takes the default. The alternative considered and rejected was having the installer mutate the registry's arrays, which would have put emitter knowledge inside the core.

**Consequences.** Registry order now equals enforcement order, so a projection can render stacked constraints in the order they will fire. `src/Projections/docs.test.ts` needed **no change** — it records directly, in declaration order, and takes the default `'append'`.

---

## DEC-018 — `getContractsForClass` owns the two-key-band rule
**Status:** ACCEPTED · source: **Q-9** · raised by the docs projection

**Context.** A class's contracts live on two objects: instance-method constraints on `Class.prototype`, static-method constraints on the constructor itself, because that is the object the decorator is handed. `getContractedClasses()` returns only `Function[]`, so every projection had to know to walk both — and **getting it wrong does not fail**. It silently emits an artifact missing every static method.

**Decision.** `getContractsForClass(ctor)` returns both bands as a flat, deterministically ordered list of `{key, contract, isStatic, target}` — instance methods first, then statics. This is the API projections should walk.

**Rationale.** The failure mode is the argument. A rule that must be re-derived by four independent consumers, where forgetting it produces a plausible-looking incomplete document rather than an error, belongs in the registry once. The flat shape with an `isStatic` tag was chosen over returning two maps because the tag *is* the knowledge being centralised, and it is what the consumer needs to render anyway.

**Consequences.** `src/Projections/docs.ts` still hand-rolls `collectMethods(prototype) ++ collectMethods(constructor)` and should be refactored onto this — a behaviour-neutral change, not made here only because that file is owned elsewhere. Registry introspection surface grows, which is semver-relevant (**Q-6**).

---

## DEC-009 — Commit directly to `master`, do not push
**Status:** ACCEPTED · contextual

**Context.** Solo prototype in a personal working directory; `master` is the only branch.

**Decision.** Commit directly to `master`; do not push without an explicit request.

**Consequences.** Fine for a solo prototype; revisit immediately if the project gains collaborators or a release process.

---

## DEC-010 — Reified descriptor shape: derive predicates from params
**Status:** ACCEPTED · source: `implementation-plan-t0-t1.md` §1.5, P1.0

**Context.** DEC-006 requires descriptors, but their shape was unsettled — in particular how the runtime predicate relates to the descriptor. Today a constraint is a closure that throws: its *identity* (`min`) and its *parameters* (`0`) exist only as instructions inside a function body, so nothing can be projected from it.

**Decision.** Introduce a `ConstraintDescriptor` carrying kind, params, and message, and **derive the predicate from `params`** rather than attaching a hand-written predicate alongside it.

**Consequences.** Derivation is what makes descriptor and check unable to drift (see Q-4 — drift is the worst failure mode this goal introduces, because generated docs would *look* authoritative while disagreeing with enforcement). Scheduled as **P1.0, first in Phase 1**, because P3.3 would otherwise author ~15 constraints as opaque predicates and require ~15 rewrites. Carries a real risk of premature abstraction: pressure to build a constraint algebra before any projection has exercised it.

**Refined during implementation.** The single shape was split in two, because it conflated a reusable *rule* with one *application* of it:
- `ConstraintDefinition` — the rule, registered once by identity, carrying `derive(params)` and `describe(params)`.
- `ConstraintDescriptor` — one frozen application, carrying `params`, the derived `predicate`, and `toJSON()`.

The split is load-bearing, not cosmetic: round-tripping JSON back to an *enforceable* descriptor requires re-deriving the predicate, which requires a lookup from constraint identity to its derivation. Without the definition table, deserialization can only yield inert data — and round-tripping is one of P1.0's own acceptance criteria.

There is **no `predicate` input anywhere** in the API; derivation is the only route by which a predicate exists. Note that P1.0's prose still describes a `predicate` parameter, contradicting this decision — tracked as **Q-8** and to be corrected, since such an input is exactly the drift escape hatch Q-4 warns about.

---

## DEC-011 — Registry needs two structures: WeakMap for lookup, Set for enumeration
**Status:** ACCEPTED · source: `implementation-plan-t0-t1.md` P1.1

**Context.** The registry was designed as a `WeakMap` keyed by prototype — ideal for the hot path ("what contracts does this prototype have?"). But **a `WeakMap` cannot be enumerated by construction**: it exposes no `keys()`/`values()`/`entries()` and is not iterable, precisely because its entries are collectable. A documentation or fuzzing tool needs the *inverse* question — "what classes have contracts?" — which a `WeakMap` can never answer. The original design silently assumed lookup was the only access pattern.

**Decision.** Keep the `WeakMap` for per-prototype lookup, and have `@Contract()` additionally append to an enumerable `Set` that backs enumeration.

**Consequences.** The `Set` holds **strong references**, so registered classes are never collected — acceptable for a decorated codebase, but it must be stated rather than discovered. Registry introspection also becomes **semver-relevant** the moment a projection binds to it; it was internal before and could change freely.

**Sharpened by the first projection.** Because `registerContractedClass` is called only by the installer and *not* by constraint recording, a class carrying recorded contracts but missing its `@Contract()` annotation is **invisible to documentation entirely** — it is not listed-as-unenforced, it simply does not appear. That is the correct semantics, but it means the installer's dev-mode warning is the only thing standing between a user and a silently incomplete generated artifact. **The warning is load-bearing for projections, not merely for enforcement** — which raises it from a DX nicety to a correctness requirement.

---

## DEC-019 — Packaging: explicit `node16` resolution, and `rxjs` as an optional peer
**Status:** ACCEPTED · verified empirically

**Module resolution.** `moduleResolution` was implied rather than declared. Options were tested rather than assumed: explicit `node10` raises **TS5107** (deprecated) and still dies at TS 7; `moduleResolution: node16` without a matching `module` raises **TS5110**; `bundler` compiles but is the wrong semantics for a published CommonJS package. Settled on **`module: node16` + `moduleResolution: node16`** — explicit, non-deprecated, and survives a future TS 7 move. Flips `esModuleInterop` on; verified harmless.

**`rxjs`.** Demoted to an **optional `peerDependency`** (plus `devDependencies` so the suite resolves it). `optionalDependencies` was explicitly rejected: npm installs those by default, which would defeat the entire purpose.

**Consequence — the goal is not yet met.** Verified against an isolated consumer tree: `require('adorn')` still fails with `MODULE_NOT_FOUND: rxjs`, because `index.ts` eagerly imports `Memoize`, which eagerly requires `rxjs`. `@Time` already demonstrates the correct pattern with a guarded lazy require. Until `Memoize` adopts it, `rxjs` remains a hard runtime requirement for every consumer regardless of the manifest. Tracked as **GAP-6** — a manifest change alone was never going to be sufficient, and only an isolated-install check would have shown it.

---

## DEC-013 — TypeScript ceiling is 6.x; 7.x is blocked by the toolchain
**Status:** ACCEPTED (forced) · verified empirically

**Context.** DEC-003's research established that legacy parameter decorators still compile and run on TypeScript 7.0.2, so 7.x looked like the natural upgrade target. Attempting it revealed a blocker that has nothing to do with decorators.

**The TypeScript 7 npm package is the Go port and ships no JavaScript compiler API** — `transpileModule`, `createProgram`, and `createLanguageService` are all `undefined`. ts-jest is built entirely on those functions, and its peer range states the limit outright: `typescript: ">=4.3 <7"` (verified against the installed package). No ts-jest release supports TS 7.

Because DEC-004 makes ts-jest binding — itself forced by esbuild's permanent refusal to implement `emitDecoratorMetadata` — moving to TS 7 would trade the entire test suite for a version number.

**Decision.** Pin TypeScript at **6.0.3**, the highest version that keeps the toolchain whole. This still exceeds the plan's original `^5.x` recommendation.

**Consequences.** TS 7 also removes `baseUrl` and `moduleResolution: node10`, both of which the old config relied on; `baseUrl` is already gone, but `moduleResolution` is currently *implied* and must be made explicit before any future 7.x move (GAP-7). DEC-003 remains verified rather than assumed: a test asserts `design:paramtypes` is `[String, Number]`, and the TS 6.0.3 emitter still produces the exact 4-argument `__decorate(..., null)` shape that DEC-005's analysis depends on. `tslib` was deliberately left at `^1.10.0`, since its `__decorate` is what those characterization tests pin.

**Revisit when** ts-jest ships TS 7 support, or a different runner can do `emitDecoratorMetadata`.

---

## DEC-012 — Projections must not depend on any decorator adapter
**Status:** ACCEPTED · source: `implementation-plan-t0-t1.md` §2

**Context.** DEC-003 established a decorator-agnostic core with thin adapters. Adding a `Projections/` band (docs, specs, tests, fuzzing) introduces a new way to violate that layering.

**Decision.** Projections may depend on `Core/` and `Contracts/` only, never on an adapter.

**Consequences.** Without this rule, "four artifacts from one declaration" silently degrades into "four artifacts from the *legacy* syntax," stranding every consumer on standard decorators — the precise reach problem DEC-003 exists to solve.

---

## DEC-014 — `@Contract()` is the installer, and its dev-mode warning ships with it
**Status:** ACCEPTED · source: `implementation-plan-t0-t1.md` P1.3 (option A1) · landed in P1.3

**Context.** DEC-005 requires that the wrapper be installed through something whose return value the language honours. A parameter decorator's is ignored, so installation has to move to a method-level or class-level decorator. The plan offered three options: **A1** a class-level `@Contract()`, **A2** a per-method `@Validate()`, **A3** keep the monkey-patch.

**Decision.** **A1**, with A2 shipped as an opt-in.

`@Contract()` does three jobs that would otherwise need three annotations: it **installs** (class decorators run after every member decorator, so metadata is complete and `__decorate`'s trailing write has already happened); it is the **enumeration marker** that lets `getContractedClasses()` exist at all, which a `WeakMap` can never provide (DEC-011); and it is the **class-scoped topology a standard-decorator adapter needs anyway** (DEC-003), so the legacy adapter is not a dead end.

**Consequences — the breaking one.** `@StringMinLength(10)` alone no longer takes effect. Forgetting `@Contract()` silently disables every contract on the class *and* removes it from documentation and fuzzing. Nothing throws. This is the single worst failure mode in the plan, and it is now permanent rather than transitional.

**The warning is therefore part of the decision, not an implementation detail.** A development-mode diagnostic names the class and the affected methods and shows the fix. It is deferred by one microtask — it cannot run at decoration time, because member decorators are emitted before the class decorator, so whether `@Contract()` is coming is genuinely unknown then; and it cannot run on first call, because an uninstalled method has no wrapper to hook. It is silent under `NODE_ENV=production`, routable via `setContractDiagnosticsSink`, and fires once per class.

**Accepted alongside:** `@Validate()` enforces without enumerating, so a class using only it is guarded but undocumented (**Q-12**). And the warning is driven by an adapter-side pending set rather than the registry's `installed` flag, because hand-written closures never reach the registry (**Q-13**, **SMELL-14**).

---

## DEC-015 — Parameter constraints evaluate in declaration order
**Status:** ACCEPTED · source: **SMELL-11** · landed in P1.3

**Context.** `__decorate` applies its decorator array back-to-front. Under the old design that ordering flowed straight into enforcement, so with several arguments invalid it was the **highest-index** parameter that got reported, and stacked decorators on one parameter checked bottom-up. Nobody chose this; it was the emitter's iteration order leaking through an implementation that had no opinion.

**Decision.** Normalise at install time to **declaration order** — parameters left to right, stacked decorators top to bottom.

**Rationale.** Two reasons beyond "least surprising". First, it is the order documentation will list constraints in, so enforcement and projection describe the same declaration the same way — under DEC-006 those two are supposed to be one source. Second, keeping the normalisation in the adapter means knowledge of `__decorate`'s application order stays in the only layer entitled to have it; a standard-decorator adapter with different ordering produces identical behaviour without touching the core.

**Consequences.** A behavioural change: a call violating several constraints now reports a different one than before. Nothing depended on the old order except a characterization test that existed to catch exactly this, which was updated. **Residue:** the `ContractRegistry` array is still in arrival order, so within a single parameter the registry — and therefore documentation — lists constraints reversed relative to enforcement. Cosmetic, no semantic disagreement, tracked as **SMELL-13** with a minimal additive registry fix proposed rather than applied.

---

## DEC-023 — Sensitive-flow analysis: iterative single-hop, report-by-default
**Status:** **REJECTED (point 1), twice, under both threat models** · points 2–4 survive · see `sensitive-flow-spike.md` §14 and proposed DEC-026

> **Re-evaluated under DEC-025's narrowed threat model, and point 1 fails again.** The narrowing rescues *a* design, but not the one this entry proposed:
>
> - **Iterated propagation stays rejected** — 64% of annotations inert, still stalls at hop 1 on `TS1206`, and rescues **zero** blind spots.
> - **A one-pass, report-only, source→adorn-sink detector is viable**, and is better than anything in the original plan. The credit for the improvement belongs to *not propagating*, not to the narrowing.
>
> **The `TS1206` crux resolved elegantly, and structurally.** Across 18 syntactic positions, **7 can host an adorn emitter, and in 0 of those is `@Sensitive()` illegal — the sets are identical.** Not luck: `@Log`, `@Enforce` and `@Sensitive` are all legacy decorators, which TypeScript admits only on a class declaration's concrete members. **An adorn emitter cannot be declared anywhere `@Sensitive()` cannot be written**, so `TS1206` can never bite *at a sink*. It bites only on propagation, because every intermediate hop is a free function.
>
> **Blind spots got proportionally worse, not better.** Only 3 of 25 leaking cases leave scope; of the 22 remaining, **17 are still silent (77%, up from 68%)**. Every one severs the value on the *source* side (`const copy = s.ssn`, `` `${s.ssn}` ``), and moving the sink cannot repair source-side blindness. Template interpolation into an `@Log` argument is **in scope and invisible**.



> **Spike outcome (discharges point 4).** Point 1 — iterative single-hop — is **rejected on evidence**, for a reason that is structural rather than fixable:
>
> **The design has sources and receivers but no notion of a *sink*, so it converges by propagating the marking onto every sink.** On the 5-hop fixture the terminal annotations landed on `writeAuditLog(entry)` and `emitMetric(label)` — precisely the two functions that call `console.log`. It walks the value to the log statement and then marks the log statement as sensitive. It converges exactly when it has finished decorating the crime scene. That is not a defect in the implementation; it is what "no new flows appear" *means* when every receiver is treated as a source.
>
> **Second, independent blocker: `--fix` cannot write what the design requires.** A legacy parameter decorator is syntactically legal in only **7 of 18** positions — parameters of concrete class members. Free functions, arrow functions, function expressions, interface and abstract methods, overload signatures and function types all reject it (`TS1206`), three of them as *parse* errors. On a fixture of five ordinary exported functions `--fix` wrote **zero** annotations and stalled at hop 1 permanently. Most code that receives a primitive is a free function, not a class method.
>
> **Measured:** termination *is* proven (monotone map over a finite lattice; self-, 2- and 3-cycles all converge) — the one intuition that held. But 17 of 25 genuinely-leaking cases were **silently** missed (68%), and of 8 annotations written only 3 reached a sink (63% inert), uncorrelated with risk in either direction.
>
> **Points 2 (report-by-default), 3 (rule + CLI) and 4 (spike first) survive** and carry into DEC-024.

**Context.** `@Sensitive` can propagate through object-typed parameters by resolving markings from the runtime prototype, but **cannot** propagate through primitives — `(ssn: string)` severs the link, and value-tainting was rejected on measured grounds (see `pii-redaction-plan.md`). The proposal is to close that gap at build time with static flow analysis.

**Decisions, as ruled:**

1. **Iterative single-hop, not interprocedural.** Find a `@Sensitive` value passed *directly* into an unmarked parameter; once that parameter is annotated it becomes a source itself, so the next run finds the next hop. Coverage accumulates by repeated application rather than by whole-program analysis.

   *Why this is the interesting choice:* it sidesteps interprocedural taint analysis entirely. Each pass stays cheap and near-zero-false-positive, and — decisively — **propagation is materialized in source at every step**, so there is no inferred-but-invisible taint to go stale. It should terminate because annotations are only ever added, never removed; that must be *proven*, including under recursion, not assumed.

2. **Report by default; `--fix` opts in** to writing annotations. Never auto-writes silently: an inferred marking that lands without review expands the trusted surface without anyone agreeing to it.

3. **Both an ESLint rule and a CLI**, ideally over one analysis core. A CLI is arriving regardless for documentation generation (see IDEA-9).

4. **A feasibility spike precedes any implementation.**

**Consequences.** The analysis is a *supplement*, never load-bearing — the redaction plan's central principle is that every emitting path must be safe without consulting any annotation. The danger to guard is a **silent** blind spot: a tool that cannot see a flow and does not say so produces exactly the false confidence the redaction plan calls worse than no design. A related hazard is that "silent because converged" and "silent because never re-run" look identical, which must be designed against.


---

## DEC-025 — Trust boundary: adorn secures its own emissions, not the application's
**Status:** ACCEPTED · user ruling · governs `pii-redaction-plan.md`, `observability-plan.md`, DEC-023/024

**Context.** "Prevent PII from leaking" is unbounded and therefore unachievable — it would require adorn to reason about every line of a consumer's code. Without a stated boundary, every design in this area either over-promises or is judged against a standard nothing could meet. The sensitive-flow spike failed in part because it had no closed set of sinks to aim at.

**Decision.** adorn's obligation is to make **its own emissions** safe: `@Log`, violation messages, the observation/telemetry sink, and generated artifacts. A developer writing a raw ``console.log(`${user.ssn}`)`` is **out of scope** — adorn was never in that call path, and no library can intercept it.

In the user's words: *"we're not protecting against bad developers, we're protecting our own output — so as long as they stay within the framework and aren't malicious with logging they should be fine."*

This is the same boundary an OpenTelemetry instrumentation library draws: it secures the attributes *it* emits, not the application's `printf`.

**Consequences.**
- **The sink set becomes closed and enumerable**, which is what makes any analysis tractable at all. The spike's decisive failure — converging by propagating the marking onto every receiver including the loggers — depended on the sink set being open.
- **It does not weaken safe-by-default.** Adorn's own paths still emit no values without an explicit opt-in; the boundary narrows *what adorn is responsible for*, not *how carefully adorn behaves inside it*.
- **It bounds the "alert on exposure" projection** to adorn sinks, which is the half that was ever computable from the registry.
- **New risk, and it must be stated rather than implied:** a developer may believe adorn covers them when the leak path simply exits the framework. The redaction plan holds that a design letting someone believe they are covered when they are not is worse than no design — so this boundary belongs in user-facing documentation in plain words, not buried in a decision log. Do not let "adorn protects your PII" become the shorthand.


---

## DEC-027 — Runtime getter observation and full interprocedural analysis: both rejected
**Status:** ACCEPTED (both rejected) · evidence: `sensitive-flow-spike.md` §15

**Context.** After iterated single-hop failed twice, two alternatives were spiked: (A) observing reads through the `@Sensitive` field getter, since adorn owns the accessors and the getter fires *before* any source-side severing; and (B) full interprocedural static analysis rebuilt on every build.

### Option A — rejected, and notably **not** on catch rate

It is the first mechanism in three attempts to move the number: **15 of 17 blind spots by exact value membership, 16 of 17 with substring**. It also dissolves two failures recorded as structural — untyped values (runtime has no types) and interface dispatch (runtime dispatch always reaches the concrete decorated method). It works. It is rejected anyway, on four independent grounds:

1. **Coverage becomes a property of execution history rather than of code.** With an ordinary memoised read, one emit line is redacted on a cache miss and printed in the clear on every subsequent request — same line, no code change, no report. That is `class-transformer` #146's shape, which the redaction plan already designates *a warning rather than a template*; and it is worse, because that failure is deterministic per route and therefore testable, while this one is not.
2. **It cannot enumerate its own misses**, so it cannot satisfy the shipping condition the previous spike itself established. Reporting "a sensitive value reached an emitter unobserved" requires knowing the value is sensitive *without having observed the read* — circular.
3. **It emits an affirmative safety signal over unprotected data.** `{mrn:[REDACTED],diagnosis:hypertension,insuranceId:INS-4410-22}` — a visible censor token is the strongest available signal that redaction is working, printed across a record two-thirds in the clear.
4. **adorn cannot open the scope.** `AsyncLocalStorage` survived every async hop tested (6/6) and failed at every architectural boundary (5/5). Nothing opens a scope by default, and the emitter then fails open, silently.

**Collision, measured:** record everything → 23.8% false positives at 100% protection; strings ≥8 chars → 2.4% FP at **25%** protection; ≥12 chars → 0% FP at **0%** protection. **Monotone with no knee**, so there is no threshold to tune to. Decisively: at ≥8 chars, **100% of residual false positives are a date of birth colliding with ordinary dates** — no length guard can ever remove that, because a DOB is shaped exactly like a timestamp.

### Option B — rejected as posed, because the framing was wrong

Only **10 of 17** blind spots need interprocedural reasoning. **6 are local severings**, and the template-literal case previously called the most dangerous blind spot **falls to a six-line local propagator at zero false-positive cost**. It never needed whole-program analysis.

On precedent: adorn *has* the declaration CodeQL lacks, so the source problem is genuinely solved — but the **sanitizer problem is inherited whole**, and deciding whether `.slice(-4)` sanitizes an SSN is a regulatory judgement, not a library's. That is the precise sense in which this is a security-tool project in a library's clothes.

### Are they complementary?

**Arithmetically yes; as a design, no.** Both catch 5, runtime-only 10, **static-only 1**, neither 1 — union 16 of 17. Static's entire unique contribution is a single case, and that case is cheaper statically (six lines, 0% FP) than through runtime substring matching (29.4% FP, 63× emit cost). They are complementary in coverage and **incompatible in kind**: union a checkable coverage set with an uncheckable one and you inherit the weaker guarantee while concealing that you have.

**Consequences.** A new *kind* of false-confidence surface is what settles it. Partial marking already exists in the ratified design, but that coverage is **declarative and enumerable from `ContractRegistry`**; Option A's coverage is an execution property the design cannot report. Recommendation carried forward: extend the one-pass detector **intraprocedurally** (+6 of 17, zero FP, no extra rounds) and ship the emission-position report. One case is caught by nothing at any budget — the permanent floor, and it should be documented as such rather than chased.

---

## DEC-028 — `@Sensitive` and the one-pass intraprocedural detector are built; the full-chain interprocedural version stays deferred
**Status:** ACCEPTED · **source:** this build · **implements:** DEC-025, DEC-026, DEC-027, DEC-PII-1/2/5 · **relates to:** DEC-012, DEC-021, DEC-023, IDEA-9, IDEA-11, SMELL-19

**Context.** DEC-023's iterated single-hop propagation was rejected twice (DEC-024 under the broad model, DEC-026 under DEC-025's narrowed one); runtime observation and a full interprocedural taint engine were both rejected (DEC-027). What survived all of it is a specific, small design — spike §15's recommendation — and DEC-026/DEC-027 ratified it *as a recommendation*. This entry records the **build** of that recommendation, and pins what was and was not built.

**Decision — what shipped.**

1. **`@Sensitive`, a record-only marker (Part 1).** A new public export (`Sensitive`, +1 on the runtime surface, now 50). It records a marking into `ContractRegistry`'s new **sensitivity band** — a datum the registry learns *decorator-agnostically* (DEC-012): a field/parameter/class is *sensitive*, not that a decorator named `@Sensitive` said so. It applies to fields, parameters, and classes, stores `{level: 'sensitive'}` (forward-compatible with the three-valued DEC-PII-2 design — the shape grows, no migration), and is **inheritance-safe by reusing the field band's own-scoped-storage + prototype-union resolution unchanged** (DEC-021): a subclass cannot un-mark an inherited sensitive field, because weakening is unexpressible, not merely rejected. It is record-only — it installs no accessor and does **not** redact. Redaction (safe-by-default emission, BUG-18/BUG-19) is a separate, later piece.

2. **A one-pass, report-only, source→adorn-sink detector, extended intraprocedurally (Part 2).** In `tools/sensitive-flow/`, **build-time tooling that never enters `dist/` or the runtime surface** (excluded from the library build; typechecked by `tsconfig.test.json`; tested by `npm test`). The sink set is the closed one DEC-026 fixed (`@Log` params S1; adorn-constraint params S2; proposed `@Telemetry.value()` S3; `@Time` explicitly **not** a sink). The intraprocedural propagator (DEC-027) follows a value through same-function `const` aliases, template interpolation, literal element access, and destructuring. It is **report-only, permanently** (no `--fix`, ever — the fix target is cross-file). Delivered as an **ESLint rule over a shared analysis core**; the core takes a `ts.Program`, so a future `adorn check` CLI (IDEA-9) is the same core with a different wrapper.

3. **The scope report is a shipping condition, met (DEC-026 point 4).** The detector prints its own scope on every run: what it analysed (the denominator, so clean ≠ never-run), the leaks, and every `@Sensitive` value it saw flowing to a non-adorn receiver and therefore did **not** analyse. A clean `Leaks: none` never masquerades as a clean bill of health.

4. **Legality from compiled probes (SMELL-19), met.** Decorator-host legality is derived from a compiled probe table, not from AST node kinds, so a `@Log` on a class-*expression* method (TS1206) is correctly **not** treated as a sink.

**Decision — what stays deferred, explicitly.** The **full-chain interprocedural version stays on the backlog** as **IDEA-11**. This build is the accepted path; whole-program reachability that follows a value across function boundaries is not built, and the *full taint engine with a sanitizer policy* remains rejected outright (DEC-027) — deciding whether `.slice(-4)` sanitises an SSN is a regulatory judgement, not a library's.

**Consequences.**

- **The primitive-parameter gap (DEC-PII-5) stands unweakened.** `transfer(ssn: string)` is closed only by a hand-written `@Sensitive()` on the parameter. The detector can now tell you where one is missing *at an emission position*, and still cannot tell you where one is missing anywhere else.
- **The permanent floor is documented, not chased.** `s.ssn.slice(-4)` is caught by nothing; `docs/sensitive.md` records it as an accepted limit and a test pins it as *not caught*, so it cannot be silently "fixed" into a sanitizer policy.
- **The DEC-025 false-confidence surface is named for users, in plain words.** `docs/sensitive.md` states that adorn secures its own emissions and a raw `console.log` of a sensitive value is the developer's responsibility — the risk DEC-025 required be surfaced, not buried.
- **Q-17 and Q-20 move from resolved-in-principle to built; SMELL-19's instruction is discharged in the shipped tool.** Q-18 (the real-code recall ratio) is now *measurable* against a real `@Log`/`@Enforce` codebase but remains unmeasured.
- **The sink set is a maintenance obligation.** A future value-rendering method decorator that is not added to the emitting set becomes a silent hole; the `@Time`-is-not-a-sink test is the pin that a decorator emitting no argument value stays excluded.

**Amendment (IDEA-9 CLI).** `adorn check` needs the detector at *runtime*, so the CLI build emits a compiled copy to `dist/tools/sensitive-flow/`. This is consistent with this decision's "same core, different wrapper" and does **not** violate the placement rule: the detector remains absent from `index.ts` and the runtime library export surface — it ships only as the `adorn check` wrapper's dependency. Blessed explicitly so the compiled-detector-in-`dist` is a decision, not drift.


---

## DEC-029 — JSON Schema projection: conjunctive merge, under-claim on degradation
**Status:** ACCEPTED · source: `src/Projections/schema.ts` (IDEA-12)

**Context.** The schema projection emits JSON Schema (draft 2020-12) from the same registry reads the docs projection uses. Two policies had to be settled: how several constraints on one parameter/field compose, and what to emit when a constraint has no faithful schema.

**Decisions.**

1. **Stacked constraints compose as conjunction (AND)** — the same AND enforcement applies, and the same union DEC-021/DEC-022 resolve across inheritance. Disjoint keywords coexist (`minimum` beside `maxLength`); a repeated bound takes the *tighter* value (max of the minimum-family, min of the maximum-family — the exact intersection); `type` narrows (`integer` ⊂ `number`). Anything not combinable in place (two distinct `pattern`s, two `multipleOf`s, a genuine type contradiction) falls back to `allOf`, which *is* conjunction and is therefore always exact — the flat merge is only a readability optimisation for the common case.

2. **Degradation always goes toward the weaker true statement** (the emitted schema must accept a superset of what enforcement accepts — never reject a value enforcement allows). A constraint with no `schema()` hook contributes `{}`; the projection never emits `required`, `additionalProperties`, `minItems`/`maxItems`, or `items:false`, because a value-constraint bounds a value *when present* and asserts nothing about presence, exclusivity, or arity. Descriptor-level degradations (`matches`+flags → `{type:'string'}`, `url` → `format:'uri'`) are inherited unchanged and never re-tightened. **A schema that over-claims is worse than none**, because a consumer validates against it — this is the whole ethic, and tests assert it by evaluating each descriptor's own `predicate` and showing the schema does not reject what the predicate accepts.

3. **Root validates an instance** (fields → `properties`); methods and static members ride under annotation keywords (`methods`, `staticMethods`, `staticProperties`) that an instance validator ignores but which are each themselves well-formed subschemas.

4. **`installed`-state is out of scope** — schema projects the *declaration*; enforcement state is the docs projection's concern.

**Consequences.** `schema()` returns a bare `JsonObject` with no dialect tag, so the `2020-12` label is asserted by the projection, not by the fragments; a future draft-07-shaped fragment would be silently mislabelled (tracked on IDEA-12, currently satisfied). This is the first confirmation that the descriptor's `schema()` hook — added speculatively in P1.0 — carries real weight: the projection invents no schema of its own, exactly as the docs projection invents no prose.


---

## DEC-030 — Safe-by-default emission: adorn redacts its own output, `@Sensitive` only vetoes
**Status:** ACCEPTED · closes BUG-18/BUG-19 · discharges the observability plan's O0 redaction prerequisite

**Context.** Two of adorn's own emitters leaked argument values in shipped code: `@Log` stringified every argument to `console.log` (BUG-18), and violation messages embedded the received value, so anything routing a violation inherited the leak (BUG-19). DEC-025 had already set the boundary (adorn secures its *own* emissions); this is that boundary implemented, and it is the surface the observability plan requires *before* any feature emits values.

**Decision.** Every adorn emission path redacts values **by default, without consulting any annotation.**
- The decision is a pure function, `shouldDiscloseValue(sensitive) = disclosure === 'all' && !sensitive`, in a new `src/Core/redaction.ts`. It **never reads the registry**, so the safe default holds with zero `@Sensitive` anywhere.
- **Opt-in:** `setValueDisclosure('none' | 'all')` (default `'none'`), in the established single-setter/live-read config shape. `'all'` turns raw values back on for local debugging.
- **`@Sensitive` only ever vetoes** — a marked parameter/field/class stays redacted even under `'all'`. It is defence-in-depth, never the primary control. The proof-of-record test is a class with **no** `@Sensitive` still being safe.
- Placeholder is a single fixed `[REDACTED]`. No length-masks, no hashes (the plan flags hashing as a GDPR trap).

**How it reaches `Descriptor` without breaking DEC-012.** `ViolationContext` gains a pre-resolved `disclose?: boolean` — plain data, the shape `signature` already uses. `Descriptor` imports only the `REDACTED` constant; it never reads the registry, the config, or `@Sensitive`. **Absent means redact**, so an enforcement path that forgets to forward the flag still renders safely — the default is fail-safe, not fail-open. The `disclose` boolean is resolved at the three enforcement sites (`ParameterDecoratorFactory`, `FieldDecoratorFactory`, `Verify`), each composing the global switch with a per-site `sensitive` bit from the sensitivity band.

**Consequences.**
- **Breaking:** `@Log` output and violation-message text lost their embedded values by default; ~a dozen test files updated their pinned messages to `[REDACTED]`. Each of those tests' actual subject was parameter/class/field *naming*, which they still pin — and they now additionally witness safe-by-default on every path.
- **O0 discharged:** the redaction surface exists, so a future logging/telemetry feature may emit values behind it without shipping a breaking change plus a retroactive security advisory.
- **Gap (Q-23):** a method *return* cannot be marked `@Sensitive`, so it is redacted-by-default (safe) but not selectively disclosable.
- Exports `setValueDisclosure`/`getValueDisclosure`; `REDACTED`/`resetValueDisclosure` stay internal (test-only, matching `resetConfiguration`).


---

## DEC-031 — Generation is sound, or it declines
**Status:** ACCEPTED · source: `addons/test/arbitraries.ts` (IDEA-3, Phase A) · sibling of DEC-029

**Context.** The fuzzing add-on derives fast-check generators from constraint descriptors. The governing question is what a generator does when it cannot faithfully produce the constraint's accepted set.

**Decision.** A generator must produce **only** values the constraint accepts, or **decline**. This is icontract-hypothesis's "the inferred strategy must satisfy the preconditions" adopted as law, and it is the generation-side twin of DEC-029's "under-claim, never over-claim" for schema:
- When a faithful parametric generator exists, use it (numerics, lengths, `matches` via `fc.stringMatching`).
- When it does not, **filter** a tighter base to the accepted set.
- When filtering would **starve** (measured: `<25%` acceptance warns, `0%` declines rather than hanging — the Hypothesis `filter_too_much` analogue), **decline**.
- A hand-written closure has no params and no identity (SMELL-14, the Q-3 floor), so it **declines** and is named as gap-filled in the report — never presented as covered.

**Rationale.** *A declined constraint costs coverage; an unsound one costs trust.* An unsound generator produces inputs the contract rejects, so a "failure" it finds may be the generator's fault, not the code's — which poisons the whole tool's credibility. Coverage gaps are honest and reported; unsound generation is a silent lie. Enforced by construction and pinned the way `schema.test.ts` pins under-claim: sample each generator, assert every value satisfies the descriptor's own `predicate` (the single source — no drift, DEC-010).

**Consequences.** Some constraints generate only partially (curated `email`/`url`) or not at all (closures); the **report-own-boundary discipline** (DEC-028 point 3, applied here) makes that visible, so a clean fuzz run is never mistaken for a proof. This is the generation-side expression of the project-wide honesty ethic: refuse to lie, in whichever direction the artifact points.


---

## DEC-032 — Postconditions v1: a closure band, and the union mechanism vindicated
**Status:** ACCEPTED · closes Q-11 · source: `postconditions-plan-b-pragmatic.md` (build) + `-a-dbc.md` (semantics)

**Context.** The registry reserved `pre`/`post` slots with no writer (Q-11); the fuzzing oracle needed postconditions. Two independent plans were commissioned from different angles and converged.

**Decisions.**
- **`@Ensures((result, ...args) => boolean, description?)` records a closure into its own band** (`postconditionsByTarget`), **not** the reserved `ConstraintDescriptor` `post` slot. A postcondition is intrinsically n-ary (relates return to inputs) and hand-written, so it is not a params-derived descriptor (DEC-010) — forcing it into that slot is the drift-adjacent dishonesty the model rejects. The descriptor slot stays reserved for the deferred, *projectable* `Returns(<descriptor>)` tier.
- **One evaluator, two callers.** `evaluatePostconditions(posts, result, args)` is called by both the runtime wrapper and (Phase B) the fuzz driver. This shared call *is* the no-drift guarantee — the oracle checked equals the oracle enforced — and it is made executable by an integration test asserting the wrapper flags a violation exactly when the evaluator returns `!ok`.
- **Weave and defaults** (both plans agreed): gate → preconditions → `proceed()` (result captured outside every try) → postconditions. A **throw skips** (no return to check; the exception propagates untouched). **Async awaits the settled value then checks; a rejected Promise skips.** Observables are checked as the raw value (rxjs is gone, DEC-019). Violation messages reuse the DEC-030 `disclose`/`REDACTED` path — redacted by default.
- **Blame is first-class** (`ViolationSite.blame: 'caller'|'callee'`), and **blame sets the trust default:** a postcondition audits your own output (callee fault) so it defaults to `trust: 'assert'` — stripped in production — while preconditions stay `guard`. Two `shouldEnforce` gates over the one DEC-008 primitive, so in prod `guard` preconditions survive and `assert` postconditions strip.

**The finding worth recording — the union mechanism was principled, not incidental.** Postcondition inheritance is covariant conjunction (`ensure then`): a subclass strengthens. That is **orthodox Meyer with nothing to decide**, and it fell straight out of `getEffectivePostconditions` being a line-for-line copy of the DEC-021 field union. The same union that DEC-022 had to *defend* as a considered departure from Meyer for *preconditions* lands as textbook-correct for *postconditions* — strong evidence that choosing "union / strengthen-only" back in DEC-021/DEC-022 was a principled call, not a convenience that happened to work once.

**Consequences.**
- Deferred, each with a reason: `old()` state capture (needs a pre-`proceed()` snapshot protocol; relate-to-input covers the oracle need first), invariants (IDEA-5 — a different mechanism, needs a `new`/instantiation hook adorn lacks), the reified `Returns(<descriptor>)` tier + return-value-schema projection (the recommended **next step** — it is where the projection payoff is), `this`-state and per-`@Ensures` trust and exceptional postconditions (all additive).
- **`@Validate()` + `@Ensures()` is decorator-order-sensitive** (`@Ensures` must sit below `@Validate()`); **class-level `@Contract()` is the order-safe form** — documented and pinned.
- **Toolchain note:** under this repo's `strict: false`, a `{ok:true}|{ok:false,...}` discriminated union does not narrow (no `strictNullChecks`), so `PostconditionResult` is a flat `{ok; failed?; error?}` interface. Relevant to any future result-shaped return type; folds into SMELL-12's cost-of-strict.

### Addendum — rationale preserved from the deleted postcondition plans

*Appended during docs consolidation (2026-07-25). `postconditions-plan-a-dbc.md` and `postconditions-plan-b-pragmatic.md` were deleted as shipped-and-captured — their synthesis is DEC-032 above, and the build/semantics split each contributed is recorded in the source line. Two pieces of unique, deliberately-recorded rationale from plan A that DEC-032 did not carry are preserved here so they do not vanish with the docs.*

- **The throw-instead-of-return LSP hole (plan A §1.3, §3.4).** DEC-032's weave makes a postcondition **vacuous on throw** — a method that throws skips its postcondition and the exception propagates untouched. Correct for v1, but it leaves a behavioural-subtyping hole worth naming so it is not later mistaken for a bug: an override that *throws where its supertype's contract promised a value* is, in spirit, a postcondition violation, and vacuous-on-throw will not catch it. Closing it needs a separate totality / `@Rescue`-style exceptional-postcondition clause — which is why "exceptional postconditions" is a deferral rather than a trivial additive.

- **The invariants re-entrancy rule (plan A §6.2–6.3), for IDEA-5.** When class invariants are built (IDEA-5), two design pieces should be inherited rather than rediscovered: (1) a relational invariant is *a `self`-only relational postcondition hoisted onto every public method, plus a post-construction check* — it reuses the postcondition machinery, it is not a new predicate kind; (2) an invariant may be **temporarily broken inside a routine** and need only hold at *public* boundaries, so a naive "check after every method" fires a false positive on any internal self-call. The remedy is a per-instance "in a public call" depth flag so the invariant fires only at the outermost boundary. The two blockers keeping this deferred: adorn has no instantiation hook (needs a `Proxy` or a static factory), and the re-entrancy flag above.

- **Lower-value pointers for the deferred tiers:** async "`old` is a snapshot, `self` is live" (plan A §1.4) belongs with the deferred `old()`/`this`-state work; the `returns` return-value-schema keyword shape (plan A §4.3) belongs with the reified `@Returns` tier already scheduled in `next-phase-plan.md`.

---

## DEC-033 — Reified `@Returns(<descriptor>)`: the projectable postcondition tier
**Status:** ACCEPTED · builds `next-phase-plan.md` Item 2 · closes Q-11's reserved-slot loop · advances IDEA-7/IDEA-12

**Context.** DEC-032 shipped `@Ensures` as a *closure* band and deliberately left the reserved `ConstraintDescriptor` `post` slot empty, for a tier that could be **projected** (a closure carries no identity or params — SMELL-14 — so nothing can render it into docs or schema). This is that tier.

**Decisions.**
- **`@Returns(descriptor, description?)` records an existing `ConstraintDescriptor` into the reserved `MethodContract.post` band** (its first writer, `recordReturnConstraint`) — *not* the `@Ensures` closure band. A bare predicate is rejected at the decoration site: it cannot be projected, and `@Ensures` already covers the closure case. `description?` is validated but **not stored** in v1 (the band holds descriptors, which self-describe via `describe()`; a stored phrase could drift from the derived predicate — DEC-010), rather than ship a stored-but-ignored field.
- **The projectable/opaque line is the reason both exist.** `@Returns` is the *single-value, projectable* subset — the return in isolation, tested by one descriptor's `predicate` (DEC-010, the *same* predicate parameter enforcement runs and Fuzzing Phase B will call — no drift). `@Ensures` stays the *n-ary, opaque* superset — the return related to the inputs. A guarantee like "result exceeds `amount`" stays `@Ensures`; a guarantee like "result ≥ 0" becomes `@Returns` and gains a docs row and a schema fragment for free.
- **Two postcondition bands now run after `proceed()`, and the weave + both projections consume both** — the DEC-016 enforced-but-undocumented asymmetry, avoided by construction and pinned: a `@Returns`-only method (no `@Ensures`, no param constraints) is enforced at runtime **and** appears in `generateMarkdown()` with its Returns table **and** in `generateSchema()` with its `returns` fragment. **Cross-band ordering is pinned reified-first:** the descriptor band checks before the closure band, on the *same* settled value, under the *same* single `POSTCONDITION_TRUST='assert'` gate and the *same* callee-blamed `ViolationSite` — no new trust machinery. First-failure-wins across the two bands, so the more precise/projectable guarantee is reported first. This resolves the cross-band-ordering item the planning wave flagged as a new open question: it is decided here, not left open.
- **Settling is identical to DEC-032**: async awaits the resolved value then checks; a throw or rejection skips *both* bands and propagates untouched (`proceed()` stays outside every `try`); an Observable is checked raw (DEC-019). The violation message uses the descriptor's **own** `message(...)` with `disclose: shouldDiscloseValue(false)` — a return carries no `@Sensitive` marking (Q-23), so disclosure follows the global switch alone and the value **redacts by default** (DEC-030). DEC-012 holds — the schema/docs projections read the descriptor's `schema()`/`describe()` directly, never a decorator adapter.

**Consequences.**
- The OpenAPI **response** half is now expressible (return-value schema); the full OpenAPI emitter stays blocked on Q-10 (parameter arity), unchanged.
- Registry writer/reader (`recordReturnConstraint`/`getEffectiveReturnConstraints`) stay **internal** (Q-6); the only new public symbol is `@Returns`. The `returns` schema keyword is a new public *output* shape — additive, enumerated under Q-6's semver note.
- Fuzzing Phase B (next) now has **two oracle sources** to consume, exactly as enforcement does: `getEffectiveReturnConstraints` + each descriptor's `predicate` for the reified band, and `getEffectivePostconditions` + `evaluatePostconditions` for the closure band. Building against one band only would fuzz half the guarantee.
- Deferred, unchanged: `old()`, invariants (IDEA-5), `this`-state, per-clause trust, exceptional postconditions (the throw-vacuous LSP hole above).

---

## DEC-034 — Fuzzing Phase B: the full postcondition oracle, both bands, no drift
**Status:** ACCEPTED · builds `next-phase-plan.md` Item 1 · advances IDEA-3/IDEA-4 · stays in `@adorn/test` (DEC-019)

**Context.** Phase A (DEC-031) shipped a *weak invariant* oracle — generate precondition-valid inputs, run, assert doesn't-throw + field-invariant preservation — because no postcondition existed to compare against. DEC-032 (`@Ensures`) and DEC-033 (`@Returns`) closed that gap; Phase B wires the fuzzer to them.

**Decisions.**
- **The oracle checks both postcondition bands through the EXACT functions enforcement runs** — the reified `@Returns` band via `getEffectiveContract().post` + each `descriptor.predicate` (DEC-033/DEC-010), reified-first, then the `@Ensures` closure band via `getEffectivePostconditions` + `evaluatePostconditions` (DEC-032). The oracle the fuzzer *checks* is byte-for-byte the oracle enforcement *enforces* — **the no-drift guarantee, made executable**: a pinned test asserts the fuzzer's shrunk counterexample makes the installed wrapper throw, and that over a grid `enforcedThrows(input) ⇔ oracle flags input`.
- **Auto oracle-mode**: `'postcondition'` when either band is non-empty, else the Phase A `'weak-invariant'` floor — which still runs underneath (layering, not replacement; IDEA-4/Q-3). A no-postcondition method is bit-for-bit Phase A.
- **Async** via `fc.asyncProperty`, awaiting the settled value (mirroring the installer's `isThenable` branch); a rejection is a robustness finding (async twin of a throw). Sync `fuzzMethod` **declines** a thenable-returning method loudly rather than checking the Promise object. `fuzzClassAsync` awaits **sequentially** — see the suppression note.
- **Obtaining the settled value — the one subtlety.** The fuzzer runs the real `@Contract()`-installed method; under the default policy the wrapper itself throws on a postcondition violation, denying the driver the value it must check independently. So a postcondition-mode run **suppresses assert-trust enforcement** for its duration (`setAssertEnforcement(false)`, restored in `finally`; postconditions are fixed at `assert`), making the wrapper return the raw value un-post-checked. Precondition **guard** enforcement is untouched (the Phase A `contract-violation` finding is preserved). Because the toggle is process-wide, class fuzzing runs sequentially, not `Promise.all`.
- **Counterexamples redact by default** (DEC-030) — values render through `shouldDiscloseValue(false)`/`REDACTED`, and the report prints fast-check's **seed + shrink path** as the value-free replay coordinate.

**Consequences.**
- The add-on now imports four `src/Core` internals not on the public root surface — `Descriptor` (`ConstraintDescriptor`), `ContractRegistry`, `redaction` (`REDACTED`/`shouldDiscloseValue`), and `Configuration` (`getAssertEnforcement`, whose setter alone is public). Consistent with the Phase A pattern and fine **in-repo**, but a **publishing-time coupling**: extracting `@adorn/test` as a real package needs these made public (a Q-6 decision) or deep-import handling. Logged against GAP-11.
- Deferred as Phase C, not attempted (avoids IDEA-6 scope creep): a custom-generator registry, a persisted counterexample corpus, and discovery of nullary pure-`@Ensures` methods (closures live in a parallel band `getContractsForClass` does not surface, so Phase B relies on such methods also carrying a constrained parameter — the realistic case).

---

## DEC-035 — Observability O1 (O1a + O1b): a neutral, zero-dependency observation seam
**Status:** ACCEPTED · builds `next-phase-plan.md` Item 3 / `observability-o1-plan.md` (absorbs the plan's DEC-OBS-1..6 into the DEC-0xx sequence) · O1c/O1d deferred to Stage 3b

**Context.** adorn should be *observable* without adopting a telemetry vendor. O1 defines a sink **interface** and emits plain, value-free data; the OpenTelemetry binding is a separate add-on (`@adorn/otel`, DEC-019) — not built here, and no `@opentelemetry/*` specifier enters the tree (runtime deps stay `{tslib}`).

**Decisions (O1a — the seam).**
- **One settling classifier, `settle` (`Core/settle.ts`), extracted verbatim from `@Time`.** `@Time`, a future `@Observe`, and the OTel span adapter all need to know *when work settles* (not when a method returns — ~0ms for async, worse than no measurement). That classifier — sync/thenable/Observable, the rxjs-absent `settled:false` refusal (SMELL-16), the cold-Observable non-subscription (SMELL-15) — is the hard, already-correct part; extracting it verbatim is what guarantees the three consumers compute one duration from one source and cannot drift (DEC-006). `@Time` is the first consumer and proves it (rebased to a thin `settle` call, behaviour byte-for-byte preserved).
- **`settle` takes a THUNK — `settle(operation, onSettle)`, not the plan's `settle(result, onSettle)`.** Required so a *synchronous throw* is classified and handed to `onSettle` before re-throwing (an adapter can `recordException` on **every** outcome — the Q-24/F2 gap), and so `settle` owns the try/catch `@Time` previously held, letting `@Time` rebase without behaviour change.
- **The corrected `Settlement<T>` arity (Q-24/R1): value XOR error in one object,** discriminated on the *string literal* `outcome` so it narrows even under `strict:false` (unlike a boolean discriminant — the same trap DEC-032 hit). One arity forever; a later field is additive, never an arity break (Q-6).
- **The sink slot** (`setObservationSink`/`getObservationSink`, internal `NOOP_SINK` default) is a no-op until a sink is set — zero overhead when unobserved. The **event union** (`Observation`/`ObservationEvent`/`ViolationFacts`/`EmittedValue`/`ErrorFacts`/`ObservationCall`/`SpanKind`/…) is a **semver-frozen public surface (Q-6)**: every payload field is optional and object-shaped so growth stays additive — exactly what the Q-24 revision pinned. `ViolationFacts` carries `blame:'caller'|'callee'` (added at emit-time with `trust`), widening the older O1-plan §1 shape — recorded.

**Decisions (O1b — enforcement-weave emission).**
- When — and only when — a sink is installed, `enforcementBehavior` **also** emits a value-free `{kind:'violation'}` event (precondition **and** both postcondition bands) and a `{kind:'completed'}` event. **Strictly additive:** the unobserved path is one `!== NOOP_SINK` compare and byte-for-byte the pre-O1b flow (`observeViolation` is `undefined`, so the check functions run exactly as before); `proceed()` stays outside every `try`; emission is a **side-channel** fired *before and independent of* `applyViolationPolicy` (a sink is not a `ViolationHandler`, cannot influence control flow, fires under `throw`/`warn`/suppress alike); a sink that throws is contained so it can never become the method's failure.
- **The O1b fidelity payoff (why `@Returns` shipped first):** a reified `@Returns`/`@Enforce` violation carries full `ViolationFacts` (`error.type: adorn.<constraint>`, groupable), while an `@Ensures` closure degrades to `_OTHER` (no `constraint` dimension — Q-3/SMELL-14, stated not hidden). `@Enforce`/parameter violations now throw a `ViolationError` (an `Error` subclass, message byte-for-byte unchanged) carrying the value-free facts.

**Consequences.**
- Deferred to Stage 3b: O1c (`@Observe`/`Telemetry`/`setObservationVerbosity`/`consoleObservationSink`) and O1d (the telemetry projection). **Known deferred reconciliation:** once `@Observe` (O1c) also emits `completed`, a `@Contract`+`@Observe` method double-emits `completed` to the ObservationSink until the wrapper-unification (plan §5) — an O1c task, not an O1b defect. (`@Time`'s `TimingSink` is a *different* sink and does not double-emit.)
- Q-24 → **BUILT** for O1a/O1b (the payload channel exists); Q-23 stays partial (`@Telemetry.result()` is O1c); Q-6's frozen surface grows by the event union.

## DEC-036 — "Seeing ≠ emitting": the per-call payload principle (ratifies Q-24/R0)
**Status:** ACCEPTED · the organizing principle behind DEC-035's disclosure behaviour

**Decision.** The adversarial O1 review found a *permission-without-payload* gap (Q-24): a value-emission permission system with no channel to carry a per-call value/error. The resolution is two paths with **different disclosure rules**, and the rule is which path you are on:
- **The `record` path** (the sink's telemetry events) carries only **pre-disclosed** data. `ViolationFacts` is value-free *by construction*; any emitted `error.message` is the already-**redacted-by-default** violation message (DEC-030 — `[REDACTED]` unless `setValueDisclosure('all')`). Deny-by-default holds *at the source*.
- **The `scope`/`settle` path** sees the **raw** outcome exactly as `@Time` already does (`Settlement<T>` hands back value XOR error), because ending a span or timing a call needs the real outcome and is *not* an emission.

**Why it matters.** This is DEC-025/DEC-030 applied to telemetry: adorn secures **its own** emissions. Seeing a value (to time it, to end a span) is not the same act as emitting it (to a telemetry backend), and only the second is disclosure-gated. Recording it as a principle, not just a code path, so O1c/O1d and the future OTel adapter inherit it rather than re-deciding it.

---

## DEC-037 — O1c + O1d: the shared disclosure resolver and telemetry projection (completes O1)
**Status:** ACCEPTED · completes DEC-035 (O1a–O1d all shipped) · realizes DEC-036 in code

**Context.** O1a/O1b gave the payload *channel*; O1c/O1d give the developer *surface* and the *projection*.

**Decisions (O1c — the surface).**
- **`@Observe(options?)`** is thin sugar over one `MethodBehavior`: it opens a scope and emits `scope`+`completed` via the installed sink, using `settle` for the raw-outcome path (as `@Time` does); `options.kind` sets `SpanKind` (default `internal`). **`Telemetry`** is the value-disclosure opt-in band (`.value()`/`.redact(strategy)`/`.result()`) — record-only, the `@Sensitive` twin; `.redact` ships `type`/`length` and refuses deferred strategies loudly. **`setObservationVerbosity`** (Fr3) and a zero-dep **`consoleObservationSink`** round out the surface.
- **One disclosure resolver (`Core/telemetryDisclosure.ts`), decorator-agnostic.** A single function composes `@Sensitive` (veto) + `@Telemetry` (opt-in) + `getValueDisclosure()` (global) into a `ParameterDisclosure` decision, and **both the emitter and the O1d projection call it** — so what a value discloses at runtime and what the report claims about it cannot drift. This is DEC-006's no-drift discipline (descriptor→predicate) extended to disclosure.
- **The `@Sensitive`-vetoes-an-explicit-`@Telemetry.value()` collision is surfaced, not silent** (Q-24's paternalism corner): the value still redacts (veto wins, DEC-025), and the conflict shows up three ways — an `EmittedValue.vetoed` flag, a one-shot dev diagnostic (`reportDiagnostic`), and a distinct projection row state.

**Decisions (the double-emit reconciliation — the one weave change).** `@Observe` stamps its wrapper with an `OBSERVED_COMPLETION` marker; at **install time** enforcement reads `ownsCompletion(original)` and suppresses **only its own `{kind:'completed'}` emit** (`observeCompletions = observing && !observed`), deferring to `@Observe`'s richer completion. **Violations always still emit** (gated on `observing`, not `observeCompletions`); the check flow, `proceed()`-outside-`try`, throw behaviour, and the Fuzzing-Phase-B no-drift are byte-for-byte unchanged. Pinned: a `@Contract`+`@Observe` call emits `completed` exactly once, one `scope`, still enforces, still emits its violation.

**Decisions (O1d — the projection).** `Projections/telemetry.ts` (`telemetryForClass`/`telemetryForContracts`/`serializeTelemetry`/`generateTelemetryReport` + `TelemetryReport`) reports **what leaves the process**: per-position disclosure state across contract *and* telemetry-marked methods, rendering its scanned denominator and making **no runtime-flow claim** (no false-confidence mode). Pure registry read (DEC-012, guarded by an imports test) — satisfies IDEA-10(a)'s "emission-position report".

**Consequences.**
- **O1 (DEC-035) is COMPLETE** — O1a–O1d shipped; runtime deps stay `{tslib}`, the OTel binding remains the separate `@adorn/otel` add-on.
- Q-24 → **RESOLVED/BUILT** end-to-end; IDEA-10(a) third item satisfied; Q-6's frozen surface grows by `TelemetryReport`/`ObserveOptions`/`ObservationVerbosity` (the telemetry-band registry reads stay internal).
- Deferred, per the plan: the `@Log` → `{kind:'message'}` rebase (sequenced last, not required here — `@Log` untouched); `.redact` deferred strategies; Fr1 (name-hatch). Q-23's *return* veto still only arrives via class-level `@Sensitive` (a return cannot be directly `@Sensitive` — TS signature limit), unchanged.

---

## DEC-038 — The adapter layer is physically separated (GAP-8); DEC-012 is now mechanically enforced
**Status:** ACCEPTED · closes GAP-8 and SMELL-7 · prepares the chosen TC39 Stage-3 adapter direction

**Context.** DEC-012 set the layering rule — `Core`/`Contracts`/`Projections` import no decorator adapter — but it lived only by convention and per-file imports-tests, while the adapter modules themselves sat in `src/Core/` (GAP-8). With a Stage-3 adapter now a chosen direction, making the split physical is worth its churn: a `stage3/` adapter needs a place to sit beside the legacy one.

**Decisions.**
- The legacy-decorator **adapter modules moved from `src/Core/` to `src/Adapters/legacy/`**: `MethodDecoratorFactory`, `ParameterDecoratorFactory`, `ContractInstaller`, `ContractDiagnostics`, `FieldDecoratorFactory`, and `ObservationBehavior`. The last two go beyond GAP-8's named four deliberately: `FieldDecoratorFactory`'s own header already declared it adapter-side, and `ObservationBehavior` was **the one remaining `Core/` file importing an adapter** — leaving it would have made the new layering test fail.
- The **decorator-agnostic model stays in `Core/`**: `Descriptor`, `ContractRegistry`, `Configuration`, `redaction`, `Observation`, `settle`, `Postconditions`, `ViolationError`, `telemetryDisclosure`, `common` (verified: none imports any adapter).
- **DEC-012 is now a test, not a convention.** `src/Adapters/layering.test.ts` sweeps every non-test module under `Core`/`Contracts`/`Projections` and asserts none resolves an import into `src/Adapters/`. A `stage3/` adapter will sit beside `legacy/` consuming the same Core model.
- **Pure move:** `index.ts`'s public export surface is byte-for-byte unchanged (72 value exports); all imports updated across `src/`/`test/`/`addons/`/`examples/`; `git mv` preserved history; SMELL-7 (the `FieldDeocrators` misspelling) was fixed in the same pass.

**Consequences.** ~10 historical file-path references in older `docs/` plans/spikes (e.g. `implementation-plan-t0-t1`, `observability-plan`, `pii-redaction-plan`) now name old `Core/` paths — left as historical records, not rewritten. The recurring in-source `.js` artifact friction the restructure surfaced is logged as SMELL-21.

---

## DEC-039 — The registry read surface is the semver-frozen public API (Q-6)
**Status:** ACCEPTED · resolves Q-6 · enforced by `test/public-surface.test.ts`

**Context.** Q-6 flagged the registry introspection surface as semver-relevant with rising stakes — three shipped consumers (docs projection, schema projection, the CLI) plus the fuzzer now read it — and left "what is public-frozen vs internal" formally undecided. The trio and GAP-8 raised the stakes again.

**Decision.**
- **The registry introspection READ surface is the semver-frozen public API**: `getContracts`, `getContract`, `getContractedClasses`, `getContractsForClass`, `getFieldContract`/`getFieldContracts`/`getFieldContractsForClass`, and the `getEffective*` reads (`getEffectiveFieldConstraints`, `getEffectiveFieldContract`, `getEffectiveContract`, `getEffectiveParameterConstraints`, `getEffectivePostconditions`).
- **The WRITERS and key/internal-reader helpers stay internal permanently**: `record*` (parameter/field/postcondition/return/telemetry/sensitivity), `set*Metadata`, `mark*Installed`, `registerContractedClass`, `resetRegistry`, `setClassEnumerationEnabled`, and every `*Keys`/internal reader (`getEffectiveContractKeys`, `get*PostconditionKeys`, `getEffectiveReturnConstraints`). Exporting one would let a caller bypass the adapter that owns declaration ordering (SMELL-13) and write contracts the enforcement path never sees.
- **Enforced mechanically**, not by convention: `test/public-surface.test.ts` asserts the reads are present and callable, the writers/`*Keys` are absent from the root, and pins the total value-export count at **72** as a deliberate-change tripwire (any intentional surface change updates the count in the same commit).
- The O1 event-union types stay "frozen but additive" (all-optional/object-shaped) per DEC-035/DEC-036 — additive growth is allowed, arity/shape breaks are not.

**Consequences.** This freezes the read/write boundary and makes drift a CI failure; it is deliberately **not** a version-number or npm-release commitment (publication process was deprioritized in the ③ direction choice). GAP-11's `exports` map makes that frozen surface the one thing a consumer resolves.

---

## DEC-040 — Direction: a TC39 Stage-3 decorators adapter beside the legacy one
**Status:** ACCEPTED (direction) · detail in `docs/decision-stage3-adapter.md` · builds on DEC-038 · tracked as IDEA-18 + GAP-13

**Decisions (consolidated from the decision doc's DEC-040..045 proposals).**
- **Two adapters over one decorator-agnostic Core**: `adorn` (root, **legacy default** — DEC-038/DEC-039 untouched) and `adorn/stage3` (the GAP-11 `exports` map gains a `"./stage3"` subpath). `experimentalDecorators` is a per-compilation switch the consumer owns, so legacy vs standard is a **per-consumer choice, not mixable** in one build — hence two entry points, not a runtime toggle; `index.ts` is not forked (shared exports factored so each entry composes them with its adapter).
- **The parameter-decorator gap is the crux.** Stage-3 has no parameter decorators, so per-parameter contracts become a **method-level positional descriptor-list spec** — `@Validate({params: [[GreaterThan(0)], [MinLength(3)]]})`, `@Contract({constructor:[...]})` — recording each descriptor into the **same** `recordParameterConstraint` band the legacy per-parameter decorators write. `@Sensitive`/`@Telemetry` are parameter decorators today too, so they fold into the same spec via the same writers. Enforcement and every projection stay adapter-blind (DEC-012).
- **Field constraints** target Stage-3 `accessor` auto-accessors (standard define-semantics bypass the legacy prototype trampoline). The **enforcement weave + invocation seam + check planner hoist into a shared decorator-agnostic layer** both adapters consume; the `src/Adapters/layering.test.ts` / DEC-012 boundary extends to `stage3/`; **one shared conformance suite** guards against dual-track drift.
- **Trade:** no `emitDecoratorMetadata`/`design:type` under standard decorators (drop `reflect-metadata`), so type columns degrade to advisory (parameter names unaffected). **Upside:** Stage-3 is *simpler* — a method decorator's returned replacement is honored, so the `__decorate`-clobber / `OverrideObjectDefineProperty` problem (DEC-005) never exists in that adapter.

## DEC-041 — Direction: the add-on ecosystem and its priority order
**Status:** ACCEPTED (direction) · detail in `docs/decision-addon-ecosystem.md` · extends DEC-019

**Decisions.**
- **Priority `@adorn/otel` → `@adorn/rx` → `@adorn/cache`**, ordered by seam-readiness and risk introduced, not headline value.
- **`@adorn/otel`** (IDEA-14, first): maps `ObservationEvent`/`ViolationFacts`/`Settlement<T>` onto OTel spans/metrics/exceptions, **ends spans via the exported `settle`** (never a reimplementation), honours "seeing ≠ emitting" (DEC-036); `@opentelemetry/api` peer. Needs **zero new core surface** — the O1 seam (DEC-035/037/039) was purpose-built for it, which is why it goes first (also the first real exercise of the peer-dep isolation + frozen-event-union contract).
- **`@adorn/rx`** (IDEA-8, second): reintroduces `@Memoize`/Observable handling **carrying the BUG-3/5/9/10/11/15 findings + cold-safety verbatim** as design constraints; owns the SMELL-16 `setObservableConstructor()` decision; BUG-15 lands unsolved (documented). Recovers capability rather than adding it.
- **`@adorn/cache`** (IDEA-15, third): richest/most new machinery — records policy in the new `concern` band (GAP-12/DEC-043), reuses rx's keying, and carries the Q-22 detector. `@adorn/policy` (`@Authorize`, IDEA-16) is Q-22's second half.
- **Contracts:** heavy deps are peers, never a core specifier; each add-on ships an isolation test mirroring `addons/test/isolation.test.ts`; add-ons consume the frozen public read surface + blessed seams (DEC-039), writers stay internal — otel needs nothing new public, rx one symbol, cache the concern band + a blessed concern-recording seam.

## DEC-042 — Direction: the flow-control family, entirely as add-ons
**Status:** ACCEPTED (direction) · detail in `docs/decision-flow-control.md` · tracked as IDEA-17

**Decisions.**
- **The whole family is add-on**, not core (`@adorn/resilience` / `@adorn/limit` / `@adorn/idempotency`), decided on "behaviours are add-ons, the factory is the product" + statefulness — explicitly **not** on dependency weight (these are light). `@Time`/`@Log` remain the only core behaviours. The one enabling core change is the `concern` band (GAP-12/DEC-043).
- **BUILD:** `@Retry` (attempt cap + data-shaped backoff), `@Timeout` (races the *settlement*; states the "cannot cancel — may leave a mutation half-done" limit up front), `@Fallback`, `@RateLimit` (token bucket, reject-or-bounded-queue), `@ConcurrencyLimit`/`@Queue` (bulkhead; `@Queue` = `ConcurrencyLimit(1)`, the deleted `queue.ts`/SMELL-6 intent), `@CircuitBreaker` (reified state machine), `@Idempotent` (the safety pair that makes `@Retry` correct).
- **REJECT:** `@Debounce`/`@Throttle` on awaited methods — dishonest by construction (cannot return a result to every caller; they belong on fire-and-forget handlers, where rxjs/lodash already win); Observable/stream flow control (a worse rxjs → `@adorn/rx`). **DEFER:** `@Deadline` (needs an `AsyncLocalStorage` ambient substrate adorn lacks — Q-25-adjacent).
- **State + settling:** cross-call state is per-instance `WeakMap<receiver, State>` (the BUG-3 rule verbatim); argument keys inherit BUG-11/BUG-15, and under a guard a key collision is a **validation bypass** (Q-22), not a stale value. All settling reuses `settle` (DEC-006, never a second classifier); a dropped/throttled/retried/queued call is a value-free `{kind:'flow'}` O1 event (additive to the DEC-035 union). Composition safety: see DEC-043.

## DEC-043 — The reified `concern` registry band + install-time composition-hazard lints (resolves Q-22)
**Status:** ACCEPTED · the cross-cutting decision **both DEC-041 and DEC-042 depend on** · resolves Q-22 · built as GAP-12

**Context.** The add-on and flow-control decisioning agents **independently** concluded that `@adorn/cache` and the entire flow-control family need the same thing: a way to know what a composed decorator *is*.

**Decisions.**
- Build a reified **`concern` registry band** — DEC-008's deliberately-deferred `categories` axis — a decorator-agnostic record of which **concern** each installed behaviour represents (`cache`, `rate-limit`, `guard`, `authz`, …). Built once in Core (GAP-12); it is the shared prerequisite, and its build timing is Q-26.
- Because decorator composition is registry **data** (order normalised at record time — DEC-017), adorn runs an install-time, **decorator-agnostic composition lint** over the concern band. **Report-only by default** (the DEC-028 stance), with **strict refusal reserved for the genuinely dangerous orderings**: a `cache`/dedup concern recorded **outside** a `guard`-trust contract or an `@Authorize` concern (privilege escalation / validation bypass — Q-22). The escape-hatch shape is Q-25.
- **Class-level `@Contract()` makes the safe ordering free**: the enforcement weave installs **outermost** (a class decorator running after member decorators), so guard-before-flow-control/cache and postcondition-on-final-result hold **by construction**. The per-method `@Validate()` form is order-sensitive (mirrors the DEC-032 `@Ensures` caveat) — which is where the lint earns its keep.
- This turns Q-22 from an open hazard into a designed-in safety property, and opens a composition-hazard / operational-profile projection reading the concern band (IDEA-19).

---

## DEC-044 — Add-on peer-dependency & isolation contract (the ecosystem-wide rule)
**Status:** ACCEPTED · generalises DEC-019 to every add-on · first applied by `@adorn/otel` (DEC-046)

**Decision.**
- Every add-on's heavy dependency is a **peer** (declared in the add-on's manifest), a **devDependency** in this repo for build/test, and **never** a core `dependencies` specifier — the core runtime set stays `{tslib}`. This is the rxjs `MODULE_NOT_FOUND` lesson (DEC-019) generalised.
- Every add-on ships an **isolation test** mirroring `addons/test/isolation.test.ts`: its heavy dep appears in no `src/` file and not in `index.ts`, has **zero requires in `dist/`**, and no add-on symbol leaks onto the root surface (frozen at 72 — DEC-039).
- Add-ons live under `addons/<name>/`, are excluded from the build (not in `dist`), are **not** re-exported from the root, and are tested in-repo by the shared jest config — the `@adorn/test` pattern.

## DEC-045 — Add-on extraction contract (consume the frozen surface, not internals)
**Status:** ACCEPTED · pairs with DEC-039 · first validated by `@adorn/otel` (DEC-046)

**Decision.**
- An add-on's **production** code consumes only adorn's frozen public surface (DEC-039), imported from the package root exactly as a downstream consumer would, plus its own peer dep. Registry writers/`*Keys` and other Core internals are off-limits (test scaffolding may use `reset*` helpers, as the whole suite does).
- What each add-on needs public is the measurable extraction cost: **`@adorn/otel` needs NOTHING new** (the O1 seam was built complete — DEC-046 proved it end-to-end); `@adorn/rx` needs one symbol (`setObservableConstructor`, SMELL-16); `@adorn/cache` needs the `concern` band (GAP-12) + a blessed concern-recording seam + a composition read. An add-on that finds it needs an unplanned internal is a signal the surface is incomplete — resolved by a deliberate export, never a reach-in.

## DEC-046 — `@adorn/otel`: the O1-event → OpenTelemetry mapping
**Status:** ACCEPTED · builds IDEA-14/DEC-041 · confirms DEC-045 · ships in `addons/otel/`

**Decision.** `createOtelSink(options?)` returns an `ObservationSink` a host installs via the public `setObservationSink`; the host owns its OTel SDK (tracer/meter injected, else the global provider). Mapping: `scope` → active span (SpanKind mapped, pre-disclosed param attributes); `completed` → an opt-in duration histogram; `violation` → `recordException` + ERROR status + a value-free span event (+ opt-in counter); `message` → a span event.

**The two non-obvious rulings this build forced.**
- **The span is ended inside `scope` via the exported `settle`, NOT on the `completed` event.** The O1 event union carries **no per-call correlation token** — a record-path event shares only the frozen, *non-unique* `Observation` reference with its `scope` call, so under concurrent same-method async an event cannot be matched back to its span. Ending in `scope` via `settle` is per-call robust **and** reuses the same classifier that produces `completed.durationMs`, so the span duration *is* the settled duration and cannot drift (DEC-006) — exactly what `settle.ts` and DEC-041 §3 intended. The correlation gap itself is logged as **Q-27**. **[Superseded by DEC-047]** — the correlation token now exists, so `@adorn/otel` ends the span at its correlated `completed` event instead (Option B), and the return-rendering-on-span win this ruling noted as unreachable is delivered.
- **Violations attach to the active-or-standalone span.** adorn's enforcement wrapper is *outside* `@Observe`'s span (a precondition throws before the span opens; a postcondition after it settles), so a violation never coincides with its own method's live span. It is recorded on the currently-active span (the enclosing observed operation) when one exists, else a short standalone span — never silently lost.

**"Seeing ≠ emitting" (DEC-036) preserved end-to-end.** Attributes come only from pre-disclosed `EmittedValue.rendering` and value-free facts; the sink never reads a raw arg/return to emit (the `scope` wrapper sees the raw outcome only for span status + `recordException` on a developer-authored throw — DEC-025). Pinned by a disclosure test: a `@Telemetry.value()` param appears on the span, an un-opted one is `[REDACTED]`, and the raw value appears nowhere. **DEC-045 held** — the add-on needed nothing new on the frozen surface, the first proof the O1 seam is a complete public contract.

---

## DEC-047 — Per-call correlation id on the O1 event union; `@adorn/otel` ends the span at its correlated `completed`
**Status:** ACCEPTED · resolves Q-27 · supersedes DEC-046's first ruling (the end-in-`scope` workaround)

**Decision.**
- Added a **required** `callId: number` to `ObservationCall` and all three `ObservationEvent` variants (`completed`/`violation`/`message`), sourced from a shared **process-local monotonic counter** (`nextCallId()` in `Core/Observation.ts` — internal, off the frozen root surface, so the count stays **72**). **Required is additive-safe**: sinks *receive* events (they never construct the union) and the `ObservationSink` interface is unchanged, so no implementer breaks — DEC-035's "frozen but additive" holds at the reader boundary. A monotonic counter (not `Date.now()`/`Math.random()`) — deterministic, collision-free among live calls, zero-cost.
- **One id per observed invocation**, minted after the NOOP fast-path so uninstalled/unobserved calls allocate nothing: `@Observe` stamps it on its `scope` call **and** its `completed`; the enforcement weave stamps it on its `violation`(s) **and** its `completed`. **Same-wrapper correlation only** — cross-wrapper (a `@Contract` weave violation vs. an inner `@Observe` span — different nesting levels, DEC-046) is out of scope by construction (they carry distinct ids); noted in the code.
- **`@adorn/otel` uses it via Option B: the span is ended at its correlated `completed`, not in `scope`.** Option A (enrich-before-end in `scope`) is *impossible*, not merely racy — the disclosed return rendering only exists on the `completed` record event, which is emitted strictly after `scope` settles, so there is no enrich-before-end window. So `scope` opens the span + registers `Map<callId,{span,startTime}>`; `settle` sets status/exception (control-flow only, DEC-025/036); the correlated `completed` adds `adorn.return` from the pre-disclosed `EmittedValue` at `RETURN_INDEX` and ends the span at `startTime + durationMs`. A completion whose id opened no span ends nothing (weave-only completions), so the DEC-037 single-`completed` reconciliation still yields exactly one end, and the map entry is deleted on end (no leak).

**Preserved:** settled duration with no drift (end = start + settled `durationMs`, DEC-006), "seeing ≠ emitting" (only pre-disclosed renderings become attributes; the raw return is never read, DEC-036), spans end exactly once, violations unchanged (DEC-046). The return-rendering-on-span win DEC-046 flagged as unreachable is now delivered — pinned by a test (`@Telemetry.result()` renders `adorn.return`, an un-opted return is absent, no raw leak).

---

## DEC-048 — Prescriptive tool schemas: a second schema posture for LLM tool-calling
**Status:** ACCEPTED (design) · detail in `docs/decision-tool-schemas.md` · complements DEC-029 · driven by real-world feedback (AiVoiceAgent-ts)

**Context.** LLM tool-calling needs both a JSON Schema the model reads **and** runtime validation of the model's (untrusted) arguments — two artifacts that normally drift, which is exactly DEC-006, and a *stronger* case than docs because the consumer is a machine that confidently produces malformed args when the schema is wrong. The runtime-validation half is **already** `@Contract` enforcement; only the schema *shape* is missing.

**Empirical finding (`spike/tool-schemas.ts`): a fillable gap, not a fundamental mismatch.** Parameter names are already in the registry (BUG-14/`captureSignature`); `schema.ts.methodSchema` merely emits a positional `prefixItems` tuple. A method's named parameter *list* IS the tool's argument object, so re-keying the same merged fragments by name builds the tool schema mechanically — no fragment logic re-derived.

**Decisions.**
- **Two postures, two consumers (the DEC-029 reconciliation).** `schemaForClass` is **descriptive** — "a value enforcement accepts", validated-*against* → must under-claim (DEC-029), never falsely reject. A tool schema is **prescriptive** — "the argument object the producer must send", generated-*from* → **tight** (`required` + `additionalProperties:false`), steering the model with `@Contract` enforcement as the backstop. Tight is NOT over-claiming against enforcement — it aligns the producer's target with what enforcement accepts. Different consumer, different direction, no contradiction with DEC-029.
- `required` = **"carries ≥1 constraint"** — sound, not a guess: total predicates (BUG-4/Q-7) already reject a missing `undefined` argument. TS `?`/defaults are unrecoverable (Q-10) and rejected as a source (the optional-but-constrained edge is **Q-28**). `additionalProperties:false` is the one prescriptive assertion — honest because a method's parameter set is closed.
- **Shape:** a new sibling entry `toolSchemaForMethod(C, 'method', {description?})` (NOT a flag on `schemaForClass`), emitting `{type:'object', properties:{<name>:fragment}, required:[…], additionalProperties:false, description}`, reusing `mergeFragments`/`schemaFragmentsOf` (no fork — DEC-010), reading Core+Contracts only (DEC-012). Tracked as **IDEA-20**.
- **The enum gap (GAP-14 / IDEA-21):** tool schemas need enums, adorn has none. A reified `@OneOf([...])` (kind `generic`, predicate = membership, `schema()` → `{enum:[…]}`) is the highest-value small add — strengthens schema + docs and gives fuzzing a sound `fc.constantFrom` for free.
- **Nested objects (Q-29):** the flat param-list convention + self-contained *inline* expansion of a `@Contract`ed field class, never `$ref` (many function-calling endpoints don't resolve it); the real limiter is advisory param types (DEC-004). **Descriptions (Q-30):** `@Tool(desc)`/entry-point arg for the tool, `describe()` as the free param default, a deferred `@Describe` for semantics; JSDoc rejected (runtime-only, DEC-007).

**Build order:** (1) `@OneOf` (IDEA-21), (2) `toolSchemaForMethod` (IDEA-20), (3) defer nested + `@Describe`/`@Optional`. **End-to-end payoff verified:** one `@GreaterThanEqual(1) @LessThanEqual(7)` yields both the schema the model reads (`{minimum:1,maximum:7}`) and the runtime predicate `@Contract` enforces — same `params`, cannot drift.

## DEC-049 — Tool schemas shipped (`@OneOf` + `toolSchemaForMethod`); the schema omits `$schema`
**Status:** ACCEPTED · ships DEC-048's steps 1–2 (IDEA-21/GAP-14, IDEA-20) · surface 72 → 75

**Decisions.**
- **`@OneOf([...])` shipped** (IDEA-21, fills GAP-14): a `kind:'generic'` reified membership descriptor; predicate is **strict `===` membership** (total; `===` over `Object.is` because the latter's `-0/+0` and `NaN` divergences are both wrong for JSON membership); `schema()` → `{enum: […]}` which is **exact — neither over- nor under-claims** (the constrained-decoding target a tool schema wants); `describe()` renders members as JSON; `OneOf()` rejects an empty/non-array/non-primitive/`NaN`/`Infinity` member at authoring. Flows into schema + docs, and the add-on maps it to a sound `fc.constantFrom` (DEC-031's ideal case, no fork). Exports: `OneOf` (parameter decorator) + `EnumContracts` (namespace).
- **`toolSchemaForMethod(C, method, {description?})` shipped** (IDEA-20): the **prescriptive** params-as-object schema, a sibling of the untouched **descriptive** `schemaForClass`, reusing `mergeFragments`/`schemaFragmentsOf` (no fork — DEC-010), Core+Contracts only (DEC-012). `required` = carries-≥1-constraint (DEC-048), `additionalProperties:false`, property names from `param.name` (SMELL-1 caveat). The no-drift claim is executable-pinned (a value the schema rejects is one the installed `@Contract` throws on).
- **The one shipped-shape decision: the tool schema OMITS `$schema`.** A prescriptive tool schema is a *parameters sub-schema handed to an LLM function-calling provider* (OpenAI/Anthropic tool `parameters`), not a standalone JSON-Schema document — and several providers reject unknown top-level keys — so omitting the dialect anchor is the more correct artifact. `schemaForClass`, a standalone document, still emits `$schema`. This diverges from DEC-048's *illustrative* example (which listed `$schema` by analogy); the omission is deliberate.

**Consequence.** The public surface grew 72 → **75** (`OneOf`, `toolSchemaForMethod`, `EnumContracts`); `test/public-surface.test.ts`'s pinned count was updated — the DEC-039 deliberate-change signal working as designed. 52 suites / 964 tests.

## DEC-050 — Compositional descriptors: carry the inner constraint as data, rebuild its predicate once
**Status:** ACCEPTED · **BUILT** (Wave-1 Slice A: `@ArrayOf`, `src/Contracts/array.ts`) · detail in `docs/plan-contract-offering.md` + `impl-plan-contract-wave1.md` · also unlocks nested shapes (IDEA-25/GAP-16)

**Context.** A descriptor's `params` must be JSON (round-trippable — DEC-010) but its `predicate` is a function, so a descriptor that constrains a *collection* whose items each satisfy an inner constraint (`@ArrayOf(itemConstraint)`), or an *object* against a class's contracts (`@Shape(FieldClass)`), cannot store the inner descriptor or its predicate directly. This is the crux that made "does adorn do object/array params?" look like it might be a wall.

**Decision.** A **compositional descriptor** carries the inner constraint as its **serialized JSON** (`descriptor.toJSON()` → a `SerializedConstraint` that survives `normalizeParams` verbatim) inside its params, and **rebuilds the inner predicate exactly once in `derive`** via `constraintFromJSON` — the same pattern `matches` uses to compile its `RegExp` once at derivation. The predicate stays derived-from-params (DEC-010 holds), the whole descriptor JSON round-trips, the projection inherits the inner descriptor's own `schema()` fragment (`{type:'array', items:<item fragment>, minItems?, maxItems?}` for arrays; the class's field schema for shapes), and the fuzzer **recurses** (`fc.array(itemArb, …)` / the object's field generators) — sound by construction (DEC-031). Verified end-to-end in a spike (a full `toJSON`→`constraintFromJSON` round-trip + total-predicate behaviour).

**Consequence.** One mechanism covers the compositional third of the vocabulary — arrays (IDEA-22), nested shapes (IDEA-25), and nullable — without a `$ref` graph (which schema.ts deferred and which tool providers often don't resolve; shapes inline-expand instead).

## DEC-051 — `@Optional` is enforcement-aware, not schema-only (or it drifts)
**Status:** ACCEPTED · **BUILT** (Wave-1 Slice B: `@Optional`/`@Default`, required-wins inheritance) · detail in `docs/plan-contract-offering.md` + `impl-plan-contract-wave1.md` · resolves Q-28

> **Inheritance is required-wins (adversarial-review fix S2).** `@Optional` is a precondition *weakening*, so it obeys DEC-022's parameter strengthen-only discipline: effective-optional iff `@Optional` is marked on ≥1 declaration AND **no** declaration on the chain requires the position (has ≥1 own constraint without `@Optional`). A subclass can always *re-require* an inherited-optional param; it can **never** silently weaken a required one (DEC-016). Enforcement (an absent-arg guard hoisted above the per-position checks, skipping only its own index) and the tool-schema `required` derive from the **same** effective read, so they cannot drift. `@Default(v)` implies `@Optional` and emits the non-asserting `{default:v}` annotation (safe to emit — validators ignore it — unlike an unbacked `format`); adorn does not inject the default at runtime. Four invariants pinned by test.

## DEC-052 — Wave-1 finish: description markers (`@Describe`/`@Tool`) + validating string formats
**Status:** ACCEPTED · **BUILT** (Wave-1 Slice C) · amends DEC-048/DEC-049 · completes Wave 1 (surface 79 → 85)

**Decisions.**
- **`@Describe('…')` (parameter) + `@Tool('…')` (method)** — record-only NL description markers (two registry bands, twins of the telemetry bands). `@Describe` → a property's `description` (its **sole** source — no `describe()` fallback); `@Tool` → the tool schema's top-level `description`, which the `toolSchemaForMethod({description})` option **overrides**. Both also flow into the docs projection (a *conditional* Description column keeps the existing table byte-identical when absent).
- **S1 (adversarial-review fix) — `toolSchemaForMethod` unions the marker bands, it does not pivot on the contract band.** It resolves a method site from (contract entry ∨ description-band site) and unions the contract-band parameter indices with the `@Describe`-marked indices (the telemetry-band `getTelemetry*` union helpers as the template). Consequences: a **`@Tool`-only method with no constrained params projects** — `{…, properties:{}, required:[], additionalProperties:false, description}` — instead of NPE-ing (the reviewer's probe-confirmed bug); a **`@Describe` on an unconstrained param surfaces** (was silently dropped). This amends DEC-048's projection description.
- **Validating string formats (`@Uuid`/`@DateTime`/`@Ipv4`, S3).** Each is a real descriptor with a **total, strict** predicate and `schema()` → `{type:'string', format:'…'}`. The predicate must be **at-least-as-strict as the `format` keyword** or the schema over-claims (DEC-029): `date-time` uses a strict RFC-3339 regex with real-calendar checks (rejecting `2021-02-29`, Feb-30, hour 25 — deliberately NOT `Date.parse`, which accepts a superset), `uuid` the canonical 8-4-4-4-12, `ipv4` 0–255 octets. A per-format **over-claim-direction test** pins `predicate-accepts ⊆ format-accepts`. `@Format(name)` is a keyed alias refusing an unknown name loudly; **annotate-only (unbacked) formats are deferred** — emitting an unvalidated `format` is the exact over-claim.

**Consequence.** **Wave 1 is complete** — arrays (DEC-050), optional/default (DEC-051), markers+formats (DEC-052). The capstone e2e (an `@ArrayOf` + `@Optional` + `@Describe` + `@Uuid` tool method) asserts the exact tool schema **and** enforcement agreement, so the whole vocabulary composes with no schema/enforcement drift. Deferred to Wave 2+: `@Const`/`@Nullable` (IDEA-24), `@Shape` nested objects (IDEA-25/GAP-16), `@Requires` cross-parameter (IDEA-26); and format fast-check arbitraries (an `@ArrayOf(Uuid())` item currently *declines* soundly — a coverage, not correctness, gap).

**Context.** The tool schema marks a parameter `required` iff it carries ≥1 constraint (DEC-048), so a genuinely optional-but-constrained parameter is force-required. The tempting fix — a **schema-only** `@Optional` that just drops the parameter from `required` — is **drift**: the schema would say "omittable" while the total predicates (BUG-4) still throw on a missing `undefined` argument. That schema/enforcement disagreement is the exact failure adorn exists to prevent (DEC-006).

**Decision.** `@Optional` is **enforcement-aware**: the installer treats an absent/`undefined` argument as *satisfying* the constraint (the check is skipped when the argument is absent, and runs normally when present), **and** the projections drop the parameter from tool-schema `required`. One declaration moves the runtime behaviour and the schema together, so they cannot drift. Semantics: "may be absent, OR must satisfy the constraint when present." (`@Default(value)` rides the same record-only-marker seam and additionally emits `{default:value}`.)

## DEC-053 — A non-throwing imperative check: `Verify.check` returns a discriminated result
**Status:** ACCEPTED · **BUILT** · extends Q-6/DEC-039 · resolves AiVoiceAgent-node round-2 §3 · surface unchanged (85)

**Context.** Round-2 consumer feedback (`feedback/2026-08-03-ai-voice-agent.md` §3) supplied the concrete Q-6 consumer DEC-039 said did not exist. adorn's enforcement throws, and its imperative entry `Verify.that` throws; the decorator path throws `ViolationError`, deliberately **not** exported (Q-6). But an HTTP handler at an untrusted I/O boundary must turn a bad body into a `400` **as a value, in this call** — not as an exception to catch, and not out-of-band through the observation sink (an async stream of facts, the wrong shape for choosing *this* response's status synchronously). With the error unexported, the only bridge was `error.name === 'ViolationError'` — a string compare against a hidden class, strictly worse for the semver surface than the alternatives.

**Decision.** Add `Verify.check(constraint, keyName, value): CheckResult<T>` — a non-throwing sibling of `Verify.that`, returning a discriminated union `{ok: true, value} | {ok: false, message, constraint, kind}`. Same predicate, same **redacted** message (`shouldDiscloseValue(false)`, DEC-030) as `that` would have thrown; the failure additionally carries the descriptor's `constraint` identity and `kind` so a boundary can map a violation to a status/code programmatically. The received value is **not** included on the result (the message is already redacted, and the caller holds the value).

**Why this shape — and why it is in character, not a departure.**
- A `ConstraintDescriptor` is *data + a predicate that never throws* (DEC-010; the `Verify.ts` module note is explicit that deciding what a failure *means* belongs to an enforcement layer). `Verify.check` simply declines to make the throw decision — so it is philosophically **more** aligned with the descriptor model than `Verify.that`, not a widening of the throw-based posture.
- It reuses the exact predicate and message call `Verify.that` uses, so the two cannot diverge — no second implementation (Q-4/DEC-010). A parity test pins the returned message byte-for-byte against the thrown one.
- **`ViolationError` stays internal.** The non-throwing path removes the only concrete reason to export it; `Verify.check` returns adorn's own structured result, so Q-6's "no consumer for the typed error" holds. §3(b) (export the error as a type) is therefore **declined** — the boundary case is solved without widening the class surface.

**Surface.** `check` is a method on the already-exported `Verify` class and `CheckResult<T>` is a type-only export, so neither moves the pinned value-export count (85) — consistent with DEC-039. It is nonetheless a deliberate public API addition (semver-minor).

**Scope, stated honestly.** This gives the *imperative* boundary a returned-value path; a handler composes it with the exported descriptor namespaces — `Verify.check(NumberContracts.Between(1, 7), 'days', body.days)` — which is exactly the untrusted-input use case. It does **not** turn the *decorator* enforcement path non-throwing (that stays throw-based by design, DEC-008/DEC-035). It also does not address §4 (predicates don't narrow `unknown`, `Verify.that` returns the input type) — that is structural (a guard-shaped predicate needs generic `ConstraintDescriptor<T>` against a `strict:false` tsconfig) and is folded into the typed-descriptor direction (IDEA-28), not solved here.

## DEC-054 — Object vocabulary, Slice 1: `@Dictionary` — the OPEN map (`Record<string, V>`)
**Status:** ACCEPTED · **BUILT** (Wave-2 Slice 1) · a DEC-050 consumer · resolves AiVoiceAgent-node round-2 §2 (the open-dictionary half) · surface 85 → 87

**Context.** The round-2 §2 blocker was `slotInput?: Record<string, string>` — an **open dictionary** (arbitrary keys, string values). The Wave-2 adversarial review (MAJOR-1) caught that `@Shape` (a *fixed-key* DTO, `additionalProperties:false`) is the **opposite** shape and does not express it, so the consumer's actual field needs its own descriptor. Two object kinds, distinct because their JSON-Schema closure is opposite; the user chose to build both, dictionary first.

**Decision.** `@Dictionary(valueDescriptor)` — a compositional descriptor (DEC-050, the `@ArrayOf` mechanism) for an open map. Predicate: a **total** plain-object gate (rejects `null`/array/non-object, BUG-4) ∧ every value satisfies the rebuilt value predicate (rebuilt **once** in `derive` via `constraintFromJSON`); keys are strings by construction; the empty map passes (no `minProperties` bound in v1). Schema: `{type:'object', additionalProperties:<value's schema() or {}>}` — **open by construction**, inheriting the value's under-claim. `ObjectContracts.Dictionary` is the descriptor factory (a new namespace, the second compositional one after `ArrayContracts`); `@Dictionary` the parameter decorator over it.

**Posture note.** DEC-029 bans `additionalProperties` on a class-instance **root** (an instance may carry extra fields). A `@Dictionary` *fragment* is different: `additionalProperties:<value schema>` is the constraint's honest meaning — *every* value matches — so it is under-claim-safe and correct in both `schemaForClass` (descriptive) and `toolSchemaForMethod` (prescriptive); a dictionary is inherently open, so the tool projection does **not** tighten it to `additionalProperties:false` (that is `@Shape`'s closure — DEC-055). Layering (DEC-012): `Contracts/object.ts` imports only `Core/Descriptor`.

**Surface.** +`@Dictionary` decorator +`ObjectContracts` namespace = 85 → 87; `DictionaryParams` is type-only. Enforcement + tool schema derive from one declaration and agree (a `''` value the schema's value-fragment rejects is the same one the runtime predicate rejects) — DEC-006.

## DEC-055 — Object vocabulary, Slice 2: `@Shape` — the CLOSED DTO + recursive prescriptive tightening
**Status:** ACCEPTED · **BUILT** (Wave-2 Slice 2) · a DEC-050 consumer · resolves GAP-16 / IDEA-25 / Q-29 · surface 87 → 88

**Context.** The general nested-object gap (GAP-16): a tool argument that is a structured, fixed-key object. Reprioritized ahead of `@Const`/`@Nullable` (round-2 §2), and the Wave-2 review's three MAJOR findings are folded in below.

**Decision.** `@Shape(FieldClass)` — a compositional descriptor (DEC-050) validating an object against `FieldClass`'s `@Contract`ed **instance** fields. Predicate: a **total** plain-object gate (BUG-4) ∧ every field's rebuilt constraint stack holds on `value[name]`; a **missing** field is `undefined`, which the total field predicates reject, so every contracted field is required (present AND valid). `ObjectContracts.Shape(FieldClass)` reads `getFieldContractsForClass` at authoring time (DEC-007 ordering; statics excluded; DEC-021 inheritance honoured) and stores `{fields:{name: SerializedConstraint[]}}`; `@Shape` the parameter decorator over it.

**Posture — one hook, tightened by the projection (not forked).** `schema()` emits the **descriptive** `{type:'object', properties}` (no `required`/`additionalProperties`), so `schemaForClass` under-claims (DEC-029). `toolSchemaForMethod` applies a new recursive `tightenObjects` to each parameter fragment: a fixed-key object (carries `properties`, not already an open map) is closed with `additionalProperties:false` and `required` = **every emitted field**; the recursion descends array `items` and an open dictionary's `additionalProperties` (which stays open), so a `@Shape` nested in `@ArrayOf`/`@Dictionary` tightens too. Only `toolSchemaForMethod` tightens — `schemaForClass` is untouched.

**The three review MAJORs, resolved.**
- **MAJOR-1 (scope):** `@Shape` (fixed keys) is NOT the consumer's `Record<string,string>` blocker — that is `@Dictionary` (DEC-054, shipped first). `@Shape` fills the general GAP-16 for fixed DTOs.
- **MAJOR-2 (drift):** nested `required` = **all** emitted fields, NOT the plan's "non-empty fragment" rule — a constrained field whose descriptor has no `schema()` hook emits `{}` yet its predicate still rejects `undefined`, so the plan's rule would have marked it optional while enforcement required it. All-fields-required matches enforcement exactly (pinned by a drift-parity test: runtime rejects a missing field ⇔ the tool schema lists it required).
- **MAJOR-3 (silent empty shape):** `Shape(FieldClass)` **throws** when `FieldClass` has no contracted instance field (undecorated / not-yet-defined / not a class) — an empty shape would accept any object, the "looks complete, isn't" failure DEC-006/DEC-016 reject.

**v1 limits, stated.** A nested field cannot yet carry `@Optional`/`@Default`/`@Describe` (those are param-index bands, not field bands), so a `@Shape` has no optional-but-constrained field and no per-field description. A field carrying `@Shape` PLUS another constraint serialises as `allOf`, which the tightener does not descend (rare; the common single-constraint nested object tightens). Layering (DEC-012): `Contracts/object.ts` imports `getFieldContractsForClass` from `Core` — allowed (the guard forbids only `Adapters/`; the read takes a constructor, no decorator types).

**Surface.** +`@Shape` decorator (rides the existing `ObjectContracts` namespace) = 87 → 88; `ShapeParams` is type-only.

## DEC-056 — Wave-2 polish: `@Const` (single literal) + `@Nullable` (null-widening combinator)
**Status:** ACCEPTED · **BUILT** (Wave-2 #6) · resolves IDEA-24 · surface 88 → 91

**`@Const(value)`.** The single-literal sibling of `@OneOf` — predicate `value === v`, projecting to the exact `{const: v}` keyword. Shipped as a **distinct identity** (in `Contracts/enum.ts`, on the existing `EnumContracts` namespace) rather than an alias of `@OneOf([v])`, because it reads better in every artifact: `describe` = "exactly v", `schema` = `{const: v}` (the natural keyword a validator and a model both understand), fuzzer → `fc.constant(v)`. Total (BUG-4); `value` must be a JSON primitive (same rule as `@OneOf` members), so it round-trips (DEC-010). Exact, never an under-claim. `const` added to the projection's `KEY_ORDER` beside `enum` (the review's MINOR-3).

**`@Nullable(item)`.** A compositional combinator (DEC-050, the `@ArrayOf` mechanism) that widens any constraint to also accept `null` — the principled home for "may be **null**", deliberately distinct from `@Optional`'s "may be **absent** (`undefined`)"; combine them for "omittable OR null". Predicate: `value === null || itemPredicate(value)` (the `null` short-circuit runs *before* the item predicate, so a total item that would reject `null` does not veto the explicit allow). Schema: a single string `type` widens to `[<type>, 'null']` (every other keyword only bites the non-null branch, so `{type:['string','null'], minLength:5}` is exactly "string≥5 OR null"); a no-single-`type` inner (`enum`/`const`) becomes `{anyOf:[<inner>, {type:'null'}]}` (exact); a hookless `{}` stays `{}`. Lives in `Contracts/nullable.ts` on a new `NullableContracts` namespace. **Nullable ≠ optional:** a `@Nullable` param carries a constraint and is not `@Optional`, so it stays in the tool schema's `required` (the model must send it — as a value or explicit `null`).

**v1 limit, stated.** `@Nullable(@Shape(...))` emits `type:['object','null']`, which the tool tightener (DEC-055) keys on `type === 'object'` and therefore leaves open (a nullable object is not recursively tightened) — under-claim-safe, just less tight; a clean extension later.

**Surface.** +`@Const` decorator (`EnumContracts.Const` rides the existing enum namespace) +`@Nullable` decorator +`NullableContracts` namespace = 88 → 91; `ConstParams`/`NullableParams` are type-only.

## DEC-057 — `@Requires`: cross-parameter preconditions, the input-side twin of `@Ensures`
**Status:** ACCEPTED · **BUILT** (Wave-2 #7) · resolves IDEA-26, advances IDEA-6 · surface 91 → 94

**Context.** Cross-parameter relations (`start < end`; "if mode=custom then config required") are the highest-marginal-value contract rules and the hardest to maintain by hand (IDEA-6). They relate **multiple parameters**, so they are not a per-position `ConstraintDescriptor` (which tests one value) and cannot ride the existing bands.

**Decision.** `@Requires((...args) => boolean, description?)` — a method decorator recording a **closure** into a new `preconditionsByTarget` band, the exact input-side twin of `@Ensures`'s `postconditionsByTarget`. The class-level `@Contract()`/`@Validate()` installs enforcement, which runs the closure **before** `proceed()`, under the method's `trust` and blaming the **caller** — precisely where reified per-position constraints run, and after them (so a specific-parameter violation is reported first). A predicate that throws is a precondition *failure*, not a method crash.

**Why a closure band, not the reserved descriptor `pre` slot.** Identical reasoning to `@Ensures`/DEC-032: a closure relating several args carries no identity or serialisable params (Q-3/SMELL-14), so it is enforceable and fuzzable but **not projectable** — a `@Requires`-only method emits an empty tool schema and nothing into docs, the accepted `@Ensures` trade applied to the input side. The reserved `MethodContract.pre` *descriptor* slot stays reserved for a future reified precondition. The `dependentRequired`/`if-then` *projectable* subset is the deliberately-deferred later slice (#8).

**One oracle, two consumers (no drift).** `evaluatePreconditions(pres, args)` is the single function BOTH the runtime wrapper and a fuzz driver call — so a fuzzer filtering its generated arguments through it checks byte-for-byte what enforcement rejects, and never mistakes a precondition it violated for a method crash (DEC-006). It is exported alongside `getEffectivePreconditions` (the inheritance-aware read the installer and fuzzer consume) exactly as the postcondition twins are.

**Inheritance.** `getEffectivePreconditions` unions base-most-first down the prototype chain (DEC-022): a subclass may strengthen, never weaken, and an override that redeclares nothing still inherits its parent's `@Requires` — the installer collects effective precondition keys so the override is wrapped. This is DEC-022's considered departure from classical contravariant weakening, the same ruling parameter constraints already follow.

**Surface.** +`@Requires` decorator +`getEffectivePreconditions` (public read) +`evaluatePreconditions` (oracle) = 91 → 94. Writer (`recordPrecondition`) + `*PreconditionKeys` helpers stay internal (Q-6); `PreconditionResult` is type-only. Fuzzer *integration* (addons/test consuming the filter) is deferred — **now BUILT, see DEC-058.**

## DEC-058 — `@Requires` in the fuzzer: filter the generated tuple through the enforcement oracle
**Status:** ACCEPTED · **BUILT** · completes DEC-057's deferred fuzzer integration · `addons/test/` only, root surface unchanged (94)

**Context.** DEC-057 shipped `@Requires` enforcement + the `evaluatePreconditions` oracle but deferred the fuzzer integration: the `@adorn/test` generator produced per-position-valid tuples that violate a cross-parameter precondition, the still-live guard threw `"Precondition failed: …"`, and `isAdornViolation` (only the `"Value Error:"` prefix) misclassified it as an `unexpected-throw` — a **false positive**. Built via plan (`plan-requires-fuzzing.md`) → adversarial review → the two user decisions below.

**Decision.** In `prepareRun` (`oracle.ts`), gate the composed argument tuple through `preconditionGate`: read `getEffectivePreconditions(entry.target, method)` and, when non-empty, `baseArgs.filter(args => evaluatePreconditions(pres, args).ok)` — the **exact** read + oracle enforcement runs (`checkPreconditions`), consumed from the public root like the postcondition reads. A precondition relates multiple parameters, so it is a **whole-tuple** gate (it cannot live in a per-parameter arbitrary); generate-and-filter is the only sound option (a `@Requires` closure is an un-invertible black box, Q-3/DEC-031). `filter-admits(x) ⟺ enforcement-accepts(x)`, so a passing tuple can never trip the installed guard — the hole is provably closed, and fast-check re-applies `.filter` under shrinking so counterexamples stay precondition-valid.

**The two review resolutions (user-chosen).**
- **Scope (finding F):** a `@Requires`-*only* method (no per-position constraint) still can't be fuzzed — its argument arity is unrecoverable without a per-position decorator (Q-10). Shipped the mixed-case filter (the real fix) and corrected the decline reason to name the `@Requires` + arity limit instead of the misleading "no contract recorded" (`methodHasPreconditions`). Fuzzing `@Requires`-only methods stays deferred to the arity work.
- **Starvation (finding C):** fast-check's `.filter` is an *unbounded loop with no starvation throw* (verified against 4.9.0) — so the measured **0%-acceptance decline** is the sole guard against an infinite draw, not a fast-check backstop. Kept the shipped per-position discipline (0%→decline, `<25%`→warn) rather than a distinct auto-decline floor; a cross-parameter precondition starves combinatorially worse, documented in the warning. The false "fast-check throws" claim was struck from the plan and the pre-existing `oracle.ts:201` comment.

**Surface.** Purely add-on-internal: reads only the already-public `getEffectivePreconditions`/`evaluatePreconditions`; `measureAcceptance` exported from `arbitraries.ts` (not the root); root count stays **94**; fast-check stays a devDep (DEC-044 intact). +9 tests in `addons/test/requires-fuzzing.test.ts`.

