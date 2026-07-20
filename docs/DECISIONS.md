# adorn — Decision Log

Architectural and directional decisions, with the reasoning that produced them and the consequences accepted alongside them. Lightweight ADR format.

> **Maintenance convention:** this file is kept current as work proceeds. Any choice that constrains later work gets an entry — including choices left deliberately **open**, so the open question is visible rather than implicit. Bugs, smells, and gaps go in [ISSUES.md](ISSUES.md) instead.

**Status legend:** `ACCEPTED` · `OPEN` (decision required) · `SUPERSEDED` · `REJECTED`

---

## DEC-001 — `positive` rejects `< 0`, not `<= 0`
**Status:** ACCEPTED · 2026-07-19 · commit `a2ddc5f`

**Context.** `Verify.positive` threw when the value *was* positive — an inverted condition contradicting its own error message. Fixing it required choosing a boundary.

**Decision.** Reject `value < 0`, matching the existing sibling `Positive` parameter decorator.

**Consequences.** Internal consistency is preserved, but `0` is accepted as "positive," so the name and the semantics disagree. Left unresolved and tracked as **Q-1**; whichever way it is settled must be applied across `Positive`, `Verify.positive`, and any future `Negative`.

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
**Status:** OPEN

**Context.** `Configuration` exists but is never consulted (**SMELL-4**). Every mature contract system makes checks toggleable — but a single boolean is unsafe.

**Open question.** Preconditions guarding *untrusted external* input generally must **not** be stripped; internal self-checks and invariants commonly can be. This requires per-contract or per-category semantics rather than one global switch. Tracked as **Q-2**.

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
