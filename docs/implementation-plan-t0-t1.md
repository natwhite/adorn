# adorn — Implementation Plan: Tier 0 & Tier 1

> **Status:** planning document. No source under `src/` or `index.ts` has been modified.
> **Scope:** the Tier 0 (foundational) and Tier 1 (high-ROI) work identified in the roadmap assessment, plus the repo-level enablers (tests, build, toolchain) that Tier 0 depends on.
> **Open dependency:** the decorator-model question (legacy `experimentalDecorators` vs. TC39 Stage-3) is *not* resolved here. It is being researched in parallel. This plan is deliberately structured so the decision lands late and cheaply — see [§8](#8-the-open-decorator-model-dependency).

---

## 1. Findings that shape the plan

Four things came out of re-reading the source that change what the work actually is. They are load-bearing, so they are stated before the plan.

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

### 1.4 Runtime parameter names are not fully recoverable — plan honestly

`getParamNames` (`common.ts:13-17`) slices between the first `(` and the first `)` and splits on non-comma/whitespace. It breaks on destructured parameters (`{a, b}`), defaults containing parens (`a = f()`), parenless arrows (`x => x`), and — unavoidably — **minification**, which renames parameters.

There is no runtime source of parameter *names* in JavaScript other than parsing source text. `emitDecoratorMetadata` provides `design:paramtypes` (types), not names. Any claim to "replace `toString()` parsing with something robust" must be scoped to: harden the parser, degrade gracefully, and allow explicit override. Perfect fidelity under minification is not achievable at runtime.

---

## 2. Organizing principle: decorator-agnostic core, thin adapter

Everything below is arranged so that the parts sensitive to the decorator-model decision are small and isolated.

```
src/
  Core/
    ContractRegistry.ts     ← decorator-agnostic  (metadata store)
    ResultAdapter.ts        ← decorator-agnostic  (sync | Promise | Observable)
    Violation.ts            ← decorator-agnostic  (error construction, stack)
    Configuration.ts        ← decorator-agnostic  (trust model, toggling)
    ParamNames.ts           ← decorator-agnostic  (hardened parser + fallback)
  Contracts/                ← decorator-agnostic  (pure predicates)
    string.ts  number.ts  common.ts
  Adapters/
    legacy/                 ← SENSITIVE: experimentalDecorators surface
      ParameterDecoratorFactory.ts
      MethodDecoratorFactory.ts
      FieldDecoratorFactory.ts
    stage3/                 ← SENSITIVE: future, only if migration is chosen
```

**Rule:** predicates, registry, result handling, configuration, and message formatting never import a decorator type. Only `Adapters/*` touches `target`/`propertyKey`/`descriptor`/`context`. If the decorator model changes, the rewrite is confined to `Adapters/`.

This is the single highest-value structural decision in the plan and it is what makes the open dependency cheap to resolve late.

---

## 3. Phase 0 — Scaffolding (do first; unblocks verification)

Nothing else can be verified without this. All of Phase 0 is independently shippable and **insensitive** to the decorator-model decision.

### P0.1 — Fix packaging-breaking imports

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

## 4. Phase 1 — Core: registry, installation, wrapper correctness

This is Tier 0 proper. **P1.2 blocks P1.3; P1.3 blocks P1.4.**

### P1.1 — `ContractRegistry` (decorator-agnostic)

- **Goal:** decouple *recording* a contract from *authoring syntax* and from *installation*.
- **Approach:** a `WeakMap<object /* prototype or ctor */, Map<string|symbol, MethodContract>>`, where

  ```
  MethodContract = {
    params: Array<{ index, predicates: Predicate[], name?: string }>,
    pre: Predicate[],          // reserved (cross-parameter, Tier 2)
    post: Predicate[],         // reserved (Tier 2)
    installed: boolean,
  }
  ```

  Lookups are **own-property scoped** (see P1.6) so a subclass never mutates a parent's contract. `WeakMap` avoids the expando properties (`parameterDecorated`, `parameterDecorators`) currently stamped onto the function object at `ParameterDecoratorFactory.ts:43-44`.
- **Files:** new `src/Core/ContractRegistry.ts`.
- **Risk:** low. Pure data structure.
- **Verify:** unit tests; registry contents after decoration match expectations, including a subclass case.

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
- Introduce a `ContractViolation extends Error` carrying structured fields (`objectName`, `funcName`, `paramName`, `index`, `expected`, `actual`, `signature`) so messages are formatted in one place and are machine-readable later (Tier 4's codegen ambitions).
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

### P3.3 — Expanded preconditions

- **Goal:** deliver the `index.ts` roadmap block. Each validator is **independently shippable**.
- **Approach:** author as **pure predicates** in `src/Contracts/` (`(value, ...args) => boolean | ViolationDetail`), decorator-free, then bind them through the adapter. This is what makes them survive a decorator-model change untouched, and makes them trivially unit-testable.
  - *String:* `MaxLength`, `NotEmpty`, `Matches(regex)`, `Url`, `Email`.
  - *Number:* `Negative`, `NonNegative`, `Between(min, max)`, `LessThan`, `GreaterThan`.
  - *Generic:* `OneOf(...values)` / membership, `NotNull`.
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
P0.1 ─┬─ P0.2 ── P0.3
      └─ P0.4  (characterization tests — the safety net)
                │
                ▼
P1.1 ContractRegistry ──┐
P1.7 ResultAdapter  ────┤   (both independent, can land in parallel)
                        ▼
                   P1.2 MethodDecoratorFactory
                        │
                        ▼
                   P1.3 Registry-driven install  ◄── DECISION GATE (§8)
                        │
                        ▼
                   P1.4 Delete monkey-patch
                        │
        ┌───────────────┼───────────────┬──────────────┐
        ▼               ▼               ▼              ▼
   P1.5 ParamNames  P1.6 Wrapper    P2.1 Field     P3.1 Violations
                                         │
                                         ▼
                                    P2.2 Enforce
        │
        ▼
   P3.2 Config ── P3.3 Validators ── P3.4 @Time
```

**Independently shippable:** all of Phase 0; P1.1 and P1.7 (pure modules, no behavior change); each P3.3 validator; P3.4 once P1.2+P1.7 land.

**Hard ordering:** P0.4 before any Phase 1 behavior change (no net, no confidence). P1.2 → P1.3 → P1.4 is strict; deleting the patch earlier breaks parameter decorators outright (§1.1).

---

## 8. The open decorator-model dependency

Being researched in parallel; **not** pre-decided here. The plan localizes the blast radius.

### Sensitivity map

| Sensitivity | Items | Why |
|---|---|---|
| **High** | P1.3 authoring syntax; P1.5 *type* metadata | Stage-3 has **no parameter decorators** and no `design:paramtypes`. The `@Positive()`-on-a-parameter ergonomic is the thing at risk. |
| **Medium** | P1.2, P2.1, P3.4, `Memoize`/`Log` | Stage-3 *has* method and field decorators, but with a different signature — `(value, context)` returning a replacement, plus `context.addInitializer`. The concepts survive; the adapter internals are rewritten. |
| **Low / none** | P0.\*, P1.1, P1.6, P1.7, P3.1, P3.2, P3.3, all of `src/Contracts/` | Pure modules with no decorator-API contact. |

### Branch sketch

- **Branch L — stay on `experimentalDecorators`.** Plan proceeds exactly as written. `@Contract()` class installer (P1.3/A1), `design:paramtypes` available for P1.5 type checks. Cost: pinned to a legacy mode that TypeScript maintains but does not evolve.
- **Branch S — migrate to Stage-3.** Per-parameter decorators disappear. Authoring moves to a method-level spec — positional (`@Requires(Positive(), Between(1, 10))`) or index-keyed (`@Requires({0: Positive()})`) — or a build-time transform injects parameter metadata. Parameter *names* would then come from the spec or the transform, which is **strictly more robust** than §1.4's `toString()` parsing. Field/method decorators map to Stage-3 equivalents; per-instance field storage becomes cleaner via `context.addInitializer`. Cost: a breaking authoring change.

**Placement of the gate:** immediately before **P1.3**. Everything upstream (P0.\*, P1.1, P1.2's core, P1.7) is worth building under either outcome. Choosing **A1 (class-level installer)** at P1.3 is the deliberate hedge — a class-scoped installer driven by a decorator-agnostic registry is the topology Branch S needs anyway, so a migration rewrites `Adapters/legacy/` and leaves `Core/` and `Contracts/` intact.

---

## 9. Backwards-compatibility breaks

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

---

## 10. Top risks

1. **Silent no-op after P1.3.** A forgotten `@Contract()` means contracts vanish without error — strictly worse than a crash. The dev-mode warning is a **required** part of P1.3, not a nicety.
2. **Removing the monkey-patch out of order.** P1.4 before P1.3 breaks parameter decorators completely (§1.1). The sequence is not negotiable.
3. **`reflect-metadata` changes the `__decorate` path.** Loading it switches `__decorate` to its `Reflect.decorate` branch. P1.3/P1.4 must be tested both with and without it loaded.
4. **Eager Observable subscription in P1.7.** Subscribing to measure or assert duplicates side effects and breaks cold Observables. The single most likely correctness bug in the async work.
5. **Parameter names under minification.** Cannot be solved at runtime (§1.4). Over-promising here produces bad error messages in exactly the environment where they matter most. Ship the `argN` fallback and document the limit.
6. **TS 3.6 → 5.x surfacing latent errors.** Untyped parameters (`getParamNames(func)`) and loose `Verify` signatures will complain. Keep `strict` off through Phase 1; stage it afterward as its own change.
7. **Decision-gate drift.** If the Stage-3 research resolves toward migration *after* P1.3 lands on legacy, the rework is confined to `Adapters/legacy/` — provided the §2 layering rule is honored without exception. The layering is the insurance policy; violating it silently is what would make the migration expensive.

---

## 11. Deferred (explicitly out of scope)

Noted so they are not silently lost:

- **`Memoize` correctness** — prototype-level cache shared across instances, never invalidated, and **ignores arguments entirely** (`Memoize.ts:21-32`). Needs P1.7 first. Tier 2.
- **`src/MethodDecorators/queue.ts`** — an unused `queueScheduler` import; the placeholder for flow control. Tier 2.
- Postconditions, invariants, cross-parameter relationships — Tier 2/3.
- Arrow-function class properties as decoration targets — needs per-instance installation. Tier 2.
- `strict` mode. Immediately post-Phase 1, as an isolated change.
