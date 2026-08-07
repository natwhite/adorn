# GAP-17 — Ship consumer guidance in `dist/*.d.ts` via source-declaration JSDoc

**Status:** design/plan (no production code changed by this document).
**Scope owner:** GAP-17 (docs/ISSUES.md). Raised by AiVoiceAgent round-2 §1 / round-3.
**One-line finding:** the fix GAP-17 calls for — JSDoc on the *source declarations* — is **already ~95% implemented in the tree**, and that JSDoc **already survives declaration emit**. What remains is verification (done here), a handful of genuinely-bare declarations, one architectural decision about the *flat* `dist/index.d.ts`, and a regression guard.

---

## 0. Headline (read this first)

GAP-17's round-2/round-3 framing ("more guidance written, none of it shipped") is about the **barrel `//` comments** in `index.ts`. It is **not** an accurate description of the shipped `.d.ts` surface as it stands today. Between round-2 and now, the DEC-051/052/056/057/059/060/061 waves put rich JSDoc on essentially **every consumer-facing exported declaration** — parameter decorators, `Enforce.*` field statics, the descriptor factories (`Between`, `OneOf`, `ArrayOf`, `Dictionary`, `Shape`, `Nullable`, the string factories), the markers (`@Optional`/`@Default`/`@Describe`/`@Tool`/`@Sensitive`/`@Telemetry`), every method decorator, all six projections, the config setters, the registry reads, and `Verify.that`/`Verify.check`. Declaration emit **preserves all of it** into `dist/src/**/*.d.ts` (56 `.d.ts` files ship). Hover works.

So this pass is small and mostly confirmatory. The one thing still exactly as GAP-17 describes is the **flat** `dist/index.d.ts`: it is a pure re-export barrel that carries only the two JSDoc blocks written *inline* in the barrel's `export { … }` list (`Contract`, `Validate`). Everything else appears there as a bare name. That is the only surface an LLM handed *just that one file* (with no ability to follow relative imports) can see — and that is the decision in §2.

---

## 1. Verified emit findings (empirical, with evidence)

Method: `npm run build` (`tsc && tsc -p tsconfig.cli.json`), then inspected the emitted `.d.ts`. One throwaway probe was added to a **currently-bare** export and reverted (below).

### 1a. Source-declaration JSDoc survives declaration emit — for all three forms

| Form | Source | Emitted `.d.ts` | Survives? |
|---|---|---|---|
| (a) `export function` | `Between` in `src/Contracts/number.ts:360-380` | `dist/src/Contracts/number.d.ts:140-151` — full JSDoc block above `export declare function Between(min, max): …` | **Yes** |
| (b) `const X = …` then a separate `export { X }` | `GreaterThanEqual` arrow in `src/ParameterDecorators/Constraints.ts:72-73` | `dist/src/ParameterDecorators/Constraints.d.ts:50-51` — JSDoc above `declare const GreaterThanEqual: …`, with the `export { … }` list following | **Yes** |
| (c) `export function` reached via `import * as NumberContracts` | same `Between` as (a) | the namespace binding `import * as NumberContracts from './src/Contracts/number'` resolves to `number.d.ts`, which carries the block from (a) | **Yes** (hover on `NumberContracts.Between` follows the namespace into `number.d.ts`) |

No probe was strictly required for these three, because the pre-existing JSDoc already demonstrates each case in the shipped `dist/`. Evidence is `dist/src/Contracts/number.d.ts` and `dist/src/ParameterDecorators/Constraints.d.ts` as built today.

**Probe (freshly-added block on a bare declaration).** To close the "maybe those files were special" loop, a distinctive block `/** PROBE-GAP17-XYZZY … */` was added above the genuinely-bare `export function setViolationPolicy` (`src/Core/Configuration.ts`), rebuilt, and observed:

- **Appeared** in `dist/src/Core/Configuration.d.ts:165-168` (`/** … PROBE-GAP17-XYZZY … */` immediately above `export declare function setViolationPolicy(...)`).
- **Did NOT appear** in `dist/index.d.ts` (grep: not present).

The probe was then reverted (`git checkout -- src/Core/Configuration.ts`; confirmed gone from source; `dist` rebuilt clean). `dist` is git-ignored (`/dist/`), so no tracked artifact was touched.

### 1b. `dist/index.d.ts` is a pure re-export barrel; a re-export carries the **name only**

`dist/index.d.ts` (65 lines) contains exactly:
- `import { … } from './src/…'` lines (no JSDoc),
- `export type { … } from './src/…'` re-exports (no JSDoc),
- one terminal `export { … }` list (lines 48-64),
- **two** JSDoc blocks total — `Contract` (49-56) and `Validate` (58-63) — and they survive **only because they are written inline in the barrel's `export { … }` list in `index.ts:296-311`**, attaching to the identifier that immediately follows,
- one `//` line (the `//# sourceMappingURL` pragma).

Confirmed: `export { Between, GreaterThanEqual, … }` in the barrel emits those as **bare names** in `dist/index.d.ts` even though their source declarations carry rich JSDoc. A re-export (`export { X } from './foo'`, or `export { X }` of an imported `X`) carries the binding, **not** `X`'s doc comment. This matches GAP-17's "ships 1" (one `//` line) and pins the mechanism: **only inline-in-the-barrel JSDoc reaches the flat file.**

### 1c. The load-bearing difference: hover vs. flat-file read

- **Language-server / hover** (`import { Between } from 'adorn'`, or `NumberContracts.Between`): the LS follows the re-export graph into `dist/src/ParameterDecorators/Constraints.d.ts` (decorator) or `dist/src/Contracts/number.d.ts` (descriptor) and shows the **source JSDoc**. **Works today** for both the decorator and the namespaced descriptor, including the `(min, max)` shape.
- **An agent/human reading only the flat `dist/index.d.ts`**: sees the two inline blocks (`Contract`/`Validate`) plus bare names, and sees the descriptor namespaces only as `import * as NumberContracts from './src/Contracts/number'` — i.e. the **name** `NumberContracts` with **no members and no `(min,max)` shape**. To get the shape it must open `number.d.ts`. This is exactly GAP-17's canonical `NumberContracts.Between(min, max)` trap, and it is **only** a trap for a reader that cannot follow the relative import.

**Net:** the guidance is *not* invisible. It is invisible **only** in the single-flat-file reading mode, which is the mode the consumer's stated concern targets.

### 1d. Counts (measured today)

- `index.ts`: **194** `//` lines, **2** `/**` blocks (issue says 188 `//` — mild drift; 194 is current).
- `dist/index.d.ts`: **2** `/**` blocks, **1** `//` line.
- Total `.d.ts` shipped in `dist/`: **56**. `package.json` `files:["dist"]` ships the whole tree, so every `dist/src/**/*.d.ts` (and its source JSDoc) is in the published tarball.

---

## 2. Architectural fork — A / B / C

The only real decision. Framing: the consumer's concern is specifically "a model writing code against adorn sees `dist/index.d.ts`."

- **Option A — source-declaration JSDoc only.** Idiomatic; fixes hover; guidance lands in `dist/src/**/*.d.ts`; the flat `index.d.ts` stays a re-export barrel (like almost every library). **Already ~95% done.**
- **Option B — also inline consumer guidance in the barrel `export { … }` list** (like `Contract`/`Validate`) so the flat file carries it too. Helps a flat-file-only reader, but **duplicates** every doc it copies (a second place to drift — the same Q-4/DEC-010 hazard the architecture avoids elsewhere) and re-bloats the barrel the `// prettier-ignore` groupings were built to keep legible.
- **Option C — A everywhere + a *small, curated* set of inline-barrel notes for the sharpest flat-file traps only.**

### Recommendation: **Option C**, with **A as the safe floor.**

Reasoning:
1. **A is the correct default and is essentially already shipped.** Do not regress it. It fixes the realistic consumer path (editor hover + LS-aware agents that can open a referenced `.d.ts`).
2. **B is rejected** as a blanket policy: full duplication of ~40 docs into the barrel reintroduces the drift risk and the alphabet-soup bloat, for a reader mode that can usually follow imports anyway.
3. **C surfaces the few things a flat-file reader genuinely cannot reconstruct**, at negligible duplication cost. Concretely, promote a **handful (≈3-5)** of the existing barrel `//` blocks to `/** */` so they attach to the following export and ship into `dist/index.d.ts`:
   - The **`*Contracts` descriptor-namespace note** (currently `index.ts:174-199`, the `//` block above `NumberContracts`/…): a short block placed before `NumberContracts` in the `export { … }` list, stating "these are **descriptors** (data), not decorators; `NumberContracts.Between(min, max)` — both bounds inclusive; see each namespace's `.d.ts` for member shapes." This is the one note that directly answers the canonical trap **at the flat-file level** (a pointer + the `(min,max)` fact; the per-member shapes still live in `number.d.ts`).
   - The **`@Contract()`-is-required** rule already half-covered by `Contract`'s inline block — leave as is (already ships).
   - Optionally the **decorator-vs-descriptor duality** one-liner (the flat `@Between` decorator and `NumberContracts.Between` descriptor are distinct symbols with the same name).
   Keep the list to the traps that are **both** flat-file-invisible **and** high-cost to get wrong. Everything else stays A-only.

**Is this a user decision?** The **floor (A) is a clear default** — no confirmation needed; it is idiomatic and already in place. The **exact membership of C's inline-barrel set is the judgment call worth a one-line user confirm**, because it trades a little duplication for flat-file-only reachability and the user is the one who knows how their models consume the types (single flat file vs. LS-aware). Recommended default if they don't weigh in: ship the single `*Contracts` namespace note (highest value, lowest cost) and stop there.

---

## 3. Scope + rough effort (what's done, what's left)

### 3a. Already documented and shipping (no work — verify only)

All of the following carry source JSDoc that **already emits** to `dist/src/**/*.d.ts` (spot-checked in the built tree):

| Group | File(s) | Status |
|---|---|---|
| Parameter constraint decorators (24) | `src/ParameterDecorators/Constraints.ts` | **Done** — every `const` has JSDoc; each thin wrapper is a one-liner |
| Descriptor factories (number/string/enum/array/object/nullable) | `src/Contracts/*.ts` | **Done** — `Between`, `GreaterThanEqual`, `MultipleOf`, `MinLength`…`Format`, `OneOf`, `Const`, `ArrayOf`, `Dictionary`, `Shape`, `Nullable` all have rich blocks incl. arg shapes |
| Field decorator statics (`Enforce.*`, 24) | `src/FieldDecorators/Enforce.ts` | **Done** — every static has a one-liner naming its `@`-twin |
| Method decorators | `Ensures`, `Requires`, `Returns`, `Observe`, `Log`, `Time`, `setTimingSink` | **Done** |
| Markers | `Optional`, `Default`, `Describe`, `Tool`, `Sensitive`, `Telemetry` | **Done** (rich module + factory blocks) |
| `Verify` methods | `src/Validation/Verify.ts` — `that`, `check`, `lessThanEqual`, `greaterThanEqual`, `CheckResult` | **Done** (methods); see 3b for the class-level gap |
| Projections | `documentClass`/`documentContracts`/`renderMarkdown`/`generateMarkdown` (docs), `schemaForClass`/`schemaForContracts`/`serializeSchema`/`generateSchema`/`toolSchemaForMethod`/`toolSchemaFrom` (schema), the four telemetry fns | **Done** |
| `Contract` / `Validate` | `src/Adapters/legacy/ContractInstaller.ts` **and** inline in the barrel | **Done** (only two that ship in flat `index.d.ts` too) |
| Config setters | `setEnforcementMode`, `setAssertEnforcement`, `setDefaultTrust`, `disableGuardEnforcement`, `enableGuardEnforcement`, `setObservationVerbosity` | **Done** |
| Diagnostics | `setContractDiagnosticsEnabled`/`Sink`, `flushContractDiagnostics` | **Done** |
| Value disclosure | `setValueDisclosure`, `getValueDisclosure` (`src/Core/redaction.ts`) | **Done** |
| Observation | `setObservationSink`, `getObservationSink`, `RETURN_INDEX`, `settle`, `consoleObservationSink` | **Done** |
| Registry reads (13) | `src/Core/ContractRegistry.ts` — `getContracts` … `getEffectivePreconditions` | **Done** |
| Oracles | `evaluatePostconditions`, `evaluatePreconditions` | **Done** |

Rough total already covered: **~90+ consumer-facing declarations**, matching the 95 pinned value exports minus the residue below.

### 3b. Residual bare declarations — the actual JSDoc work (small)

Prioritized:

**P1 — genuinely consumer-facing, currently bare (≈3 declarations):**
1. `setViolationPolicy` (`src/Core/Configuration.ts:308`) — the only bare public *setter* (its `ViolationPolicy` type is documented, the setter is not). Its siblings all have blocks. One `/** */`.
2. `Enforce` **class-level** doc (`src/FieldDecorators/Enforce.ts:59`) — the rich module doc (lines 1-48) does **not** attach to the class because the `import` block intervenes; `dist/src/FieldDecorators/Enforce.d.ts:50` shows `export declare class Enforce {` with no block (members are fine). Add a 1-2 line class `/** */` (hover-on-`Enforce`).
3. `Verify` **class-level** doc (`src/Validation/Verify.ts:99`) — same shape: module doc is separated from the class by the `CheckResult` type; the class line is bare (methods fine). Add a short class `/** */`.

**P2 — namespaced but not the intended entry points (≈17 declarations, optional):**
The internal `*Constraint` factories exposed via the `import * as` namespaces — `minConstraint`/`maxConstraint`/`greaterThanConstraint`/`lessThanConstraint`/`betweenConstraint`/`integerConstraint`/`multipleOfConstraint` (number), `oneOfConstraint`/`constConstraint` (enum), `arrayOfConstraint` (array), `dictionaryConstraint`/`shapeConstraint` (object), `nullableConstraint` (nullable), `minLengthConstraint`/`maxLengthConstraint`/`matchesConstraint`/`urlConstraint` (string). These are `defineConstraint(...)` plumbing; the **capitalized factory functions** (`Between`, `OneOf`, …) are the API and are documented. Two ways to close:
- (a) **Leave bare** and note in the plan that whether these belong on the public namespace surface at all is a **Q-6 question** (they arguably should be internal); or
- (b) a single terse line each.
Recommend **(a)** — do not spend effort documenting symbols that arguably should not be public. If (b), it is mechanical and low-risk.

**P3 — Option C inline-barrel notes (≈3-5, see §2):** promotion of selected `//` blocks in `index.ts`'s `export { … }` list to `/** */`. This is the only *new* consumer-visible content in the flat file.

**Effort:** P1 is ~3 short edits; P3 is ~3-5 short edits in one file; P2 is optional. This is a **half-day pass**, dominated by review, not authoring.

### 3c. Slice ordering (buildable)

1. **Slice 0 (this doc):** verify emit, decide A/C. ✔ verification done here.
2. **Slice 1 — regression guard first (§5).** Land the test *before* touching declarations, so the fix is measured against it. It passes immediately for the already-documented sample and fails only if something backslides.
3. **Slice 2 — P1 bare declarations** (`setViolationPolicy`, `Enforce`/`Verify` class docs).
4. **Slice 3 — P3 Option-C inline-barrel notes** (if the user confirms the flat-file set) + assert their presence in `dist/index.d.ts` in the guard.
5. **Slice 4 (optional) — P2** `*Constraint` one-liners, or a Q-6 decision to make them internal.

---

## 4. The decorator-vs-descriptor rule (mechanical, and already the de-facto convention)

`@Between` (`Constraints.ts`) and `NumberContracts.Between` (`Contracts/number.ts`) are **separate exported symbols** with the same name. The rule, stated so it is not re-litigated per constraint:

> **Rich prose lives once — on the descriptor factory in `src/Contracts/*`.** It carries the full semantics *and the argument shape* (`Between(min, max)`, `ArrayOf(item, {minItems?, maxItems?})`, `Dictionary(value)`, `OneOf(values[])`), the projection behaviour, and the edge cases. **Every thin wrapper** — the parameter decorator in `Constraints.ts` and the `Enforce.*` field static — gets **one sentence**: what it rejects, plus a pointer to its descriptor twin (`{@link}` or a `see …` phrase). A wrapper must **never restate** the descriptor's full semantics, because that creates a second copy that can drift (the Q-4/DEC-010 hazard the runtime architecture already refuses to allow).

This is exactly what the tree already does (e.g. `Constraints.ts:81` `/** Rejects values outside [min, max]. Both bounds inclusive. Throws at decoration if min > max. */` over the wrapper, vs. the multi-paragraph block on `Contracts/number.ts:360` over the factory). The plan **codifies** it; it does not require rewrites.

Corollary for the flat file (Option C): the barrel note points at the **descriptor** twin for the shape, because the decorator wrapper's one-liner deliberately doesn't carry it.

---

## 5. Regression-guard test design

**Goal:** prove the fix and prevent backslide, robustly (not brittle to exact wording), and correctly handle the build-vs-source question.

**The build question.** The existing `test/public-surface.test.ts` imports the *source* `../index` (ts-jest compiles on the fly) and never reads `dist/`. Declaration emit is a **build-time** artifact, so the part of this guard that proves "guidance actually ships in `.d.ts`" must read `dist/`. CI order is `install → format → lint → typecheck → build → test → demo` (`.github/workflows/ci.yml`), so **`dist/` is fresh when tests run in CI**. Locally, `npm test` alone does not build. `jest.config.js` sets `testPathIgnorePatterns: ['/dist/']` — that only stops jest *discovering test files* under `dist/`; an `fs` read of `dist/` from a `test/` file is unaffected.

**Design — two layers, one new file `test/jsdoc-surface.test.ts`:**

**Layer 1 — source-level (no build needed; runs anywhere).** Enumerate a small **sample** of key consumer-facing declarations and assert each has a JSDoc block (`/**`) immediately preceding it, by reading the *source* file text. Robust: presence-only, not content. Sample (≈8-10): `Between`/`GreaterThanEqual` in `Contracts/number.ts`; `Dictionary`/`Shape` in `Contracts/object.ts`; the `Between` wrapper in `ParameterDecorators/Constraints.ts`; `Optional` in `Markers/Optional.ts`; `toolSchemaForMethod` in `Projections/schema.ts`; `Enforce.greaterThan` static; `Verify.that`. Plus the specific P1 fixes once landed (`setViolationPolicy`, `Enforce`/`Verify` class docs). This catches a declaration silently losing its doc during an unrelated edit.

**Layer 2 — emit-level (proves the pipeline; build-dependent).** Assert that a sample of `dist/src/**/*.d.ts` files each contain at least one JSDoc block, and — for the canonical trap — that `dist/src/Contracts/number.d.ts` contains **both** `function Between` **and** a preceding JSDoc block that mentions the arg shape (loose match: the substring `[min, max]` or the words `min`/`max` near `Between`; **not** an exact-prose match). Guard on `dist` existence:
```
const distDir = path.resolve(__dirname, '../dist/src');
if (!fs.existsSync(distDir)) {
    throw new Error('GAP-17 guard: dist/ not built — run `npm run build` first (CI builds before test).');
}
```
An actionable hard failure (not a silent skip) is preferred: a silent skip would let the ship-proof rot unnoticed; CI always has `dist/`, so the failure only bites a local run that forgot to build, with a message that says exactly what to do. (If the team prefers zero local friction, downgrade to `it.skip` with a `console.warn` — call-out for the reviewer.)

**Layer 3 — flat-file (only if Option C is taken).** Assert `dist/index.d.ts` contains the promoted trap note(s), e.g. that the block above `NumberContracts` mentions `descriptor` and `Between`. Keep it to *presence of the promoted note*, not wording. This is the only assertion that pins the flat-file guarantee; without Option C, omit Layer 3.

**Anti-brittleness rules baked in:**
- Presence-of-`/**`, never exact strings (wording churns; the block's existence is the invariant).
- Sample a *representative handful* per group, not an exhaustive list (an exhaustive list re-creates the maintenance burden `public-surface.test.ts:110` explicitly warns against with its "tripwire, not a hard rule" note).
- Don't assert a JSDoc **count** on `index.ts` or `dist/index.d.ts` (guidance moves between `//` and `/** */` deliberately; a count would fail on every such move). The issue's "count of `//`" framing is explicitly *not* the thing to pin.

---

## 6. The 188 (now 194) `//` in `index.ts` — their fate

Breakdown by kind:
- **Barrel maintenance** — `// prettier-ignore`, section headers (`// --- Parameter decorators ---`), and the grouping-rationale prose (`index.ts:201-206`, which explains *why* the groupings are load-bearing). These are **for the barrel's maintainer**, correctly **not** shipped, and must **stay** (removing `// prettier-ignore` would let Prettier flatten the 60-line map into a 120-line alphabet column — the file itself says so).
- **Consumer-guidance prose** interleaved in the `export { … }` list (e.g. the `@ArrayOf`/`@Dictionary`/`@Shape`/`*Contracts` blocks). These are now **redundant with the source-declaration JSDoc** for every hover/LS consumer. Decision: **leave them in place** — they are the "one place a reader sees the whole shape at once" (`index.ts:201`), which is real value **inside** `index.ts` for a maintainer — **except** the ≈3-5 promoted to `/** */` under Option C (§2/§3b-P3).

**Explicitly rejected:** a mass `//`→JSDoc rewrite of the barrel. The issue calls this out, and it is right: most lines are maintenance, a `/** */` in an `export { … }` list attaches to exactly the *next* identifier (so a group note becomes a lie about one export), and the `Between` trap is a *namespace* concern that a per-name inline block cannot express anyway. Promotion is **surgical**, not mechanical.

**Net:** trim nothing; keep all maintenance `//`; promote a curated few to `/** */` only under Option C.

---

## 7. Risks & open questions (for an adversarial reviewer)

1. **Is GAP-17 already substantially fixed, making this pass mostly a status correction?** The evidence in §1/§3a says yes at the source-declaration level. Risk: the reviewer expected a large authoring effort and finds a verification + 3 edits. That is the honest state; the issue text predates the DEC-059/060/061 JSDoc waves. **Action:** the plan should update GAP-17's ISSUES.md entry to reflect that source-decl JSDoc is done and only the flat-file decision + residue remain — otherwise the tracker overstates the work.
2. **Does the flat-file scenario actually occur?** The whole Option-C value rests on "a model sees *only* `dist/index.d.ts` and cannot open `./src/*.d.ts`." Modern LS-backed agents *do* follow the graph (hover already works). If the consumer's tooling can open referenced files, **A alone fully suffices** and C is pure cost. This is the single biggest open question and the reason C's membership is a user confirm, not a default. **Unverified against the actual AiVoiceAgent tooling.**
3. **Inline-barrel duplication drift.** Any block promoted under C is a *second* copy of a fact whose primary home is a `.d.ts`. If `Between` ever becomes exclusive-bounded, or a namespace is renamed, the barrel note must be updated too. Mitigation: keep C's set tiny and *pointer-shaped* ("see `NumberContracts` / `number.d.ts` for shapes") rather than restating specifics — a pointer drifts less than a copy. Still a real, accepted cost.
4. **Build-order coupling of the Layer-2 test.** Hard-failing when `dist/` is absent is safe in CI (build precedes test) but adds local friction (`npm test` after a clean checkout fails until `npm run build`). Alternatives: (a) `it.skip` + warn (weaker guarantee), (b) have the test shell out to `npm run build` (slow, and jest-in-jest is ugly), (c) emit one file's declarations in-memory via the TS compiler API (heaviest, but build-independent). Recommend the hard-fail with an actionable message; flag (a)/(c) as fallbacks if the team objects.
5. **`emitDecoratorMetadata` and the `.d.ts` are orthogonal** — worth stating so no one assumes the metadata emit interacts with JSDoc survival. It does not; JSDoc is preserved by the declaration printer regardless.
6. **P2 `*Constraint` factories are a latent Q-6 surface question, not just a doc gap.** Documenting them (option 3b-P2-b) *blesses* them as public. If they should be internal, the right move is to *remove them from the namespace*, not to write JSDoc that entrenches them. The plan should not quietly document its way into a wider public surface. **Defer to Q-6.**
7. **Module-level JSDoc (the file-top essays) does not help the flat file.** Those rich `/** … */` headers in `number.ts`/`redaction.ts`/etc. emit at the top of each `.d.ts` and are excellent for a reader who opens that file, but they contribute **nothing** to `dist/index.d.ts`. If a reviewer counts "lines of guidance shipped," most of it is in per-file `.d.ts`, not the entry point — by design, and not fixable without Option B's duplication.
8. **`declarationMap: true`** means `dist/index.d.ts.map` etc. also ship; irrelevant to guidance but present in the tarball. No action.
9. **Count drift already exists** (issue: 188 `//`; measured: 194). Any assertion on that number is guaranteed to rot. The §5 design deliberately pins *presence*, not counts — but a future maintainer may be tempted to "fix" the number in ISSUES.md and turn it into a pinned expectation. Note it as prose, not a test.

---

## Appendix — evidence index (paths are load-bearing)

- Barrel source: `index.ts` (imports 1-199; `export { … }` list 207-383; inline `Contract`/`Validate` blocks 296-311).
- Flat emit: `dist/index.d.ts` (re-export barrel; JSDoc only at 49-56 / 58-63; `//` only at the sourcemap pragma).
- Source-decl JSDoc that already ships: `dist/src/Contracts/number.d.ts` (Between block 140-151), `dist/src/ParameterDecorators/Constraints.d.ts` (per-const blocks 48-144), `dist/src/FieldDecorators/Enforce.d.ts` (per-static blocks 51-108; class line 50 bare).
- Bare targets: `src/Core/Configuration.ts:308` (`setViolationPolicy`), `src/FieldDecorators/Enforce.ts:59` (class), `src/Validation/Verify.ts:99` (class), the `*Constraint` `export const`s across `src/Contracts/*.ts`.
- Test harness to extend/mirror: `test/public-surface.test.ts` (source-import style; the "tripwire not a hard rule" reasoning at 110-121), `jest.config.js` (ts-jest; `/dist/` ignored for *discovery*), `.github/workflows/ci.yml` (build-before-test order).
