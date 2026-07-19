# adorn — Implementation Plan: Tier 0 & Tier 1

> **Status:** planning document. No source under `src/` or `index.ts` has been modified by this plan.
> **Scope:** the Tier 0 (foundational) and Tier 1 (high-ROI) work, plus the repo-level enablers (tests, build, toolchain) that Tier 0 depends on.
> **Decorator-model dependency:** **resolved** — the parallel research recommends a *dual-track* (legacy per-parameter **and** method-level `@Contract`). See [§8](#8-the-decorator-model-dependency-resolved).

---

> ### ⚑ Revision — project goal elevated
>
> A former far-horizon speculation is now a **primary project goal**:
>
> > *the contract stops being only a runtime guard and becomes the single source from which documentation, validation, and tests all descend*
>
> adorn is to drive **four artifacts from one declaration**: validation, documentation, testing, and fuzzing.
>
> This does **not** invalidate the plan's findings or its sequencing — the `__decorate` discovery ([§1.1](#11-the-objectdefineproperty-monkey-patch-is-compensating-for-__decorate--and-it-is-a-cross-feature-landmine)) and the strict `P1.2 → P1.3 → P1.4` ordering stand unchanged. It changes **what a contract is made of**, and therefore what must be settled *before* Phase 3 writes fifteen new constraints.
>
> Sections revised for this goal are marked **[Revised]**. The load-bearing consequence is [§1.5](#15-revised-contracts-are-currently-opaque-closures--incompatible-with-the-new-goal) and the new [§9](#9-projecting-contracts-into-artifacts-revised).
>
> **Landed since this plan was written:** P0.1 (packaging specifiers) shipped in `0a54e8d`.

---

## 1. Findings that shape the plan

Five things change what the work actually is. They are load-bearing, so they are stated before the plan. §1.1–§1.4 came from re-reading the source; **§1.5 comes from the elevated project goal** and is the one that reshapes scheduling.

### 1.1 The `Object.defineProperty` monkey-patch is compensating for `__decorate` — and it is a cross-feature landmine

`DecoratorFactory.OverrideObjectDefineProperty` (`src/Core/common.ts:24-33`) replaces the global `Object.defineProperty` with a one-shot no-op that restores itself on first call. It is armed at the end of the first parameter decorator (`ParameterDecoratorFactory.ts:108`).

The reason: for a method carrying parameter decorators, TypeScript emits

```js
__decorate([__param(0, StringMinLength(10))], Task.prototype, "test", null);
```

and `tslib`'s `__decorate` is:

```js
function (decorators, target, key, desc) {
    var c = arguments.length,
        r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    ...
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
```

With `desc === null`, `r` is the descriptor captured **before** the decorators run. `__param` returns `undefined`, so `r` is never replaced. The trailing `Object.defineProperty(target, key, r)` therefore **restores the original method**, clobbering the wrapper that `CreateSimpleDecorator` assigned at line 106. The patch exists solely to swallow that one call.

Two consequences:

- **This is not incidental cruft.** Deleting the patch without changing *how the wrapper is installed* breaks parameter decorators outright. Removal and re-architecture are the same task.
- **It silently breaks unrelated code.** Between arming and `__decorate`'s call, *any* `Object.defineProperty` is swallowed. Concretely: a class with both a parameter-decorated method and an `@Enforce`-decorated field can have the field decorator silently no-op, because `Enforce.generator` (`src/FieldDeocrators/Enforce.ts:6`) is itself a `defineProperty` call. This is a reproducible cross-feature bug and should become a regression test.

**Implication:** the wrapper must be installed through the descriptor `__decorate` writes back, not by imperative assignment. Under legacy decorators a parameter decorator cannot do this (its return value is ignored), so installation must be driven by a **method-level or class-level** decorator. This is the central architectural change in Tier 0.

### 1.2 `Enforce` is broken well beyond the argument wiring already fixed

`Enforce.generator` defines a property with `configurable: false`, a setter, and **no getter**, and the setter **never stores the value**:

```ts
Object.defineProperty(target, key, { configurable: false, set: v => func(v, key, target) });
```

So `@Enforce.positive()` makes the field permanently `undefined` — the value is validated and discarded. Additionally `target` is the **prototype**, so the accessor is shared across instances, and `configurable: false` means a second decorator on the same field throws. The recently-fixed argument order was necessary but not sufficient; the field path needs a real backing store.

### 1.3 `index.ts` will not work as a published package

Lines 2-4 use non-relative specifiers:

```ts
import {Enforce} from 'src/FieldDeocrators/Enforce';
```

These resolve at compile time only because of `baseUrl: "./"`. TypeScript **does not rewrite module specifiers**, so the emitted `dist/index.js` contains `require("src/FieldDeocrators/Enforce")`, which Node resolves against `node_modules` and fails. Line 1 is relative and fine. With `main: "dist/index.js"`, the package as configured is non-functional when installed. Also, `tsconfig.json` has no `declaration: true`, so a TypeScript library ships **no type definitions**.

> **Update:** the specifier half is **fixed** (`0a54e8d`) — `tsc` exits 0, all four emitted requires are relative, and `require('./dist/index.js')` loads with all 8 exports resolving. The **missing `declaration: true`** remains open and is still part of [P0.2](#p02--modernize-the-toolchain).

### 1.4 Runtime parameter names are not fully recoverable — plan honestly

`getParamNames` (`common.ts:13-17`) slices between the first `(` and the first `)` and splits on non-comma/whitespace. It breaks on destructured parameters (`{a, b}`), defaults containing parens (`a = f()`), parenless arrows (`x => x`), and — unavoidably — **minification**, which renames parameters.

There is no runtime source of parameter *names* in JavaScript other than parsing source text. `emitDecoratorMetadata` provides `design:paramtypes` (types), not names. Any claim to "replace `toString()` parsing with something robust" must be scoped to: harden the parser, degrade gracefully, and allow explicit override. Perfect fidelity under minification is not achievable at runtime.

### 1.5 [Revised] Contracts are currently opaque closures — incompatible with the new goal

This is the finding the elevated goal forces, and it is the reason Phase 3 cannot be written as originally specified.

Today a constraint is a *function that throws*:

```ts
const Positive = () => simpleDecor((params: ParamObject<number>) => {
    if (params.value < 0) throw new Error(`...`);
});
```

That closure is a black box. You can **run** it; you cannot **ask it anything**. From it you cannot derive a documentation line, a JSON-Schema/OpenAPI fragment, or a value generator for property testing — because the constraint's *identity* (`min`) and its *parameters* (`0`) exist only as instructions inside a function body, never as data.

**A contract must become data, not just behavior.** Each constraint needs a **reified descriptor** carrying its identity and parameters, with the runtime predicate derived from — or attached to — that descriptor:

```
ConstraintDescriptor = {
  kind:       'number' | 'string' | 'generic'    // domain
  constraint: 'min' | 'between' | 'matches' | …  // identity
  params:     { min: 0 }                         // the data projections read
  predicate:  (value) => boolean                 // enforcement
  message:    (ctx) => string                    // formatting
  arbitrary?: () => Arbitrary                    // generation  (optional)
  schema?:    () => object                       // JSON Schema (optional)
}
```

Validation uses `predicate`. Documentation reads `constraint` + `params`. Testing and fuzzing need `arbitrary`. One declaration; four consumers.

**The scheduling consequence is the important part.** [P3.3](#p33-revised--expanded-preconditions-as-descriptors) writes roughly fifteen new constraints. Writing those as opaque closures and retrofitting descriptors afterwards is precisely the rework to avoid — it would mean touching every constraint twice and re-testing all of them. **The descriptor shape must therefore be settled in Phase 1, before Phase 3** (new [P1.0](#p10-revised--the-constraint-descriptor-model)).

**Honest limit, stated once and not softened:** `arbitrary` is *optional* and cannot be synthesized for a hand-written predicate. An arbitrary user predicate remains a black box to a generator. The fallback — generate broadly and filter — degrades badly for narrow predicates (fast-check's `.filter()` gives up after too many rejections). So generative coverage will be **good for built-in constraints and partial for user-authored ones**. Descriptors are what make the built-in case tractable at all; they do not make the general case solvable.

---

## 2. [Revised] Organizing principle: decorator-agnostic core, thin adapter, projections on top

Everything below is arranged so that the parts sensitive to the decorator-model decision are small and isolated. **The revision adds a third band:** the registry and descriptors are not merely internal plumbing, they are the *published surface* that projections consume.

```
src/
  Core/
    Descriptor.ts           ← decorator-agnostic  (reified constraint model)  ★ new
    ContractRegistry.ts     ← decorator-agnostic  (metadata store + PUBLIC introspection)
    ResultAdapter.ts        ← decorator-agnostic  (sync | Promise | Observable)
    Violation.ts            ← decorator-agnostic  (error construction, stack)
    Configuration.ts        ← decorator-agnostic  (trust model, toggling)
    ParamNames.ts           ← decorator-agnostic  (hardened parser + fallback)
  Contracts/                ← decorator-agnostic  (constraint DESCRIPTORS, not bare predicates)
    string.ts  number.ts  common.ts
  Adapters/
    legacy/                 ← SENSITIVE: experimentalDecorators surface
      ParameterDecoratorFactory.ts
      MethodDecoratorFactory.ts
      FieldDecoratorFactory.ts
    stage3/                 ← SENSITIVE: method-level @Contract surface
  Projections/              ← consumes the registry; NOT in T0/T1 scope   ★ future
    docs.ts  schema.ts  arbitraries.ts  fuzz.ts
```

**Rule (unchanged):** descriptors, registry, result handling, configuration, and message formatting never import a decorator type. Only `Adapters/*` touches `target`/`propertyKey`/`descriptor`/`context`. If the decorator model changes, the rewrite is confined to `Adapters/`.

**Rule (added):** `Projections/*` may depend on `Core/` and `Contracts/`, and on **nothing else** — never on an adapter. A projection must work identically whichever decorator model produced the registry entries. This is what keeps "four artifacts from one declaration" from quietly becoming "four artifacts from the legacy decorator syntax."

The layering was already the highest-value structural decision in the plan. Under the elevated goal it stops being merely insurance against the decorator-model question and becomes **the mechanism the flagship feature is built on** — the same registry that installs wrappers is the one a documentation generator walks.

---

## 3. Phase 0 — Scaffolding (do first; unblocks verification)

Nothing else can be verified without this. All of Phase 0 is independently shippable and **insensitive** to the decorator-model decision.

### P0.1 — Fix packaging-breaking imports ✓ **LANDED** (`0a54e8d`)

- **Goal:** make the emitted package actually loadable.
- **Approach:** change `index.ts:2-4` to relative specifiers (`./src/...`). Optionally keep `baseUrl` for internal convenience but never rely on it across the public entry point.
- **Files:** `index.ts`.
- **Risk:** none.
- **Verify:** `npm pack`, install the tarball into a scratch project, `require('adorn')`.

### P0.2 — Modernize the toolchain

- **Goal:** get onto a TypeScript that can even *evaluate* Stage-3 decorators, and emit types.
- **Approach:** TypeScript `^3.6.4` → `^5.x`. Keep `experimentalDecorators: true` (TS 5.x still supports it; Stage-3 is opt-*out* via this flag). Add `declaration: true`, `declarationMap`, `sourceMap`. Align `lib` with `target` (currently `target: es2019` but `lib: [es2018, dom]`). Add `"types"` to `package.json`. Pin `rxjs` — it is currently `"latest"`, which is non-reproducible; move it to `peerDependencies` + `optionalDependencies` with a real range, since only `Memoize` needs it.
- **Files:** `tsconfig.json`, `package.json`.
- **Risk:** TS 5 is stricter than 3.6 even without `strict`; expect new errors in `common.ts` (implicit `any` on `getParamNames(func)`) and `Verify.ts`. **Do not enable `strict` yet** — stage it after Phase 1, or the diff becomes unreviewable.
- **Verify:** `npx tsc --noEmit` clean; `dist/index.d.ts` exists.

### P0.3 — Build & packaging scripts

- **Goal:** a real build.
- **Approach:** add `"build": "tsc"`, `"clean"`, `"prepublishOnly": "npm run clean && npm run build"`, and a `"files": ["dist"]` allowlist. Keep `dist/` gitignored.
- **Files:** `package.json`.
- **Verify:** `npm run build` produces `dist/index.js` + `.d.ts`.

### P0.4 — Real test suite

- **Goal:** replace the demo script with assertions. Contract code is exactly what needs them.
- **Approach:** **ts-jest**. Rationale: it uses the real TypeScript compiler, so `experimentalDecorators` *and* `emitDecoratorMetadata` work with zero extra config. Vitest is faster but transforms via esbuild, which **does not support `emitDecoratorMetadata`** — a hard blocker if P1.5's type-checking uses `design:paramtypes`. (Vitest + `unplugin-swc` would work; it is more moving parts for a solo prototype. Revisit if test runtime becomes painful.)
- **Move** `src/Tests.ts` → `examples/demo.ts`, exposed as `npm run demo` via `ts-node`. Replace `"test": "node dist/src/Tests.js"` with `"test": "jest"`.
- **Write characterization tests first**, capturing *current* behavior — including the known-bad cases, marked `it.failing` / `it.todo`:
  - parameter constraints pass/throw at the right boundaries;
  - the §1.1 cross-feature bug (param-decorated method + `@Enforce` field in one class);
  - `@Enforce` field readback returning `undefined` (§1.2);
  - inheritance: subclass decorating an inherited method;
  - `Function.length` and `.name` preservation on wrapped methods.
- **Files:** `package.json`, `jest.config.js`, `test/**`, `examples/demo.ts`.
- **Verify:** the suite goes green on current behavior with the known bugs marked; those markers flip to passing as Phase 1–3 land. This is the regression net for everything that follows.

---

## 4. Phase 1 — Core: descriptors, registry, installation, wrapper correctness

This is Tier 0 proper. **P1.0 blocks P1.1 and P3.3; P1.2 blocks P1.3; P1.3 blocks P1.4.**

### P1.0 [Revised] — The constraint descriptor model

> **New, and scheduled first.** This exists because of [§1.5](#15-revised-contracts-are-currently-opaque-closures--incompatible-with-the-new-goal). It is a pure type-and-helpers module with no runtime behavior of its own, so it is cheap — but it must land **before P3.3 writes fifteen constraints**, or every one of them gets rewritten.

- **Goal:** make a constraint *data* that carries a predicate, rather than a predicate that hides data.
- **Approach:** define `ConstraintDescriptor` (shape in §1.5) plus a `defineConstraint()` helper that builds one from `{kind, constraint, params, predicate, message}` and lets `arbitrary`/`schema` be supplied or omitted. Built-in constraints supply all fields; user-authored ones supply the minimum and degrade gracefully.
  - **Derive, don't duplicate.** For parameterised constraints the predicate should be *generated from* `params` (`min: 0` → `v => v >= 0`) so the data and the check cannot drift. Drift here would be the worst possible bug class: documentation that says one thing while enforcement does another.
  - Keep it **serialisable**: `params` must be plain JSON-able data. A `RegExp` needs an explicit source/flags representation. Anything not serialisable cannot be projected into a schema or a doc artifact.
- **Files:** new `src/Core/Descriptor.ts`.
- **Risk:** over-design. The temptation is to invent a full constraint algebra (unions, negation, conditionals) up front. **Resist** — model exactly what the built-ins need, and let Tier 2's cross-parameter work extend it. An unused abstraction here is pure cost.
- **Verify:** a descriptor round-trips to JSON and back; a derived predicate agrees with its `params` across boundary cases; a descriptor without `arbitrary` is still fully usable for validation and documentation.

### P1.1 [Revised] — `ContractRegistry` (decorator-agnostic, **and publicly introspectable**)

- **Goal:** decouple *recording* a contract from *authoring syntax* and from *installation* — and, newly, expose the recording as a **supported public API**, since every projection reads it.
- **Approach:** a `WeakMap<object /* prototype or ctor */, Map<string|symbol, MethodContract>>`, where

  ```
  MethodContract = {
    params: Array<{ index, constraints: ConstraintDescriptor[], name?: string, type?: Function }>,
    pre:  ConstraintDescriptor[],   // reserved (cross-parameter, Tier 2)
    post: ConstraintDescriptor[],   // reserved (Tier 2) — see §9 on why this matters more now
    installed: boolean,
  }
  ```

  Note `predicates: Predicate[]` has become `constraints: ConstraintDescriptor[]`. Lookups remain **own-property scoped** (see P1.6) so a subclass never mutates a parent's contract. `WeakMap` avoids the expando properties (`parameterDecorated`, `parameterDecorators`) currently stamped onto the function object at `ParameterDecoratorFactory.ts:43-44`.

- **⚠ Conflict the new goal creates — `WeakMap` is not enumerable.** A `WeakMap` is ideal for *lookup* ("what contracts does this prototype have?") and leak-free by design. But a documentation or fuzzing tool needs the opposite operation: *enumeration* ("what classes in this codebase have contracts?"). A `WeakMap` cannot answer that, by construction. The original P1.1 design silently assumed lookup was the only access pattern.

  **Resolution — keep both, for their different jobs:**
  - the `WeakMap` stays the authoritative per-prototype store used on the hot path;
  - the `@Contract()` class installer (P1.3) additionally appends the constructor to an **enumerable registry** (`Set<Function>`) that projections iterate.

  The `Set` holds **strong** references, so contracted classes are never collected. In practice classes are module-scoped and live for the process lifetime anyway, so this is acceptable — but it is a real trade and is recorded as such, not waved past. Gate the enumerable registry behind an opt-out for anyone who cares.

- **Public API:** `getContract(target, key)`, `getContracts(target)`, `getContractedClasses()`. These become **semver-relevant surface** the moment a projection depends on them — a consideration that did not exist when the registry was purely internal.
- **Files:** new `src/Core/ContractRegistry.ts`.
- **Risk:** low as a data structure; the real risk is **API commitment** — introspection shape is now something external tools bind to. Version it deliberately.
- **Verify:** registry contents after decoration match expectations, including a subclass case; `getContractedClasses()` returns exactly the `@Contract()`-annotated classes that have been imported; descriptors survive round-trip retrieval.

### P1.2 — `MethodDecoratorFactory` (the only sanctioned installation path)

- **Goal:** fill the empty `src/Core/MethodDecoratorFactory.ts` and make it the single place a wrapper is installed.
- **Approach:** `CreateMethodDecorator(behavior)` returns a decorator that **replaces `descriptor.value` and returns the descriptor**. Because `__decorate` does `r = d(target, key, r) || r` and then defines `r`, a returned descriptor is honored — no global patching required. This is precisely what the current design lacks.
  The wrapper composes: `configuration gate → parameter checks → invoke → result adaptation`.
- **Files:** `src/Core/MethodDecoratorFactory.ts` (currently empty).
- **Risk:** decorator *evaluation* order. Parameter decorators run before method decorators on the same member, so the registry is populated by the time installation runs — but only within one `__decorate` call. Cross-member ordering is handled by P1.3's installation strategy.
- **Verify:** a method decorated only via this factory keeps `name`, `length`, and `this`; `Object.defineProperty` is never patched.

### P1.3 — Re-home parameter decorators onto registry + explicit installation

- **Goal:** parameter decorators record; something else installs.
- **Approach — decision required.** Two viable shapes under legacy decorators:

  | Option | Ergonomics | Robustness | Stage-3 migration |
  |---|---|---|---|
  | **A1 — `@Contract()` class decorator** installs wrappers for every method with registry entries | one annotation per class | high; class decorators run *after* all member decorators, so metadata is complete | **best hedge** — a class-level installer is the natural Stage-3 shape too |
  | **A2 — `@Validate()` method decorator** per method | one annotation per method | high | fine, but noisier |
  | **A3 — keep the monkey-patch** | zero annotations | unacceptable (§1.1) | — |

  **Recommendation: A1.** It costs one annotation per class, eliminates the global patch, is correct under inheritance, and — critically — is the same installation topology a Stage-3 migration would need. A2 can be offered as an opt-in for fine-grained control.

  **This is a breaking change to the public API**: `@StringMinLength(10)` alone will no longer take effect without `@Contract()` on the class. That must be a loud release note plus a dev-mode diagnostic (see below).
- **Mitigation for the DX regression:** in development mode, if the registry holds contracts for a class that was never installed, emit a one-time warning naming the class and the missing `@Contract()`. This converts a silent no-op into a directed error — cheap and high value.
- **Files:** `src/Adapters/legacy/ParameterDecoratorFactory.ts`, new `src/Adapters/legacy/ClassContractInstaller.ts`, `index.ts` (export `Contract`).
- **Risk:** the silent-no-op failure mode if a user forgets `@Contract()`. The dev warning is the countermeasure and is **not optional**.
- **Verify:** existing constraint tests pass with `@Contract()` added; a test asserts the dev warning fires when it is omitted.

### P1.4 — Delete `OverrideObjectDefineProperty`

- **Goal:** remove the global patch.
- **Approach:** delete the method from `common.ts` and its call site. Only safe **after** P1.3.
- **Files:** `src/Core/common.ts`, `src/Adapters/legacy/ParameterDecoratorFactory.ts`.
- **Verify:** the §1.1 cross-feature regression test (param-decorated method + `@Enforce` field) flips from failing to passing. Add an assertion that `Object.defineProperty === <original reference>` after module load.

### P1.5 — Hardened parameter names, plus type checking

- **Goal:** stop producing garbage names; deliver on the long-standing `// TODO : Confirm the parameter type matches that of the decorator used.` (`ParameterDecoratorFactory.ts:29`).
- **Approach:**
  - **Names:** replace the naive slice with a small balanced-delimiter scanner that tracks `()`/`[]`/`{}` depth and strips default-value expressions, so destructuring and defaults do not corrupt the split. Detect the parenless-arrow form. When a name cannot be recovered — or looks minified (single/double char, high-entropy) — fall back to `arg0`, `arg1`, …, and allow an explicit override supplied at the decoration site. Document plainly that minified builds get positional names.
  - **Types:** with `emitDecoratorMetadata`, read `Reflect.getMetadata('design:paramtypes', target, key)` to assert a `@Positive()` is not sitting on a `string`. This makes `reflect-metadata` a real dependency — **and note the interaction:** once `reflect-metadata` is loaded, `__decorate` takes its `Reflect.decorate` branch. Semantics are equivalent for our purposes, but P1.3/P1.4 must be re-tested with it loaded, not just without.
- **Files:** new `src/Core/ParamNames.ts`; `src/Core/common.ts` (remove `getParamNames`); `package.json`.
- **Risk:** `design:paramtypes` is erased for interfaces/unions/generics (emits `Object`); type checking must be advisory, never a hard failure on `Object`.
- **Verify:** table-driven tests over method shapes — plain, defaults with call expressions, destructured, rest, arrow property, async, overloads.

### P1.6 — Wrapper correctness: inheritance, `length`, arrow properties

- **Goal:** fix the real bugs in the wrapper, distinct from the installation problem.
- **Approach:**
  - **Inheritance (genuine bug):** `ParameterDecoratorFactory.ts:35` reads `target[propertyKey]`, which resolves *through the prototype chain*. A subclass decorating an inherited method finds the **parent's** wrapper, sees `parameterDecorated`, and pushes into the parent's decorator list (line 38) — corrupting the base class for every other subclass. Fix: use `Object.getOwnPropertyDescriptor(target, propertyKey)` and treat an inherited method as a fresh contract on the subclass.
  - **`Function.length`:** the wrapper is `function (...args)`, so `length === 0`. The comment at lines 87-88 claims otherwise and is wrong. If arity matters (DI containers, currying), define `length` explicitly via `Object.defineProperty(wrapper, 'length', {value: original.length})`. Low cost; do it.
  - **`this`:** already correct — the wrapper is a `function` and uses `.apply(this, args)`. No change. (Detached-method calls lose `this`, but that is equally true of the undecorated method; not adorn's bug.)
  - **Arrow class properties:** for `foo = (x) => ...`, the member is an *instance* field, absent from the prototype at decoration time, so `target[propertyKey]` is `undefined` and line 36 throws a `TypeError`. Detect and throw a clear, actionable error instead. (Supporting them properly requires per-instance installation — defer to Tier 2.)
  - Replace the property-copy loop (lines 96-99) with `Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original))`-style copying that preserves non-enumerables, minus `length`/`name`/`prototype` handled explicitly.
- **Files:** `src/Adapters/legacy/*`.
- **Verify:** the inheritance and arity characterization tests from P0.4 flip to passing.

### P1.7 — Result adaptation: sync | Promise | Observable

- **Goal:** settle async **once**, in the core, because postconditions, `@Time`, resilience, and flow control all need it.
- **Clarifying note:** *preconditions do not need this.* They run synchronously before invocation and are async-agnostic. This module exists for everything that must observe the **outcome**.
- **Approach:** `ResultAdapter.adapt(result, { onValue, onError })` that classifies and preserves the kind:
  - **sync** — pass through, `try/catch`;
  - **thenable** (`typeof result.then === 'function'`) — `.then/.catch`, returning a Promise;
  - **Observable** (duck-typed `typeof result.subscribe === 'function'`) — must **not** subscribe eagerly, or side effects fire twice and cold Observables break. Wrap with `tap`-equivalent semantics.
  - **rxjs must stay optional.** Duck-type the detection; import rxjs operators lazily and only when an Observable is actually seen. This keeps rxjs a peer/optional dependency (P0.2) rather than a hard one.
- **Files:** new `src/Core/ResultAdapter.ts`.
- **Risk:** the eager-subscription trap is the main one. Also note `Memoize` (`src/MethodDecorators/promise/Memoize.ts:21-32`) currently caches on `target[cacheMember]` — the **prototype**, so the cache is shared by all instances, never invalidated, and **ignores `args` entirely**. Out of scope here, but `ResultAdapter` is the foundation for fixing it; file it as Tier 2.
- **Verify:** each kind preserved end-to-end; a cold Observable's producer runs exactly once; rejected Promises and Observable error channels both surface.

---

## 5. Phase 2 — Field decorators

### P2.1 — `FieldDecoratorFactory`

- **Goal:** fill the empty `src/Core/FieldDecoratorFactory.ts` and make field contracts actually work (§1.2).
- **Approach:** `CreateFieldDecorator(predicate)` defines an accessor pair with **per-instance backing storage** — a module-level `WeakMap<object, Map<key, value>>`, or a `Symbol`-keyed own property on the instance. Getter returns the stored value; setter validates *then stores*. Use `configurable: true` so multiple decorators can stack and so tooling can redefine. Support an initial-value path so field initializers are validated too.
- **Files:** `src/Core/FieldDecoratorFactory.ts`, `src/Adapters/legacy/FieldDecoratorFactory.ts`.
- **Risk:** with legacy decorators the accessor is defined on the **prototype**; the WeakMap keyed by instance is what makes per-instance state correct. Prototype-level accessors plus instance-level storage is the standard resolution.
- **Verify:** read-back returns the assigned value (currently `undefined`); two instances hold independent values; invalid assignment throws and leaves the prior value intact.

### P2.2 — Rebuild `Enforce`; fix the directory typo

- **Approach:** re-express `Enforce.positive()` on P2.1. Rename `src/FieldDeocrators/` → `src/FieldDecorators/`.
- **Note:** `Verify.positive` now rejects `value < 0`, so `0` passes. That is consistent with the `Positive` parameter decorator but the naming is ambiguous, and P3.3 adds `Negative`. **Settle the semantics now:** either rename to `nonNegative`, or make `positive` strict (`<= 0` throws) and add `nonNegative`. Recommend the latter; it matches the mathematical reading and avoids a confusing pair. This is a **behavioral break** and needs a release note.
- **Files:** `src/FieldDecorators/Enforce.ts`, `src/Validation/Verify.ts`, `index.ts`.
- **Verify:** field tests from P0.4 flip to passing.

---

## 6. Phase 3 — Tier 1 payload

Depends on Phase 1. Items are largely independent of each other.

### P3.1 — Error messages that teach

- **Goal:** kill the fragile stack surgery; make violations self-explanatory.
- **Approach:** replace

  ```ts
  const stackSteps = e.stack.split('\n');
  e.stack = stackSteps[0] + '\n' + stackSteps.slice(3).join('\n') + '\n';
  ```

  (`ParameterDecoratorFactory.ts:78-82`) which hard-codes "exactly 2 frames of adorn internals" and breaks whenever wrapper depth changes. Use **`Error.captureStackTrace(err, wrapperFn)`** (V8), which elides everything above the given function without counting frames; on non-V8 engines leave the stack untouched. **Guard non-`Error` throws** — today a thrown string makes `e.stack` `undefined` and `.split` raises a `TypeError`, masking the original failure.
- Introduce a `ContractViolation extends Error` carrying structured fields (`objectName`, `funcName`, `paramName`, `index`, `expected`, `actual`, `signature`) so messages are formatted in one place and are machine-readable.
  - **[Revised] This is no longer speculative.** The original plan justified the structured error as useful "later (Tier 4's codegen ambitions)". Under the elevated goal it is **load-bearing now**: a fuzzing run reports failures by the thousand, and triage depends on violations being machine-readable — grouping by `constraint` identity and `paramName` rather than by string-matching prose. Add the originating `ConstraintDescriptor` to the violation so a failure points back at the declaration that produced it.
- **Files:** new `src/Core/Violation.ts`; adapters.
- **Verify:** thrown stacks point at the **caller's** line, not adorn internals; wrapping depth can change without touching tests; a thrown non-Error propagates unchanged.

### P3.2 — Configuration & the trust model

- **Goal:** wire the unused `Configuration` (`src/Core/DecoratorConfiguration.ts`), *without* a single unsafe boolean.
- **Approach:** classify every contract by **trust level**, not just category:
  - `guard` — validates untrusted/external input. **Never stripped by the production switch.**
  - `assert` — internal self-check. Strippable in production.

  Config shape:

  ```
  {
    mode: 'development' | 'production',
    enforce: { guard: 'always', assert: boolean },
    onViolation: 'throw' | 'warn' | (violation) => void,
    categories: { parameter?, field?, postcondition?, concern? }
  }
  ```

  Resolution order: **per-decorator option → category → global mode**. Each decorator factory accepts `{ trust?, enabled?, onViolation? }`. Disabling a `guard` requires an explicit, loudly-logged opt-out. Default new parameter/field contracts to `guard` (safe default), letting authors down-grade to `assert` deliberately.
- Evaluate the gate **once per call at the wrapper's top**, not per predicate.
- **Breaking:** replaces `ErrorOnFieldConstraintMismatch`. It is currently referenced nowhere, so the cost is nil.
- **Files:** `src/Core/Configuration.ts` (replacing `DecoratorConfiguration.ts`), adapters, `index.ts`.
- **Verify:** production mode strips `assert` and retains `guard`; `onViolation: 'warn'` returns normally after logging; per-decorator override beats global.

### P3.3 [Revised] — Expanded preconditions, **as descriptors**

> **⚠ This section contained the plan's sharpest contradiction with the new goal.** It originally specified authoring each validator as a *pure predicate* — `(value, ...args) => boolean | ViolationDetail`. That was the right instinct for decorator-independence, and it is still **wrong under the elevated goal**: a bare predicate is decorator-agnostic *and* opaque. It survives a decorator-model change untouched but tells a documentation or fuzzing tool nothing. Fifteen constraints written this way is fifteen rewrites.

- **Goal:** deliver the `index.ts` roadmap block. Each validator is **independently shippable**.
- **Approach:** author each constraint in `src/Contracts/` as a **`ConstraintDescriptor`** (P1.0) — identity + params + derived predicate + message, with `arbitrary`/`schema` supplied for the built-ins. Still decorator-free, still trivially unit-testable; now also projectable. **Hard dependency on P1.0.**
  - *String:* `MaxLength`, `NotEmpty`, `Matches(regex)`, `Url`, `Email`.
  - *Number:* `Negative`, `NonNegative`, `Between(min, max)`, `LessThan`, `GreaterThan`.
  - *Generic:* `OneOf(...values)` / membership, `NotNull`.
- **Supply `arbitrary` for these built-ins while writing them, not later.** Every one is a constraint whose generator is obvious at the point of authoring (`Between(1,10)` → an integer range; `OneOf` → a pick from the set; `Matches` → a literal-sampling fallback, or nothing if the regex is not invertible). Deferring this is how the fuzzing story quietly never happens. Where a good generator genuinely does not exist — `Email`, `Url`, non-trivial `Matches` — supply a curated sample set and **say so in the descriptor** rather than pretending to full generality.
- **Gotchas:** `Email`/`Url` by regex is a well-known tar pit — prefer a conservative, documented-as-approximate pattern (or `URL` parsing for `Url`) over a baroque regex that fails on valid addresses. `StringMinLength` (`Constraints.ts:22-25`) currently reads `params.value.length` with **no null guard** — a `null` argument throws a bare `TypeError` rather than a contract violation. Add null/type guards uniformly across the set.
- **Files:** `src/Contracts/*`, `src/ParameterDecorators/Constraints.ts`, `index.ts`.
- **Verify:** boundary tests per predicate (inclusive/exclusive edges), plus `null`/`undefined`/wrong-type inputs producing proper `ContractViolation`s.

### P3.4 — `@Time` (timing/profiling)

- **Goal:** the roadmap's named method decorator; also the first real consumer of P1.2 + P1.7.
- **Approach:** built on `MethodDecoratorFactory`; measures until the result **settles**, using `ResultAdapter` so Promise- and Observable-returning methods are measured correctly rather than reporting "0 ms" at the point the Promise is created. Emit through a pluggable sink (default `console`), not a hard-coded log, so it can feed real telemetry later.
- **Depends on:** P1.2, P1.7.
- **Verify:** a method sleeping 50 ms reports ≥50 ms in sync, `async`, and Observable forms.

---

## 7. Sequencing

```
P0.1 ✓ landed (0a54e8d) ─┬─ P0.2 ── P0.3
                         └─ P0.4  (characterization tests — the safety net)
                                   │
                                   ▼
P1.0 Descriptor model ★ ───┬──────────────────────────────┐
                           ▼                              │
                    P1.1 ContractRegistry ──┐             │
                    P1.7 ResultAdapter  ────┤  (parallel) │
                                            ▼             │
                                  P1.2 MethodDecoratorFactory
                                            │             │
                                            ▼             │
                                  P1.3 Registry-driven install
                                       + enumerable class registry
                                            │             │
                                            ▼             │
                                  P1.4 Delete monkey-patch│
                                            │             │
               ┌────────────────┬───────────┼───────────┐ │
               ▼                ▼           ▼           ▼ │
          P1.5 ParamNames  P1.6 Wrapper  P2.1 Field  P3.1 Violations
                                            │             │
                                            ▼             │
                                       P2.2 Enforce       │
               │                                          │
               ▼                                          ▼
          P3.2 Config ──────────────────────────► P3.3 Validators ── P3.4 @Time
                                                   (descriptors — needs P1.0)
```

**Independently shippable:** all of Phase 0; **P1.0** (pure types, zero behavior change — the cheapest item in the plan and the one that unblocks the most); P1.1 and P1.7; each P3.3 validator; P3.4 once P1.2+P1.7 land.

**Hard ordering:**
- P0.4 before any Phase 1 behavior change (no net, no confidence).
- P1.2 → P1.3 → P1.4 is strict; deleting the patch earlier breaks parameter decorators outright ([§1.1](#11-the-objectdefineproperty-monkey-patch-is-compensating-for-__decorate--and-it-is-a-cross-feature-landmine)).
- **[Revised] P1.0 → P3.3 is strict.** Writing the fifteen constraints before the descriptor shape exists means writing them twice. P1.0 → P1.1 likewise, since the registry stores descriptors.

**[Revised] Scheduling note.** P1.0 is small, pure, and blocks the widest set of downstream work, so it should land **first in Phase 1** — ahead of the registry. It is the highest leverage-to-effort item in the plan.

---

## 8. The decorator-model dependency (resolved)

> **[Revised] The gate is closed.** The parallel research (`docs/decorators-modernization.md`) resolved this while the plan was being written. Two corrections to the assumptions below, then the outcome.
>
> **Correction 1 — legacy mode is not decaying.** `experimentalDecorators` is absent from the TypeScript 6.0 deprecation list, and the team deliberately ported the legacy emitter — *including the `__param` helper this plan depends on* — to the new Go compiler. Legacy parameter decorators + `emitDecoratorMetadata` were verified compiling and running on **TypeScript 7.0.2 GA** with no deprecation diagnostic. The framing of Branch L as "pinned to a legacy mode" understates its health.
>
> **Correction 2 — the constraint is reach, not survival.** `experimentalDecorators` is a **per-compilation** flag, so the *consumer's* tsconfig governs. A project on standard decorators cannot use adorn's parameter syntax no matter how healthy legacy mode is. That, not deprecation risk, is why a second authoring form is needed.
>
> **Outcome: Branch L *and* Branch S — dual-track, co-equal.** Keep per-parameter decorators on `experimentalDecorators`; build method-level `@Contract({...})` as a peer API, not a fallback. Precedent: `decorator-contracts` migrated this way in 2023, and MikroORM v7 ships exactly this dual-adapter shape. **Per-parameter syntax is not abandoned** — what dies is the assumption it can be adorn's only authoring form.
>
> **Consequence for §2's layering: it is now mandatory, not prudent.** Dual-track without a decorator-agnostic core is simply two divergent implementations.

The sensitivity map and branch sketch below remain accurate as analysis, and are retained because they explain *why* the blast radius is small.

### Sensitivity map

| Sensitivity | Items | Why |
|---|---|---|
| **High** | P1.3 authoring syntax; P1.5 *type* metadata | Stage-3 has **no parameter decorators** and no `design:paramtypes`. The `@Positive()`-on-a-parameter ergonomic is the thing at risk. |
| **Medium** | P1.2, P2.1, P3.4, `Memoize`/`Log` | Stage-3 *has* method and field decorators, but with a different signature — `(value, context)` returning a replacement, plus `context.addInitializer`. The concepts survive; the adapter internals are rewritten. |
| **Low / none** | P0.\*, P1.1, P1.6, P1.7, P3.1, P3.2, P3.3, all of `src/Contracts/` | Pure modules with no decorator-API contact. |

### Branch sketch

- **Branch L — stay on `experimentalDecorators`.** Plan proceeds exactly as written. `@Contract()` class installer (P1.3/A1), `design:paramtypes` available for P1.5 type checks. Cost: pinned to a legacy mode that TypeScript maintains but does not evolve.
- **Branch S — migrate to Stage-3.** Per-parameter decorators disappear. Authoring moves to a method-level spec — positional (`@Requires(Positive(), Between(1, 10))`) or index-keyed (`@Requires({0: Positive()})`) — or a build-time transform injects parameter metadata. Parameter *names* would then come from the spec or the transform, which is **strictly more robust** than §1.4's `toString()` parsing. Field/method decorators map to Stage-3 equivalents; per-instance field storage becomes cleaner via `context.addInitializer`. Cost: a breaking authoring change.

**Placement of the gate:** immediately before **P1.3**. Everything upstream (P0.\*, P1.0, P1.1, P1.2's core, P1.7) is worth building under either outcome. Choosing **A1 (class-level installer)** at P1.3 was the deliberate hedge — a class-scoped installer driven by a decorator-agnostic registry is the topology Branch S needs anyway, so it rewrites `Adapters/legacy/` and leaves `Core/` and `Contracts/` intact.

### [Revised] `@Contract()` is now doing three jobs, not one

The pivot substantially strengthens the A1 recommendation, because the class-level installer turns out to be the natural place for all three responsibilities:

1. **Installation** — the original reason: give `__decorate` a descriptor to write back, eliminating the monkey-patch (§1.1).
2. **Enumeration** — the marker that lets `getContractedClasses()` exist at all (P1.1). A projection tool needs to find contracted classes; a `WeakMap` cannot tell it.
3. **Serialisation surface** — a single method-level `@Contract({...})` declaration is materially easier to introspect and emit than contracts scattered across parameter positions, *and* it is the form that works on standard decorators.

So the same annotation that fixes the `__decorate` problem is also what makes the flagship goal reachable and what carries the dual-track story. That convergence is a genuine argument for A1 over A2, stronger than the original hedging rationale.

**The DX risk hardens correspondingly.** The plan already flags the silent no-op when `@Contract()` is forgotten as its top risk. That was framed as a transitional migration cost; under dual-track it is **permanent**, and it now has a second failure mode — a class missing `@Contract()` is invisible to documentation and fuzzing as well as unenforced, and *silently absent from generated artifacts* is worse than *unenforced at runtime*, because nothing ever throws to reveal it. The dev-mode warning is not optional under any reading.

---

## 9. [Revised] Projecting contracts into artifacts

> **Scope discipline:** the projections themselves are **not** Tier 0/Tier 1 work and are not scheduled here. This section exists so that T0/T1 does not *preclude* them — the entire cost of alignment is P1.0, the registry changes in P1.1, and the descriptor authoring in P3.3. Everything below is the target those choices are aiming at.

### The four consumers of one declaration

| Artifact | Reads | Status after T0/T1 |
|---|---|---|
| **Validation** | `predicate` | Already the product. Works today. |
| **Documentation** (markdown / JSDoc / OpenAPI) | `constraint` + `params` + param names | **Enabled** — descriptors and `getContractedClasses()` are all it needs. |
| **Testing** (property-based) | `arbitrary` + **postconditions** | Enabled only for inputs; blocked on an oracle. |
| **Fuzzing** | `arbitrary` + **postconditions/invariants** | Same. |

### The oracle problem — why postconditions get promoted

This is the most important consequence of the pivot, and it reprioritises Tier 2.

Generate inputs, call the method, and then ask: *did it do the right thing?* Without a postcondition there is no answer. The only property expressible is "it did not throw" — which finds crashes and nothing else. Preconditions alone make adorn a good **input generator** and a poor **test generator**.

With postconditions the loop becomes genuinely valuable:

1. generate arguments that *satisfy* the preconditions (from `arbitrary`);
2. invoke;
3. assert the postconditions hold — **that is the oracle**;
4. separately, generate arguments that *violate* preconditions and assert they are rejected, which tests the contract layer itself.

**Therefore: postconditions move from "Tier 2 nicety" to "prerequisite for the flagship goal."** They remain out of T0/T1 scope — this document is not being expanded to cover them — but they should be the **first Tier 2 item**, ahead of invariants, cross-parameter relationships, and every cross-cutting concern. §12 is updated accordingly. The registry already reserves `post: ConstraintDescriptor[]` (P1.1), so no rework is implied, only sequencing.

### Decision: runtime-registry introspection, not a compile-time transformer

Two ways to get contract data out of a codebase.

| | Runtime registry | Compile-time transformer |
|---|---|---|
| How | import the module, walk the registry | TS transformer / Babel plugin reads the AST and types |
| Cost | ~none — the registry already exists | ts-patch/`ttsc` toolchain, a second implementation |
| Reach | only what is imported and executed | whole program without executing it |
| Type-derived contracts | no | yes (typia-style) |
| Lock-in | none | build-tool lock-in |

**Recommendation: runtime-registry-first.** The registry is being built anyway; a projection is then a script that imports the target module and walks `getContractedClasses()`. "No build-tool lock-in" becomes a real differentiator against typia, which requires a custom compiler pipeline.

**Honest limitation:** runtime introspection requires **executing** the module to populate the registry. That assumes import is side-effect-free, and it cannot see code that is never imported — so a doc generator needs an entry point enumerating the modules to scan, which a static analyser would not. Accepted deliberately: revisit only if type-*derived* contracts become desirable, which is the one thing runtime introspection genuinely cannot do.

### Precedents worth stealing from

- **`clojure.spec`** — the strongest model, and the closest thing to a proof the idea works: one declaration yielding validation *and* generative testing, with `instrument` as the enforcement toggle. Already covered in `docs/contract-driven-development.md`.
- **`fast-check`** — the JS property-testing library to target for `arbitrary`. Note its `.filter()` limitation (§1.5): filtering a broad generator down to a narrow predicate fails loudly rather than silently, which is the right behaviour but bounds what the fallback path can do.
- **`icontract`** (Python) — has contract-driven testing integration, and is the reference for informative violation messages.
- **Racket** — the blame lineage; relevant once postconditions exist, because caller-fault and callee-fault become distinguishable for the first time.

### What is genuinely unproven

Stated plainly, because alignment is not the same as optimism:

- **Arbitraries for hand-written predicates are unsolved** (§1.5). Built-in constraints are tractable; user-authored ones are black boxes. Generative coverage will be **partial** and the docs must say so rather than implying "decorate your code and get a test suite."
- **Postcondition expressiveness is the real difficulty**, not the plumbing. Useful postconditions frequently need prior state (`old()`) and, for anything non-trivial, are as hard to write correctly as the implementation. Adoption may stall here regardless of how good the tooling is.
- **Doc/OpenAPI generation is the safest bet of the four** — it needs only `constraint` + `params`, both of which P1.0 guarantees. It is the sensible first projection to build, and the one most likely to deliver value quickly.

---

## 10. Backwards-compatibility breaks

| Change | Break | Severity | Mitigation |
|---|---|---|---|
| `@Contract()` required on classes using parameter decorators (P1.3) | Yes — silent no-op without it | **High** | Mandatory dev-mode warning naming the offending class; prominent release note |
| `Configuration` replaced by trust-model config (P3.2) | Yes | Nil in practice | `ErrorOnFieldConstraintMismatch` is referenced nowhere |
| `Enforce` fields now store and return values (P2.2) | Behavioral | Medium | Current behavior (always `undefined`) is a bug; note it as a fix |
| `Verify.positive` strictness / `nonNegative` split (P2.2) | Yes | Medium | Pick one, document, keep a deprecated alias for one release |
| `Verify.lessThanEqual(key, target, constraint)` argument order is inconsistent with `positive(keyName, value)` | Yes, if normalized | Low | Normalize now while surface area is tiny |
| `src/FieldDeocrators/` → `src/FieldDecorators/` (P2.2) | Internal only | Nil | `index.ts` re-exports absorb it |
| `src/Tests.ts` → `examples/demo.ts`; `npm test` runs Jest (P0.4) | Yes | Nil | Not public API |
| `rxjs` hard dep → peer/optional (P0.2) | Yes, for `Memoize` users | Low | Document; only `Memoize` needs it |
| **[Revised]** Constraints authored as descriptors, not closures (P1.0/P3.3) | Yes, for anyone who wrote a custom constraint | Low **now**, high later | Surface area is currently four built-ins and no known external users — this is the cheapest it will ever be to change. `defineConstraint()` keeps the authoring ergonomics close to a bare predicate. |
| **[Revised]** `ContractRegistry` introspection becomes public API (P1.1) | No (additive) | — | New surface, but it is now semver-relevant: projections bind to it. Version the shape deliberately from the start. |

---

## 11. Top risks

1. **Silent no-op after P1.3.** A forgotten `@Contract()` means contracts vanish without error — strictly worse than a crash. The dev-mode warning is a **required** part of P1.3, not a nicety.
2. **Removing the monkey-patch out of order.** P1.4 before P1.3 breaks parameter decorators completely (§1.1). The sequence is not negotiable.
3. **`reflect-metadata` changes the `__decorate` path.** Loading it switches `__decorate` to its `Reflect.decorate` branch. P1.3/P1.4 must be tested both with and without it loaded.
4. **Eager Observable subscription in P1.7.** Subscribing to measure or assert duplicates side effects and breaks cold Observables. The single most likely correctness bug in the async work.
5. **Parameter names under minification.** Cannot be solved at runtime (§1.4). Over-promising here produces bad error messages in exactly the environment where they matter most. Ship the `argN` fallback and document the limit.
6. **TS 3.6 → 5.x surfacing latent errors.** Untyped parameters (`getParamNames(func)`) and loose `Verify` signatures will complain. Keep `strict` off through Phase 1; stage it afterward as its own change.
7. **~~Decision-gate drift.~~ [Revised — largely retired.]** The gate is closed (§8): dual-track, both branches. The residual risk is no longer *drift* but **layering erosion** — with two adapters live simultaneously, any leak of decorator concepts into `Core/` or `Contracts/` immediately costs double. The §2 rule now needs enforcing continuously, not just at a migration moment.

**[Revised] Risks added by the elevated goal:**

8. **Descriptor/predicate drift.** If `params` says `min: 0` while the predicate checks `> 0`, then documentation, generated schemas, and enforcement disagree — and the generated artifact *looks* authoritative. This is the worst failure mode the pivot introduces, because it is silent and the artifacts are exactly what people will trust. **Mitigation:** derive predicates from `params` wherever the constraint is parameterised (P1.0), so there is only one source. Where derivation is impossible, test the descriptor against its own predicate at the boundaries.
9. **Over-promising generative testing.** "Decorate your code, get a fuzz suite" is not deliverable for arbitrary user predicates (§1.5, §9). Shipping that expectation produces a worse outcome than shipping nothing: users conclude the tool is broken when it is behaving as designed. Documentation must state the built-in/user-authored coverage split up front.
10. **Premature abstraction in P1.0.** The descriptor model is a type that everything downstream binds to, which creates pressure to make it fully general before anything uses it. A constraint algebra with unions, negation, and conditionals — built before a single projection exists to exercise it — is the most likely way to spend a lot of effort on the wrong shape. Model what the built-ins need; extend under real demand.

---

## 12. Deferred (explicitly out of scope)

Noted so they are not silently lost. **[Revised] — the ordering within Tier 2 has changed.**

**Now the top Tier 2 priority, because the flagship goal depends on it:**

- **Postconditions (`@ensures`, with `old()` prior-state capture).** Promoted ahead of everything else in Tier 2. Without an oracle, generated inputs can only test "it did not throw" (§9). The registry already reserves the slot; this is a sequencing change, not a rework. Invariants follow for the same reason.

**Remaining Tier 2/3, unchanged in priority:**

- **`Memoize` correctness** — prototype-level cache shared across instances, never invalidated, and **ignores arguments entirely** (`Memoize.ts:21-32`). Needs P1.7 first.
- **`src/MethodDecorators/queue.ts`** — an unused `queueScheduler` import; the placeholder for flow control.
- Cross-parameter relationships — Tier 2; will extend the P1.0 descriptor model, which is why that model should not try to anticipate them now (risk 10).
- Arrow-function class properties as decoration targets — needs per-instance installation.
- `strict` mode. Immediately post-Phase 1, as an isolated change.

**The projections themselves (§9) — deferred, but no longer speculative:**

- `Projections/docs.ts` — the recommended first projection; needs only `constraint` + `params`, and is the lowest-risk demonstration that the goal is real.
- `Projections/schema.ts` (JSON Schema / OpenAPI), `arbitraries.ts` (fast-check bridge), `fuzz.ts` — after postconditions land.
- A `stage3/` adapter for the dual-track commitment (§8). Not T0/T1, but the §2 layering must hold for it to be cheap.
