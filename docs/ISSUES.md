# adorn — Issue Tracker

Running log of bugs, code smells, infrastructure gaps, and open questions found while working on adorn.

> **Maintenance convention:** this file is kept current as work proceeds. Anything encountered — a bug, a smell, a feature idea, an unanswered question — gets an entry here *when it is found*, even if it is not being fixed at the time. Architectural choices go in [DECISIONS.md](DECISIONS.md) instead. Large feature directions live in [vision.md](vision.md); this file tracks only the pointer, not the prose.

**Status legend:** `OPEN` · `FIXED` · `PARTIAL` (fixed in part, residue remains) · `DEFERRED` (accepted, scheduled) · `WONTFIX`

---

## Bugs

| ID | Status | Sev | Summary | Location |
|---|---|---|---|---|
| BUG-1 | **PARTIAL** | High | `Enforce` installs an accessor with a `set` but **no `get`**, and the setter never stores the value. Decorated fields validate on assignment then read back `undefined`, permanently. Also defines on the *prototype* with `configurable: false`. Argument wiring was fixed in `a2ddc5f`; the storage defect remains. | `src/FieldDeocrators/Enforce.ts:5-10` |
| BUG-2 | **RE-SCOPED** | Low | `OverrideObjectDefineProperty` is a one-shot patch on a global. **The originally-documented leak does not reproduce** — verified by three containment tests. The patch is consumed by the trailing `defineProperty` of the *same* `__decorate` call that armed it, and field decorators are emitted *before* methods and pass `void 0` (so `r` is falsy and they never make that trailing call). The earlier claim that an `@Enforce` field could be silently swallowed was **wrong as written**. A leak would require `__decorate` invoked with fewer than 4 arguments (e.g. a constructor parameter decorator) — unverified, and the real remaining risk. Patching a global remains a smell regardless; DEC-005 still governs removal order. | `src/Core/common.ts:24-33` |
| BUG-7 | OPEN | Med | **The wrapper's `.name` is `''`, not the method name**, despite the code comment claiming "Maintain the original function name". `obj[originalFunction.name] = function (...)` does not trigger named evaluation — that applies to bindings and object-*literal* keys, not assignment onto an existing object's member. Pinned against an undecorated control showing `.name === 'test'`. | `src/Core/ParameterDecoratorFactory.ts:60` |
| BUG-8 | OPEN | Med | `Object.defineProperty` assignment in `OverrideObjectDefineProperty` fails to type-check on **any TypeScript ≥ 4.0** (the lib signature became generic `<T>(o: T, ...) => T`; under 3.6 it returned `any`). Blocked `npm run build` and `npm run demo` outright after the upgrade. **FIXED** by a type-level cast with no runtime change; disappears entirely at P1.4. | `src/Core/common.ts:28` |
| BUG-3 | OPEN | High | `Memoize` stores its cache on the **prototype**, so it is shared across all instances, is never invalidated, and **ignores `args` entirely** — the same cached value is returned regardless of arguments. | `src/MethodDecorators/promise/Memoize.ts:13,20-32` |
| BUG-4 | OPEN | **High** | `StringMinLength` dereferences `params.value.length` with no null/undefined guard, throwing a `TypeError` instead of a contract violation. **Raised from Med:** the derived predicate is therefore *non-total*, which is a hazard for any projection that evaluates it — a fuzzer will feed it `null` immediately. Making predicates total (P3.3 guards) now matters for more than error-message quality. | `src/ParameterDecorators/Constraints.ts:22-25` |
| BUG-5 | OPEN | Med | `Memoize`'s runtime "must return Observable" check is commented out, so a non-Observable return fails later with an obscure error rather than at the point of misuse. | `src/MethodDecorators/promise/Memoize.ts:23-27` |
| BUG-6 | **FIXED** | Med | Package shipped no type declarations. `declaration: true` enabled; 16 `.d.ts` files now emitted including `dist/index.d.ts`. | `tsconfig.json:13` |
| BUG-F1 | **FIXED** | High | `Verify.positive` had an inverted condition — it threw when the value *was* positive, contradicting its own error message. Now rejects `value < 0`. | `src/Validation/Verify.ts:8-13` · `a2ddc5f` |
| BUG-F2 | **FIXED** | High | `Enforce.generator` passed the *target object* to the validator instead of the assigned value, so `Enforce.positive` validated the wrong thing. Setter now calls `func(v, key, target)`. Residue tracked as BUG-1. | `src/FieldDeocrators/Enforce.ts:8` · `a2ddc5f` |
| BUG-F3 | **FIXED** | High | `index.ts` used non-relative specifiers (`'src/...'`). `baseUrl` resolves those at compile time but TypeScript does not rewrite specifiers on emit, so `dist/index.js` emitted `require("src/...")` and **threw on load** — the published entry point was non-functional. Verified fixed by loading the compiled output. | `index.ts:2-4` · `0a54e8d` |

## Code smells

| ID | Status | Summary | Location |
|---|---|---|---|
| SMELL-1 | OPEN | Parameter *names* are recovered by regex-parsing `func.toString()`. Breaks under minification — empirically, esbuild `--minify` degrades `["message","someNumber"]` to `["s","t"]`. Not fully solvable at runtime; `emitDecoratorMetadata` supplies types, not names. | `src/Core/common.ts:9-17` |
| SMELL-2 | OPEN | Error re-throwing manipulates `e.stack` via `split('\n')` + `slice(3)`, hardcoding the wrapper's call depth. Silently produces wrong stacks if nesting changes. **Worse than recorded:** a validator throwing a non-`Error` (or anything with no `.stack`) makes `e.stack.split` raise a `TypeError` that **destroys the original failure**. Pinned by characterization test. | `src/Core/ParameterDecoratorFactory.ts:78-82` |
| SMELL-11 | OPEN | **Parameter constraints are validated in reverse order.** `__decorate` applies its decorator array back-to-front, so the *last* parameter's constraints register and check first — with several arguments invalid, the highest-index parameter is the one reported. Not wrong, but entirely implicit and load-bearing; P1.3 should normalize it deliberately rather than inherit it. | `src/Core/ParameterDecoratorFactory.ts` |
| SMELL-12 | OPEN | `strict: false` is set explicitly in `tsconfig.json`. TypeScript 6 defaults it to `true`, which surfaced ~25 implicit-`any` and `unknown`-catch errors across `src/`. Disabling was deliberate (the plan defers strictness), but it is now a standing debt with a known cost. | `tsconfig.json:8` |
| SMELL-3 | OPEN | `console.debug`/`console.log` diagnostics fire on every decorated call. | `src/Core/ParameterDecoratorFactory.ts:42,65,105` |
| SMELL-4 | OPEN | `Configuration.ErrorOnFieldConstraintMismatch` is defined but never consulted anywhere. | `src/Core/DecoratorConfiguration.ts` |
| SMELL-5 | OPEN | `FieldDecoratorFactory.ts` and `MethodDecoratorFactory.ts` are **empty files**. The code's own TODOs call for generalizing the parameter factory across all three. | `src/Core/` |
| SMELL-6 | OPEN | `queue.ts` contains only an unused `rxjs` import. | `src/MethodDecorators/queue.ts` |
| SMELL-7 | OPEN | Directory name misspelled: `FieldDeocrators` → `FieldDecorators`. Renaming touches the public entry point. | `src/FieldDeocrators/` |
| SMELL-8 | OPEN | `Verify.lessThanEqual` and `Verify.greaterThanEqual` are dead code — nothing calls them. | `src/Validation/Verify.ts:15-25` |
| SMELL-9 | **FIXED** | `package.json` keywords were malformed (`"prameter"` typo, `"decorators"` repeated four times). Replaced with a deduplicated, correctly-spelled set. | `package.json` |
| SMELL-10 | OPEN | The wrapper copies every own property off the original function on each decoration; an existing TODO notes this is unwieldy for large objects. | `src/Core/ParameterDecoratorFactory.ts:96-99` |

## Infrastructure gaps

| ID | Status | Summary |
|---|---|---|
| GAP-1 | **FIXED** | ts-jest harness with 127 passing tests across 5 suites, including characterization of the parameter-decorator core both with and without `reflect-metadata` loaded. |
| GAP-2 | **FIXED** | `build`, `clean`, `rebuild`, `typecheck`, `test`, `demo`, `prepublishOnly` scripts added. |
| GAP-3 | **PARTIAL** | TypeScript `3.6.4` → **`6.0.3`**. Cannot go to 7.x — see DEC-013. |
| GAP-4 | OPEN | No CI. Now worth adding, since there is finally a suite for it to run. |
| GAP-5 | OPEN | No linter or formatter configuration. |
| GAP-6 | OPEN | Two Phase 0 items remain undone (they fell outside the scaffolding agent's file ownership): moving `rxjs` to a peer/optional dependency (P0.2), and relocating `src/Tests.ts` to `examples/demo.ts` (P0.4). `npm run demo` currently points at `src/Tests.ts` in place. |
| GAP-7 | OPEN | `moduleResolution` is now implied rather than explicit. TS 6 accepts the implied `node10` without deprecation, but TS 7 removes it — so this must be set explicitly before any future 7.x move. |

## Open questions

| ID | Status | Question |
|---|---|---|
| Q-1 | OPEN | `Positive` accepts `0` (it rejects only `value < 0`), but "positive" strictly means `> 0`. The name and the semantics disagree. Pick one and apply it consistently across `Positive`, `Verify.positive`, and any future `Negative`. |
| Q-2 | OPEN | Should preconditions guarding *untrusted external* input ever be strippable in production? A single blanket toggle is unsafe — internal self-checks can be stripped, boundary checks generally cannot. Tracked as DEC-008. |
| Q-3 | OPEN | Generating meaningful arbitraries for *arbitrary hand-written predicates* is unsolved — a closure is a black box to a generator. Built-in constraints are tractable via their descriptors; **user-written predicates are not**, and generate-and-filter degrades badly for narrow ones. Consequence to state publicly rather than bury: **"decorate your code, get a fuzz suite" is not deliverable.** Coverage is partial by construction. |
| Q-4 | OPEN | **Descriptor/predicate drift** — the worst failure mode this goal introduces. If a descriptor says `min: 0` while its predicate checks `> 0`, generated documentation *looks* authoritative while disagreeing with what is actually enforced. Mitigated by deriving predicates from params (DEC-010), but any escape hatch permitting hand-written predicates reopens it. |
| Q-5 | OPEN | **Postcondition expressiveness**, not plumbing, is the real difficulty. Useful postconditions often need prior state and can be as hard to write correctly as the implementation they describe. Adoption may stall here regardless of how good the tooling is. |
| Q-6 | OPEN | Registry introspection becomes **semver-relevant** the moment a projection binds to it (DEC-011). It was internal and freely changeable before; what subset becomes public API is undecided. The read surface is now concrete — `getContracts` / `getContract` / `getContractedClasses` — so this needs settling before a projection binds to it. |
| Q-7 | OPEN | **`NaN` satisfies every numeric constraint.** The originals test `value < min` / `value > max`, and every comparison with `NaN` is `false`, so `NaN` never triggers a violation. Deriving the *obvious* `v => v >= min` would flag it — the two forms disagree on exactly this one input, so switching would be a silent behaviour change under a refactor. P1.0 preserved current behaviour as `!(value < min)` and pinned it with a test. Settle it deliberately in P3.3, where uniform type guards belong. |
| Q-8 | OPEN | **Plan text contradicts DEC-010.** P1.0's prose describes `defineConstraint` as building from `{kind, constraint, params, predicate, message}` — listing `predicate` as an *input* — while the bullet below it and DEC-010 mandate derivation. P1.0 was implemented per DEC-010 (no `predicate` input exists). The stale prose must be corrected: a hand-written-predicate input is precisely the escape hatch Q-4 warns reopens drift. |

## Feature ideas

Large directions live in [vision.md](vision.md) and are not duplicated here. Items below are those with a concrete bearing on near-term work:

| ID | Status | Summary |
|---|---|---|
| IDEA-1 | **IMPLEMENTED** | Reified constraint **descriptors** (contract as data, not closure). Landed in P1.0 as a `ConstraintDefinition` / `ConstraintDescriptor` split. See DEC-006, DEC-010. Not yet exported from `index.ts`, and not yet wired into any decorator (that is P1.3). |
| IDEA-2 | **IMPLEMENTED** | Contract registry with both access patterns — `WeakMap` for lookup, enumerable companion for projection. Landed in P1.1. See DEC-011, and Q-6 on its semver surface. |
| IDEA-3 | OPEN | Integrate **fast-check** for property testing / fuzzing driven by contract descriptors. Precedent: `clojure.spec` yields validation *and* generative testing from one declaration. **Blocked on a dependency:** `fast-check` is not yet installed, so P1.0 left the `arbitrary` hook shape-only and typed as `unknown`; narrowing that alias is the only change needed once it lands. |
| IDEA-4 | OPEN | Postconditions with `old()` state capture. Promoted in priority — fuzzing needs an oracle, and without postconditions generated inputs only test "it didn't throw." |
| IDEA-5 | OPEN | Class invariants, likely `Proxy`-based (the `decorator-contracts` approach). |
| IDEA-6 | OPEN | Cross-parameter contracts (`start < end`; "if mode is custom then config is required"). Highest marginal value — hardest rules to maintain by hand. |
| IDEA-7 | OPEN | Generate documentation / OpenAPI-style specs from the registry. **Recommended as the first projection to build** — it is the safest of the four, needing only descriptors and enumeration, with no oracle and no generator problem. |
