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

