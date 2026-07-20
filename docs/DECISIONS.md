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

**Scope — methods are deliberately not covered.** Whether an overridden *method*'s parameter constraints need an equivalent rule is the parallel case and is **a separate decision**, tracked as **Q-15**. It is not the same rule: a parameter constraint genuinely *is* a Meyer precondition, so classical DbC points at disjunction (weakening) rather than the conjunction adopted here. The current behaviour is nonetheless broken in a way neither reading endorses — see Q-15.

**Tests changed:** both `OPEN QUESTION` tests were **inverted deliberately**, in `test/field-decorators.test.ts` and `src/Core/FieldDecoratorFactory.test.ts`, with the reasoning recorded inline at each. Added coverage: base-before-subclass reporting order, a restated-looser bound, a subclass initializer violating an inherited constraint, a three-deep hierarchy, statics, and the plain-object chain (proving the union is a registry property, not a class-syntax one).

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
