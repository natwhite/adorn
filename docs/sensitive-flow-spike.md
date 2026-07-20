# adorn — Build-Time `@Sensitive` Flow Analysis: Feasibility Spike

*A spike, not a feature. Produced 2026-07-20. Proof-of-concept code in `spike/`, excluded from the build, the linter and Prettier.*

> **Status: spike report. This discharges DEC-023 point 4** — *"A feasibility spike precedes any implementation."* DEC-023 is `ACCEPTED (governs the spike) · feasibility **unproven** — see sensitive-flow-spike.md`, so this document is the evidence it gates on, and it returns a **negative** result on point 1. Nothing here is implemented in `src/`, and the code in `spike/` is throwaway. §11 contains a proposed **amendment to DEC-023** written in `DECISIONS.md` style; it is a **proposal in this document** and `DECISIONS.md` was not edited.
>
> **DEC-023 named both hazards correctly before I started, which is worth recording.** It flags *"a tool that cannot see a flow and does not say so"* and *"silent because converged and silent because never re-run look identical"*. I measured both. They are not risks to be designed against — they are what the design does (§6, §4.3, §8.4).
>
> **How to read the claims.** Every number in this document was produced by running code in this repo on this machine (Node v22.11.0, TypeScript 6.0.3, ESLint 9.39.5, typescript-eslint 8.64.0). Where I could not measure something I say so, in §10. §1 is the verdict; §2–§8 are the measurements; §9–§11 are the recommendation.
>
> **This builds on `docs/pii-redaction-plan.md` §5.4, §5.5, §9 and §13 (DEC-PII-1, DEC-PII-5) and does not restate them.** That document establishes the primitive-parameter gap and the never-load-bearing principle. This one answers the question it left open: *can the gap be closed at build time instead?*
>
> ---
>
> ### ⚠ A re-evaluation under a NARROWED threat model was added as §14 on 2026-07-20.
>
> **§1–§13 are unchanged and are not superseded.** The user has since ruled that adorn's obligation is to make **adorn's own emissions** safe, not to police a developer's raw `console.log`. That makes the sink set closed and enumerable, which is precisely the thing §4.3 found the design to lack. **§14 re-measures every number under that model and returns a different verdict on a different design.** The record below of *why the original design failed under the broader model* is exactly what justifies the narrowing, so it is preserved verbatim rather than rewritten. Read §1 first, then §14.1.
>
> ---
>
> ### ⚠ A third pass — two ALTERNATIVE approaches to the same gap — was added as §15 on 2026-07-20.
>
> **§1–§14 are unchanged and are not superseded.** Both prior verdicts stand exactly as written. §15 evaluates two designs neither of them considered: **Option A**, runtime observation through the `@Sensitive` getter, and **Option B**, full interprocedural static analysis. **Option A catches 15 of the 17** — the first thing in this document to move that number — **and is rejected anyway**, on grounds that have nothing to do with its catch rate. Option B is rejected as posed and replaced by something an order of magnitude smaller. Read §15.1 for the verdicts.

---

## 1. Verdict

**No — not as proposed. The iterative single-hop design is not viable, and it fails for a reason that has nothing to do with the elegance of the iteration.**

The iteration itself is fine. It converges, it terminates under recursion and mutual recursion, it is cheap, and it is idempotent. Every claim made for it in that dimension held up under measurement. **Three other things break it:**

| # | Finding | Measured |
|---|---|---|
| **1** | **`--fix` cannot write what the design requires it to write.** A legacy parameter decorator is syntactically illegal on every function that is not a concrete class member. Free functions, arrow functions, function expressions, interface methods, abstract methods, overload signatures and function types all reject it — three of them as *parse* errors. | **7 of 18** syntactic positions accept a parameter decorator (§5). On the 5-hop chain fixture, `--fix` in decorator mode wrote **0 annotations** and made **0 progress**. |
| **2** | **It cannot see most real leaks, and it fails silently.** Every one of 25 fixture cases genuinely leaks a `@Sensitive` value to console output. | **17 of 25 (68%) silently missed** (§6). Including template-literal interpolation into a logger — the most common leak shape in JavaScript. |
| **3** | **It annotates the sink instead of reporting the leak, and calls that convergence.** The terminal annotations on the chain fixture landed on `writeAuditLog(entry)` and `emitMetric(label)` — the two functions that actually call `console.log`. | The run reports `CONVERGED=true` in exactly the state where every leak has been reached and none reported (§4.3). |

Finding 3 is the one that matters most, and it is not a bug in my implementation — it is what the design *is*. The proposal defines success as "no new flows appear." That state is reached when the marking has been propagated everywhere it can go, which is to say when it has arrived at every sink and been written onto it. **The design converges precisely when it has finished decorating the crime scene.** Nothing in the mechanism ever says "this leaks"; it says "this is now also marked."

**Confidence: high** on findings 1 and 3 — finding 1 is a compiler diagnostic (`TS1206`) reproduced across 11 syntactic positions, and finding 3 is visible in the fixture output. **Medium-high** on finding 2: 68% is a property of *my* fixture set, and a different fixture set would give a different percentage. What is not fixture-dependent is that the misses are **silent**, and that the specific shapes missed (local variable, template literal, return value, `any`) are the ordinary way JavaScript is written.

**What is salvageable, and it is worth having (§9):** the single-hop *detector* is precise and cheap, and two things fall straight out of it — a report-only ESLint rule for the direct-sink case, and a **reachability report** that names the path rather than annotating it. Neither needs iteration, neither needs `--fix`, and neither has the false-confidence failure mode.

**What changed my mind while spiking:** three things, in §12.

---

## 2. What I built

All in `spike/`, ~700 lines of throwaway JavaScript against the raw TypeScript compiler API.

| File | What it is |
|---|---|
| `spike/core.js` | The analysis core. Source classification, the single hop, host-legality classification, `--fix` planning in three modes (`decorator`, `jsdoc`, `auto`). Exposes `analyzeProgram(program, files)` — a shape both drivers consume. |
| `spike/run.js` | The iteration driver. Copies fixtures to a scratch worktree, loops analyse → fix → analyse until a round produces zero edits, then **typechecks the result**. |
| `spike/eslint-rule.js` | The same analysis as a real typescript-eslint type-aware rule, reusing `core.js`'s `classifySource` and `isMarked` **unchanged**. |
| `spike/eslint-run.js` | Drives that rule through the real ESLint 9 API against a fixture worktree. |
| `spike/legality.js` | Compiles 23 probes to determine where a parameter decorator — and the JSDoc alternative — is actually legal. |
| `spike/verify.js` | The blind-spot inventory and the false-positive count, both against tagged ground truth. |
| `spike/idempotence.js` | Re-run churn, already-annotated parameters, mixed notation, post-fix compilation. |
| `spike/bench.js` | Cost, on this repo. |
| `spike/fixtures/` | 9 fixture files. `marker.ts` is a throwaway inert `@Sensitive`; there is no real one and this spike did not build one. |

**Exclusions, so the spike cannot ship.** `spike` added to `tsconfig.json`'s `exclude` (verified: `dist/spike` does not exist after `npm run build`), `spike/**` to `eslint.config.mjs` `ignores`, `spike/` to `.prettierignore`. No file under `src/`, `index.ts` or `test/` was touched. Nothing is named `*.test.ts`, so `jest.config.js` needed no change.

**Baseline re-verified after all changes:** `build` 0 · `typecheck` 0 · `lint` 0 errors / 116 warnings · `format:check` clean · `test` **524 passing / 20 suites, twice** (SMELL-17 flake check).

### 2.1 What "single hop" means in the implementation, precisely

Deliberately literal, because the design says *"passed **directly** as an argument"*. An argument expression is a source if and only if it is:

- a **property access** whose resolved symbol declares a `@Sensitive`-marked `PropertyDeclaration` / `PropertySignature` (or whose owning class is marked), or
- an **identifier** whose resolved symbol declares a `@Sensitive`-marked `ParameterDeclaration`.

Parentheses, `as` casts and non-null assertions are stripped. Everything else is not a source. The receiver is resolved via `checker.getResolvedSignature(call).declaration.parameters[i]`, with rest parameters handled separately. **Every construct that falls through this is a blind spot, and enumerating them is the point of §6.**

---

## 3. Question 1 — does single-hop detection work?

**Yes, and it is precise.** Every finding the tool reported on every fixture was a genuine syntactic hop. There were no spurious findings in the narrow sense — nothing was reported that was not really a marked value being passed to an unmarked parameter.

Two positive results I did not expect:

**Barrels and re-exports are not a wall.** `crossmodule.ts` passes `p.mrn` through `barrel.ts`, which re-exports `deep.ts` via `export {receiveDirect, receiveRenamed as receiveAliased} from './deep'` and `deep2.ts` via `export *`. All three calls resolved to the real parameter declaration in the real file, and `--fix` wrote into `deep.ts` and `deep2.ts` correctly. `getResolvedSignature` follows alias symbols through both forms. I had this down as a probable failure and it is not one.

**Interface dispatch resolves.** `r.report(s.ssn)` against `interface Reporter { report(v: string): void }` resolves to the *interface's* method signature. That is correct as detection — and it is a trap for `--fix`, see §5.

---

## 4. Question 2 — does the iteration converge, and in how many rounds?

**Yes. Rounds to fixpoint = longest chain depth + 1.** The `+1` is the confirming round that produces no edits, which is how the tool knows it is done.

All figures below are in **JSDoc `--fix` mode**, because decorator mode cannot fix these fixtures at all (§5). "Compiles" is `getSyntacticDiagnostics` + `getSemanticDiagnostics` on the fixed tree, which the first version of this spike did not check — and that omission is how a run reported `CONVERGED=true` over seven `TS1206`s.

| Fixture | Shape | Rounds | Annotations | Wall | Fixed tree compiles |
|---|---|---|---|---|---|
| `chain.ts` | 5 hops, branch at 3, merge at 4, two sinks at 5 | **6** | 7 | 1,063 ms | **YES** |
| `realistic.ts` | payments service, 4 entry hops, depth 3 | **4** | 8 | 782 ms | **YES** |
| `recursion.ts` | self-recursion + 2-cycle + 3-cycle | **4** | 6 | 787 ms | **YES** |
| `crossmodule.ts` + barrel | 3 hops across a barrel | **2** | 3 | 545 ms | **YES** |
| `blindspots.ts` | 25 leaking cases | **2** | 6 | 625 ms | **YES** |

### 4.1 The chain, round by round

```
round  1  findings=1  written=1    Customer.ssn      -> validate(taxId)
round  2  findings=1  written=1    validate(taxId)   -> route(candidate)
round  3  findings=2  written=2    route(candidate)  -> reject(bad)
                                   route(candidate)  -> accept(good)          BRANCH
round  4  findings=2  written=1    reject(bad)       -> audit(subject)
                                   accept(good)      -> audit(subject)        MERGE, deduped
round  5  findings=2  written=2    audit(subject)    -> writeAuditLog(entry)  SINK 1
                                   audit(subject)    -> emitMetric(label)     SINK 2
round  6  findings=0  written=0    CONVERGED
```

The branch and the merge both behave correctly. Round 3 fans out to two receivers; round 4 has two *findings* but writes one *annotation*, because both callers target the same parameter and the fixer dedupes on `(file, position)`. A value reaching two different sinks produces two annotations at round 5.

### 4.2 The `+1` round is not free, and it is the whole DX problem

A 5-hop chain requires **six** invocations of the tool to reach silence — five that change the code and one that confirms. §8 says what that feels like.

### 4.3 What convergence actually means here — the finding that decides the verdict

Look at the last productive round. The annotations written at round 5 land on `writeAuditLog(entry)` and `emitMetric(label)`. Those are the sinks. Their bodies are `console.log(...)`. The tool walked the value from the field to the log statement, one careful hop at a time, and on arrival **wrote `@sensitive` onto the parameter of the function that logs it, and reported success.**

At no point does the mechanism have a notion of a sink, because the design as proposed does not have one. It has sources (marked things) and receivers (unmarked parameters), and its terminal condition is "every receiver reachable in one hop from a source is itself a source." That condition is satisfied *by* reaching every sink.

This is not fixable by adding a sink list, either — or rather, it is, but adding one converts the design into something else. The moment you say "and when the receiver is `console.log`, report a leak instead of annotating," you have stopped doing iterative propagation and started doing reachability, and the annotations become bookkeeping for an analysis whose real output is a path. §9 takes that seriously as the thing to build.

**Corollary, and it is worse than the above:** the tool is silent in three different states that a developer cannot distinguish — not run, run and genuinely clean, and run and converged-having-annotated-every-sink-in-the-program. `docs/pii-redaction-plan.md` §11.2 calls a design that lets a developer believe they are covered when they are not *"worse than no design at all."* This is that, with a green check mark on it.

---

## 5. Question 7 — what does `--fix` write, exactly? (and why this kills the design)

**The design assumes `--fix` writes a parameter decorator. In most positions, TypeScript will not accept one.**

`spike/legality.js` compiles one probe per syntactic position under `experimentalDecorators: true`:

| Position | Parameter decorator |
|---|---|
| class method parameter | **LEGAL** |
| class constructor parameter | **LEGAL** |
| class static method parameter | **LEGAL** |
| class accessor parameter | **LEGAL** |
| destructured class-method parameter | **LEGAL** |
| optional class-method parameter | **LEGAL** |
| rest class-method parameter, `@S() ...v` | **LEGAL** |
| rest class-method parameter, `...@S() v` | **PARSE ERROR** TS1003 |
| **free function declaration** | **ERROR** TS1206 *Decorators are not valid here* |
| **exported free function** | **ERROR** TS1206 |
| **function expression** | **ERROR** TS1206 |
| **arrow function** | **PARSE ERROR** TS1109 *Expression expected* |
| **object literal method** | **ERROR** TS1206 |
| **interface method signature** | **ERROR** TS1206 |
| **function type node** | **PARSE ERROR** TS1110 *Type expected* |
| class method overload signature | **ERROR** TS1206 |
| abstract class method | **ERROR** TS1206 |
| `declare function` | **ERROR** TS1206 |

**7 legal of 18.** The legal set is exactly *parameters of concrete class members*. Everything else is illegal, and three positions do not even parse.

### 5.1 This is not a corner case — it is the common case

`chain.ts` is five ordinary exported functions. In decorator mode:

```
=== chain.ts   [--fix mode: decorator] ===
  round  1  findings=1  written=0  unfixable=1
  CONVERGED=true  rounds-to-fixpoint=1  total-annotations=0
  PERSISTENT UNFIXABLE FINDINGS AT FIXPOINT: 1
```

**Zero annotations. Zero progress. The iteration is stuck at hop 1 forever**, reporting the same finding on every run, with no `--fix` able to resolve it. The "next hop in the chain" the user asked for never arrives, because the current hop can never be discharged.

I found this the way it deserves to be found: the first version of this spike did not typecheck its own output, reported a clean 6-round convergence on `chain.ts`, and had written seven `TS1206`s. `eslint --fix` did the same thing more loudly — it broke **4 of 9 fixture files** with parse errors, including writing a decorator into a function *type* node (`emit: (@Sensitive() v: string) => void`) and into an *interface* method signature.

### 5.2 The JSDoc fallback works — and introduces a new problem

`/** @sensitive */` inline before the parameter is legal in **all five** positions tested, including function type nodes and interface method signatures where a decorator is a parse error. With JSDoc as the writer, every fixture converges and every fixed tree compiles (§4).

```ts
export function audit(/** @sensitive */ subject: string, outcome: string): void {
```

**But a JSDoc tag has no runtime existence.** It is erased by the compiler like any comment. So the propagated markings are inert: adorn's runtime redaction cannot read them, `getEffectiveFieldContract` will never see them, and the §8.1 intersection report cannot enumerate them without re-running the compiler. This is Lombok's `RetentionPolicy.SOURCE` (`pii-redaction-plan.md` §3.2) — arrived at by accident rather than chosen, and with the opposite consequence. Lombok's source-only annotation is fine because Lombok *compiles the redaction into a method body*. A source-only `@sensitive` here compiles into nothing at all.

The result is **two vocabularies for one concept**. `spike/idempotence.js` test 3 produces exactly that: a hand-written `@Sensitive()` decorator and a tool-written `/** @sensitive */` coexisting in one file, meaning the same thing, readable by different consumers. A developer now has to know which one a given path honours.

An `auto` mode (decorator where legal, JSDoc elsewhere) is worse, not better: the notation a parameter ends up with is determined by whether its enclosing function happens to be a class method, which is a fact about code organisation that has nothing to do with privacy.

**And the JSDoc writer will mark things DEC-PII-2 forbids marking.** `spike/idempotence.js` test 4 produced:

```ts
export type Fn = (/** @sensitive */ v: string) => void;
```

That is a marking on a **type**, which DEC-PII-2 rules out explicitly and for good reason. The fixer has no way to avoid it: the resolved signature declaration *is* the type node.

### 5.3 Re-runs, and already-annotated parameters

These behaved well, and are the part of the design that is genuinely sound.

- **No churn.** `spike/idempotence.js` test 1: run 1 writes `[1, 1, 0]`; runs 2 and 3 write `[0]`. Exactly two tags in the file. The dedupe is on the *declaration*, so a parameter reached from two sources gets one annotation.
- **An already-annotated parameter is left alone**, including one annotated *differently*. `take(@Sensitive({never: true}) v: string)` produces no finding, because `isMarked` ignores the argument list. Correct as far as it goes — **and it means the tool can never upgrade, downgrade or reconcile a marking.** If propagation determines that a parameter should be `{never: true}` and it currently carries a plain `@Sensitive()`, nothing happens and nothing is reported. Under DEC-PII-2's three-valued lattice, that silence is a real gap.
- **A rest parameter is never fixed**, deliberately. `f('label', s.ssn)` into `f(label, ...rest)` marks one binding covering N arguments, which is not the same statement. Left as a permanent unfixable finding, which means `blindspots.ts` never reaches a truly empty report — it reports the same rest-parameter finding on every run forever. Loud rather than silent, which is the right failure, but it means "converged" and "zero findings" are not the same state.

---

## 6. Question 5 — what it fundamentally cannot see

**This is the section the brief asked to be exhaustive and blunt about, and the numbers are bad.**

Ground truth: every one of the 25 cases in `spike/fixtures/blindspots.ts` genuinely leaks a `@Sensitive` value to console output. Measured with a single round, first contact.

| Case | Shape | Seen? |
|---|---|---|
| `bs0_control` | marked field passed directly — **the control** | **SEEN** |
| `bs1_localVar` | `const copy = s.ssn; sink(copy)` | **SILENT MISS** |
| `bs2_any` | holder typed `any` | **SILENT MISS** |
| `bs3_dynamic` | `s[key]` | **SILENT MISS** |
| `bs4_jsonBoundary` | `JSON.parse(JSON.stringify(s)) as Subject` | SEEN — *see caveat* |
| `bs5_callback` | `[s.ssn].forEach(v => console.log(v))` | **SILENT MISS** |
| `bs5_hof` | `emit(s.ssn)` where `emit` is a function-typed parameter | SEEN — *and unfixable* |
| `bs5_install` | callback passed into a higher-order function | **SILENT MISS** |
| `bs6_destructure` | `const {ssn} = s` | **SILENT MISS** |
| `bs6_paramDestructure` | `function f({ssn}: Subject)` | **SILENT MISS** |
| `bs7_objectSpread` | `sink({...s})` | **SILENT MISS** |
| `bs7_argSpread` | `sink(...args)` | **SILENT MISS** |
| `bs8_template` | `sink(\`user ${s.ssn}\`)` | **SILENT MISS** |
| `bs8_direct` | ``console.log(`user ${s.ssn}`)`` | **SILENT MISS** |
| `bs9_assign` | `Object.assign({}, s)` | SEEN — *see caveat* |
| `bs10_caller` | `sink(read(s))` — value returned from a function | **SILENT MISS** |
| `bs11_transform` | `sink(s.ssn.slice(-4))` | **SILENT MISS** |
| `bs12_wrapped` | `sink({value: s.ssn})` | **SILENT MISS** |
| `bs13_rest` | into a rest parameter | SEEN — *never fixable* |
| `bs14_fieldWrite` | `c.payload = s.ssn` then `sink(c.payload)` | **SILENT MISS** |
| `bs15_cast` | `s.ssn as unknown as string` | **SEEN** |
| `bs16_directSink` | `console.log(s.ssn)` | **SEEN** (as `external-boundary`) |
| `bs17_iface` | dispatched through an interface method | SEEN — *fix illegal* |
| `bs18_indexSig` | `bag['ssn'] = s.ssn` | **SILENT MISS** |
| `bs19_optional` | `s?.ssn ?? ''` | **SILENT MISS** |

> **17 of 25 silently missed — 68%.**

**Every miss is silent.** There is no "I could not analyse this" diagnostic anywhere, because there is nothing to diagnose: the argument expression simply is not a marked property access or a marked parameter identifier, and the analyser moves on. This is precisely the false-confidence failure mode `pii-redaction-plan.md` §11.2 names as disqualifying.

### 6.1 The two "SEEN" results that are luck, not coverage

`bs4_jsonBoundary` and `bs9_assign` are detected, and neither is a real capability.

- `bs4` works because the fixture writes `JSON.parse(wire) as Subject`. The **cast** restores the nominal type, so `back.ssn` resolves to the marked `Subject.ssn` declaration. Remove the cast and `back` is `any` and the case becomes `bs2` — a silent miss. It is detected because the developer happened to annotate.
- `bs9` works because `Object.assign({}, s)` has return type `{} & Subject`, so `target.ssn` still resolves to the marked property. Change it to a manual copy, a spread, or anything with a widened type, and it vanishes.

Neither survives a small refactor. Reporting them as coverage would be the overclaim this project has already had to retract once (Q-3).

### 6.2 The most dangerous blind spot

**Template-literal interpolation into a logger — `bs8_direct`.**

```ts
console.log(`user ${s.ssn}`);   // completely invisible
```

It wins on all three axes that matter. It is **the most common way a value reaches a log in JavaScript** — more common than passing it as a bare argument. It is **totally invisible** to this analysis, with no partial signal of any kind. And it is invisible in a tool **whose entire purpose is finding values that reach logs**, so a clean report is read as "nothing reaches a log" when the canonical path was never examined. A developer who runs this to convergence, sees green, and ships has been actively misled.

Runner-up: `bs1_localVar`. `const copy = s.ssn` is the most trivial possible severing — one line, zero intent — and it defeats the analysis completely. Any developer who extracts a variable for readability silently disables the tool for that path.

Note also that `bs8_direct` and `bs16_directSink` differ by *one template literal* and produce opposite results: `console.log(s.ssn)` is reported, ``console.log(`${s.ssn}`)`` is not. That is not a coverage boundary a developer can hold in their head.

### 6.3 The specific items the brief listed

For the record, each answered directly:

- **`any`** — silent miss (`bs2`). Total. No symbol, no declaration, no marking.
- **Dynamic property access** — silent miss (`bs3`), even with a literal union key type where the answer is statically knowable.
- **`JSON.parse` boundaries** — silent miss in general; detected only when a cast happens to restore the type (§6.1).
- **Callbacks / higher-order functions** — partly worse than a miss. `bs5_hof` is *detected*, and the fix target is a function type node where a decorator is a **parse error** (§5). `bs5_callback` and `bs5_install` are silent misses.
- **Destructuring** — silent miss, both in a body (`bs6_destructure`) and in the parameter list (`bs6_paramDestructure`).
- **Spread** — silent miss, both object spread (`bs7_objectSpread`) and argument spread (`bs7_argSpread`).
- **Re-exports and barrels** — **not a blind spot.** Resolved correctly through both `export {x as y} from` and `export *`, with fixes written into the correct far-side file (§3). The one clear positive surprise of the spike.
- **Module boundaries** — see above; resolution works. The *fix* is the problem, and only for ESLint (§7).
- **Template-literal interpolation** — silent miss, and the most dangerous one (§6.2).
- **`Object.assign`** — nominally detected, for a type-shaped reason that does not generalise (§6.1).

---

## 7. Question 6 — tooling: ESLint rule, CLI, or both?

**One analysis core genuinely serves both for *detection*. It cannot serve both for *fixing*, and that is structural rather than an implementation compromise.**

### 7.1 What shares cleanly

`spike/eslint-rule.js` imports `classifySource`, `isMarked` and `MARKER` from `spike/core.js` **unchanged** and reproduces the CLI's findings exactly. A typescript-eslint type-aware rule gets a full `ts.Program` and `TypeChecker` via `ESLintUtils.getParserServices(context)`, plus `esTreeNodeToTSNodeMap` to get from the ESTree node to the TypeScript node — after which it is the same compiler API the CLI uses. There is no capability gap on the detection side. Measured, over the fixture set:

```
  total findings 19   with an autofix 15
  by message {"hop":15,"external":1,"crossFile":3}
  ESLint wall 475 ms (one pass, 9 files)
```

### 7.2 What does not share, and why

**An ESLint fix is confined to the file being linted. The fix target is the *callee's* parameter declaration, which is in a different file whenever the call crosses a module.**

That is not a policy ESLint could relax; it is how the fixer works — a rule returns text ranges into the source it was given. In the fixture set, **3 of 19 findings were cross-file** and could carry no fix at all. In real code that fraction is far higher, because a call into a helper in another module is the normal case and a call into a helper in the same file is the exception. My fixtures understate this badly.

Two further frictions, both measured:

- **ESLint hard-errors if any report carries a `fix` while `meta.fixable` is unset** (`Fixable rules must set the meta.fixable property`). So the rule must declare itself fixable to handle the same-file case, and then silently fail to fix the cross-file case — advertising a capability it delivers only sometimes.
- **Even same-file, the fix is at a location the report does not own.** The finding is at the call site; the edit is in the callee's signature, possibly hundreds of lines away. `eslint --fix` would silently edit a function the developer is not looking at, from a diagnostic pointing somewhere else. That is a bad interaction with editor-on-save fixing regardless of correctness.

### 7.3 Does it need `ts-morph`?

**No.** The raw compiler API did everything here — resolution, legality classification, and text edits at known offsets — in about 250 lines. `ts-morph` buys ergonomic AST mutation and re-printing, which is worth a dependency for a tool that *restructures* code. This tool inserts a fixed string at a known position. Adding a dependency for that is not justified, and it would be a dependency the ESLint rule could not use anyway (it already holds a `ts.Program` and must not build a second one).

### 7.4 Recommendation

**ESLint rule: report-only, no fixer, ever. CLI: the only thing that writes.** A docs-generation CLI is coming anyway (DEC-007), so the second half costs little.

This is a genuine, clean split rather than an awkward compromise — **provided the ESLint rule never pretends to fix.** A rule that fixes same-file findings and not cross-file ones would train developers to believe `--fix` handles it, which is precisely the partial-coverage-breeds-false-confidence pattern this project keeps warning itself about. The report-only rule has a real job: it is fast, it runs on save, and for the direct-sink case (§9) it is genuinely useful today.

---

## 8. Question 8 (cost) and the DX question

### 8.1 Cost, measured on this repo

`spike/bench.js`, TypeScript 6.0.3, Node v22.11.0:

| Scope | Root files | LOC | Call exprs | Program build | Single-hop walk | **Per round** |
|---|---|---|---|---|---|---|
| `src/` only | 18 | 6,258 | 779 | 753 ms | 135 ms | **888 ms** |
| whole repo | 41 | 14,724 | 6,119 | 578 ms | 351 ms | **929 ms** |
| whole repo, 2nd run same process | 41 | 14,724 | 6,119 | 480 ms | 293 ms | **773 ms** |

- **~63 ms per 1k LOC per round** on this repo.
- The walk costs **48–57 µs per call expression**, dominated by `checker.getResolvedSignature` — that is the type-checker doing overload resolution, not my traversal.
- **Nothing meaningful amortises across rounds.** The second run in the same process is 17% faster (module cache, JIT warmth), not 10× — because each round must rebuild the `Program` from the *edited* source. There is no incremental path: the previous round changed the files.

**Total for the 5-hop chain: 6 rounds × ~0.9 s ≈ 5.5 s** on a 15k-LOC repo.

### 8.2 Scaling

I could not measure a large codebase (§10) so this is reasoning, labelled as such. The per-round cost is dominated by program construction, which is TypeScript's own cost and is **superlinear in cross-file type resolution**, not linear in LOC. `tsc --noEmit` on a 500k-LOC monorepo is commonly 30–120 s. The iterative design pays that **on every round**, and rounds scale with the longest sensitive chain, which grows with codebase depth. A 10-hop chain in a large monorepo is plausibly 11 × 60 s ≈ **11 minutes of wall time to converge**, spread across 11 separate developer-initiated invocations.

Treat the 63 ms/kLOC figure as a floor for a small-program regime, not a projection.

### 8.3 The developer experience — asked honestly

**Maddening, and it gets worse the more valuable the chain is.**

Walking a 5-hop chain means six invocations. Each one shows a *single* finding for that round with no indication of how many remain, because the tool genuinely does not know — the next hop is not visible until the current one is annotated. So the developer sees:

```
1 problem.  fixed 1.        (is that all? apparently)
1 problem.  fixed 1.        (oh)
2 problems. fixed 2.
2 problems. fixed 1.
2 problems. fixed 2.
0 problems.                 (done? or did I break something?)
```

There is no progress indicator possible, no estimate, and no way to distinguish "two more rounds" from "twenty." A tool that cannot tell you how much work remains, in a loop you must drive by hand, is a bad tool independent of whether the analysis is correct. And the reward for six rounds of this is seven annotations, five of which (§8.5) are on parameters that never log anything.

The obvious mitigation — have the CLI loop internally to a fixpoint — is what `spike/run.js` does, and it is the right call. But then the design is no longer "single-hop"; it is whole-program propagation with a single-hop *transfer function*, and it should be evaluated as such. Which brings back §4.3: iterated to a fixpoint, its output is "every parameter transitively reachable from a marked field by direct argument passing," and it stops there without saying which of them matter.

### 8.4 How does a developer know they have converged?

**They cannot, and this is a serious problem rather than a UX wrinkle.**

A silent tool that was never invoked and a silent tool that has converged are byte-identical. This project has a rule about exactly this shape — DEC-016's asymmetry-of-failure argument, and BUG-16's "the gap that is invisible to the obvious test." Here it is worse than in the documentation case, because the reader's question is *"am I leaking?"* and silence reads as *"no."*

The honest mitigations, none of which the design as proposed includes: a `--check` mode that exits non-zero on any finding and runs in CI (necessary, and it makes the developer-driven loop unnecessary because CI drives it); a written fixpoint receipt (a lockfile-style artifact recording the annotation set and the source hash, so a stale one is detectable); and printing the enumeration basis on every run, per §8.1 of the redaction plan.

Note the rest-parameter case (§5.3) means the tool may *never* reach zero findings even at a fixpoint, so "silent" and "converged" are not the same state anyway.

### 8.5 Question 4 — the false-positive rate

`spike/fixtures/realistic.ts` is a payments service where every receiving parameter is tagged `REACHES-SINK` or `INERT` in ground truth. Run to convergence:

| Annotation written | Ground truth |
|---|---|
| `tokenize(rawPan)` | INERT |
| `simpleHash(input)` | INERT |
| `assessRisk(pan)` | REACHES-SINK |
| `recordReview(subject)` | REACHES-SINK |
| `writeReviewLog(detail)` | REACHES-SINK |
| `luhn(digits)` | INERT |
| `queueReceipt(address)` | INERT |
| `renderReceipt(to)` | INERT |

> **8 annotations. 3 reach a sink. 5 inert. Annotation-spam rate 63%.**

**Is that correct-and-harmless, or is it spam?** The brief asks the question the right way round, and the answer is: **it is correct, it is not harmless, and calling it "defence in depth" would be motivated reasoning.**

The case for harmless is real and should be stated. Under DEC-PII-1 an annotation is never load-bearing, so an unnecessary one costs nothing at runtime. `luhn(digits)` genuinely does receive a PAN; marking it is *true*. And a parameter that is inert today can become a sink tomorrow with a one-line `console.log` added by someone who never read this document — the annotation is there waiting.

The case against is stronger, on three grounds:

1. **63% noise trains the reader to skim.** A privacy review artifact where two out of three entries are irrelevant is a document nobody reads carefully, which is the failure mode `pii-redaction-plan.md` §8.3 already identifies for the report. This directly degrades the §8.1 intersection projection, whose value is precisely that a human looks at it.
2. **`@Sensitive` is supposed to be an enumerable declaration of developer intent** (DEC-PII-1: *"an enumerable declaration that a report and a runtime alert can read"*). A tool-written annotation on `simpleHash(input)` is not a statement of intent; it is a derived fact. Mixing derived facts into a declaration surface destroys the property that makes the surface worth reading — you can no longer tell what a human asserted from what a tool inferred. `pii-redaction-plan.md` §11.7 already worries about class-level markings making the report less informative; this is that problem multiplied.
3. **The spam is not correlated with risk in either direction.** `renderReceipt(to)` was annotated; `enqueue(body)` was not — because `renderReceipt` returns a template literal, which severs the chain (`bs8`/`bs10`). `simpleHash(input)` was annotated; `submit(token)` was not, for the same reason. So the annotation set is shaped by which syntactic patterns happen to match, and that has essentially no relationship to which values are actually at risk. **The set is neither sound nor complete, and it is not conservative in a useful direction.**

---

## 9. Question 3 restated as a proof, and what I would build instead

### 9.1 Termination is provable, not merely observed

The one part of the design that is unconditionally sound, so it should be recorded properly rather than left as three green fixtures.

**Claim.** The iteration terminates on any program, including under direct and mutual recursion.

**Proof.** Let `P` be the finite set of parameter declarations in the program. Let `M ⊆ P` be the marked set. Each round computes `M' = M ∪ f(M)` where `f(M)` is the set of unmarked parameters receiving a marked expression in one hop. `f` is monotone, no round ever removes a marking, and `M' ⊇ M` with `M' ⊆ P` finite. The sequence `M₀ ⊆ M₁ ⊆ …` is therefore an ascending chain in a finite lattice and reaches a fixpoint in at most `|P|` rounds. Recursion is not special: `isMarked(target)` short-circuits before a finding is generated, so a recursive call whose parameter is already marked contributes nothing.

**Measured, matching the proof:**

| Shape | Rounds |
|---|---|
| direct self-recursion `countdown(value, n-1)` | resolves in the round it is marked — the recursive call sees the marking immediately |
| mutual recursion, 2-cycle `ping ⇄ pong` | 2 productive rounds |
| mutual recursion, 3-cycle `alpha → beta → gamma → alpha` | 3 productive rounds |

All in one fixture, converging together in 4 rounds with 6 annotations and a compiling tree. **Termination is not the risk in this design.** That is worth saying clearly, because it is the property the proposal leads with, and it is the one that survives.

### 9.2 SMELL-1 — does parameter-name degradation matter here?

**No. Stating that plainly rather than leaving it hanging, because the expectation in the brief was correct.**

SMELL-1 is about `getParamNames` recovering names by regex over `func.toString()` at *runtime*, which `esbuild --minify` degrades to `s`, `t`. This tool never does that. It runs on **source**, before any bundler exists, from a `ts.Program` where `taxId` is `taxId` because that is what the file says. Its output is an annotation written back into source, which is then compiled by the normal toolchain. There is no point in the pipeline at which a minified name is consulted.

The downstream retention story is unaffected too, and matches `pii-redaction-plan.md` §9 exactly: a parameter decorator records by **index** in `ParameterContract`, and indices do not minify. Only the human-readable *label* degrades, which §9 already accepts.

**The one caveat, and it is a different problem wearing SMELL-1's clothes:** the JSDoc form §5.2 forces has *no* runtime retention at all — not degraded, absent. That is TypeScript erasure, not minification, and it is a worse retention story than SMELL-1 describes. It belongs in the §5.2 discussion, not here, but a reader who files it mentally under "minification" will misdiagnose it.

### 9.3 What I would build first, if this proceeds

**Not the propagation.** Two things instead, in this order.

**(1) The direct-sink rule — ship this, it is nearly free.** The `external-boundary` finding (`bs16`, `console.log(s.ssn)`) works today, has no `--fix`, needs no iteration, needs no new vocabulary, and has essentially zero false positives. It caught the one case in the fixture set where a marked field goes straight into a logger. As a report-only typescript-eslint rule it runs in under 500 ms on this repo and is useful on the day it lands. Its coverage is narrow and must be documented as narrow — it will not catch `bs8_direct`, one template literal away — but it never *claims* the coverage the propagation design implies.

**(2) The reachability report, not the annotation pass.** The thing with actual value is not "which parameters are transitively marked" but:

> `Customer.ssn` reaches `console.log` at `chain.ts:58` via `Enrollment.start → validate → route → accept → audit → writeAuditLog`

That is one artifact, produced by one whole-program run, naming a path. It answers the developer's real question, it is checkable in CI, it writes nothing into source so it has no legality problem and no two-vocabulary problem, and there is no convergence ambiguity because a run either finds paths or it does not. It is the §8.1 intersection projection with a call graph behind it instead of a registry read.

It is also **strictly more work** — it is interprocedural reachability, which is the thing the single-hop design was invented to avoid. That trade should be made with open eyes: the single-hop design is cheap because it does not answer the question, and this spike's central finding is that its terminal state carries no signal. Building the cheap thing does not get you a down-payment on the expensive thing; it gets you an annotation pass whose green light means nothing.

**Deliberately not first:** the `@Sensitive` parameter decorator's *manual* use (DEC-PII-5) is unaffected by any of this and remains the right answer for primitives. Nothing in this spike argues against a developer writing `transfer(@Sensitive() ssn: string)` by hand. The spike only says a tool cannot reliably write it for them.

---

## 10. What I could not measure

- **Cost on a large codebase.** No monorepo was available. §8.2 is reasoning from TypeScript's known program-construction behaviour, explicitly labelled as reasoning.
- **The false-positive rate on real production code.** 63% is from one hand-written fixture with hand-tagged ground truth, which I also wrote — so it measures my model of realistic code, not realistic code. The number is indicative, not a population estimate. The *shape* of the result (spam uncorrelated with risk, §8.5.3) is more robust than the percentage.
- **The 68% blind-spot figure is likewise fixture-dependent.** What is not fixture-dependent: every miss is silent, and the missed shapes are ordinary JavaScript. A different fixture set moves the number, not the conclusion.
- **Standard (TC39) decorators were not tested.** All legality results are `experimentalDecorators`. TC39 decorators contain **no parameter decorators at all** (DEC-003), so the legal set there is presumably empty, but I did not verify it and the spike did not need to.
- **`ts-morph` was not installed or trialled.** §7.3 argues it is unnecessary from what the raw API did, not from a comparison.
- **Whether a `@Sensitive`-on-a-class marking propagates correctly.** `classifySource` has a `class-field` branch, written but never exercised by a fixture.
- **Multi-round `eslint --fix` behaviour with stale type information.** ESLint re-lints up to 10 times per file within one `--fix` invocation; whether typescript-eslint rebuilds the `Program` between those passes (and therefore whether `isMarked` reads current or stale text) was not determined. It did not matter here because the decorator writer produced parse errors on pass 2 regardless — but it would matter for a JSDoc-writing ESLint fixer, and it should be checked before anyone builds one.
- **Terser `mangle.properties`.** Same caveat `pii-redaction-plan.md` §12 already records; unchanged by this spike.

> **Extended by §14.9**, which lists what the *re-evaluation* could not measure. Everything above still stands.

---

## 11. Proposed decision entry

> **A proposal, in this document.** Written in `DECISIONS.md` format for easy transfer. `DECISIONS.md` was **not** edited. The identifier is a placeholder — DEC-021's numbering note records what happens when two agents claim the same number.
>
> **This is an amendment to DEC-023, not a competing entry.** DEC-023 ratified the design *and* made itself conditional on this spike (`feasibility unproven`, point 4). The spike returns negative on its point 1 and positive on points 2 and 3. On adoption this should be folded into DEC-023 as a superseding revision rather than filed alongside it, so there is one entry a reader lands on.

### DEC-024 — DEC-023's iterative single-hop propagation is rejected; the detector is retained
**Status:** PROPOSED · **source:** this spike · **amends:** DEC-023 · **relates to:** DEC-PII-1, DEC-PII-5, DEC-PII-6, DEC-003, DEC-016

**Context.** `pii-redaction-plan.md` §5.4 establishes that `@Sensitive` cannot propagate through primitive-typed parameters at runtime, and §5.5 rejects value-tainting on measured grounds. DEC-023 adopted a build-time answer — iterated single-hop analysis: find a marked value passed directly as an argument, annotate the receiving parameter, repeat until no new flows appear — and gated it on a feasibility spike. The appeal was that it sidesteps whole-program interprocedural taint analysis while coverage accumulates through repeated application.

**Decision.** **Do not build the propagation.** Neither as an ESLint fixer nor as a CLI `--fix`. DEC-023 point 1 is rejected. Points 2 and 3 survive and are sharpened below.

**Status of each DEC-023 ruling after measurement:**

| DEC-023 | Outcome |
|---|---|
| 1. Iterative single-hop, propagation materialized in source | **REJECTED.** The mechanism works and terminates; its fixpoint carries no signal, and `--fix` cannot write the annotation in most positions. |
| 2. Report by default, `--fix` opts in | **VINDICATED, and strengthened to report-only.** The spike found `--fix` is not merely risky but frequently produces non-compiling source. |
| 3. Both an ESLint rule and a CLI over one analysis core | **CONFIRMED for detection, refuted for fixing.** One core served both, verified by building both. An ESLint fix cannot cross files, so the rule must be report-only permanently. |
| 4. A spike precedes implementation | **DISCHARGED** by this document. It is also the ruling that saved the work — the design looked sound until its own output was compiled. |

**Rationale — three findings, in order of decisiveness.**

1. **Its terminal state carries no signal.** The design has sources and receivers but no notion of a sink, and its fixpoint is reached *by* propagating a marking onto every sink in the program. Measured: on a 5-hop chain the final annotations landed on the two functions that call `console.log`, and the run reported success. A tool that is silent when done, silent when not invoked, and silent when it has annotated every leak in the codebase is the false-confidence failure DEC-PII-1 and `pii-redaction-plan.md` §11.2 identify as disqualifying — *"a design that lets a developer believe they are covered when they are not is worse than no design at all."*

2. **`--fix` cannot write what the design requires.** Measured: a legacy parameter decorator is legal in **7 of 18** syntactic positions — parameters of concrete class members only. Free functions, arrow functions, function expressions, interface methods, abstract methods, overload signatures and function types all reject it (`TS1206`), three as parse errors. On a fixture of five ordinary exported functions, `--fix` wrote **zero** annotations and the iteration was permanently stuck at hop 1. The JSDoc fallback compiles everywhere but is **erased**, producing a second, runtime-invisible vocabulary for the same concept and marking constructs DEC-PII-2 forbids marking (a `type` alias).

3. **It cannot see most real leaks, silently.** Measured: **17 of 25** genuinely-leaking fixture cases were silently missed (68%), including template-literal interpolation into a logger — the most common leak shape in JavaScript, and one that differs from a detected case by a single template literal. And of what it *does* annotate, **63%** is on parameters that never reach a sink, with the spam uncorrelated with risk in either direction.

**What survives and is recorded so it is not re-derived.** Termination is provably sound — a monotone function over a finite lattice, bounded by parameter count, unaffected by direct or mutual recursion (verified: 2-cycle and 3-cycle both converge). Detection is precise: no spurious findings. Fixes are idempotent with no re-run churn. Barrels and `export *` re-exports are **not** a wall — `getResolvedSignature` resolves through both. And SMELL-1 is irrelevant to any build-time tool operating on source: it reads pre-bundler names, and a parameter decorator records by index.

**Consequences.**
- **DEC-PII-5 stands unweakened.** The primitive gap remains closed only by an explicit hand-written `@Sensitive()` on the parameter. This spike found no automated substitute and demonstrates why the two obvious ones fail.
- **The single-hop detector is retained in two narrower forms** (proposed as IDEA-10): a report-only direct-sink ESLint rule, and a whole-program reachability report that names the path rather than annotating it. Neither writes to source; neither has the false-confidence failure mode.
- **`adorn check` (IDEA-9) loses its `--fix`, not its reason to exist.** The CLI is still the right home for the reachability report, and is still arriving for `adorn docs` regardless.
- **Tooling split, if either is built:** one analysis core can serve an ESLint rule and a CLI for *detection* — verified by building both over one core. It cannot serve both for *fixing*, because an ESLint fix is confined to the linted file while the fix target is the callee's declaration, usually in another file. The ESLint rule must therefore be **report-only, permanently**; a rule that fixes same-file findings and not cross-file ones would train exactly the over-trust this decision exists to prevent. `ts-morph` is not needed; the raw compiler API was sufficient.
- **Cost, for whoever revisits this:** ~0.9 s per round on this 15k-LOC repo, ~63 ms per 1k LOC, dominated by `ts.createProgram` and `getResolvedSignature`, with nothing amortising across rounds because each round edits the source the next round must re-parse.

---

## 12. What changed my mind while spiking

Three things, all of which reversed a position I held going in.

**1. I expected the blind spots to be the finding, and they are not.** They are bad — 68% — but a partial analysis with documented gaps is a defensible artifact; `pii-redaction-plan.md` §6.4 already builds the machinery for saying "here is what we do not cover." What I did not anticipate is §4.3: that the design's *success condition* is the state in which it has annotated every sink and reported nothing. That is not a coverage gap to be documented. It means the green light is uninformative by construction, and no amount of honest gap-listing repairs it. This moved the verdict from "viable with heavy caveats" to "reject."

**2. `TS1206` was invisible to me until the tool's own output failed to compile.** I wrote the analyser, ran it, watched `chain.ts` converge in six clean rounds, and wrote down the result. It was only when I built the ESLint variant and `eslint --fix` produced parse errors that I went back and typechecked the CLI's output — seven `TS1206`s. The spike had been reporting confident convergence over code that does not compile. I have added a post-fix typecheck to `spike/run.js`, but the more useful lesson is the one this repo keeps relearning (BUG-16, DEC-016): **the check that catches the real defect is the whole-pipeline one, and every direct test of the component passed.** I would not have found this from unit-testing the analyser.

**3. Barrels resolved, and I was ready to write them up as the wall.** I built `barrel.ts`/`deep.ts`/`deep2.ts` expecting to report that a re-export severs the analysis, since that is the intuition from name-based tooling. `getResolvedSignature` follows alias symbols through `export {x as y} from` and `export *` without complaint, and `--fix` wrote into the correct far-side files. It is a small result, but it is the one place the design was *stronger* than I assumed, and it is worth recording so the next person does not spend the time I did building the fixture.

A fourth, smaller: I went in assuming the ESLint-versus-CLI question would come down to capability, and it does not — the rule has the full `Program` and can compute everything the CLI can. The split is entirely about **where the edit lands**, which is a fact about ESLint's fixer contract rather than about type information. That reframed the recommendation from "the CLI is more powerful" to "the rule must never fix," which is a different and more important rule.

---

## 13. References

**Internal**
- `docs/pii-redaction-plan.md` — §5.4 (the primitive gap), §5.5 (value tainting rejected), §6.4 (the coverage table), §8.1 (the intersection projection), §9 (SMELL-1 and minification), §11.2 (partial coverage as the primary risk), §13 (DEC-PII-1 … DEC-PII-6)
- `docs/DECISIONS.md` — DEC-003 (dual-track decorators; TC39 has no parameter decorators), DEC-007 (runtime-registry-first artifact generation), DEC-012 (projections depend on no adapter), DEC-013 (TypeScript ceiling 6.x), DEC-016 (asymmetry of failure), DEC-021/DEC-022 (make the wrong thing unexpressible)
- `docs/ISSUES.md` — SMELL-1, SMELL-17, BUG-16, BUG-18, BUG-19, Q-3, Q-6, and the entries added by this spike
- `docs/observability-plan.md` — §5.3 and DEC-OBS-2 (deny-by-default value emission)

**Spike code** — `spike/core.js` · `spike/run.js` · `spike/eslint-rule.js` · `spike/eslint-run.js` · `spike/legality.js` · `spike/verify.js` · `spike/idempotence.js` · `spike/bench.js` · `spike/fixtures/`

**External**
- TypeScript `TS1206` *Decorators are not valid here* — reproduced against TypeScript 6.0.3 across 11 syntactic positions (`spike/legality.js`)
- [typescript-eslint — type-aware linting](https://typescript-eslint.io/getting-started/typed-linting/) · `ESLintUtils.getParserServices` supplies `ts.Program` and `esTreeNodeToTSNodeMap`
- [ESLint — fixable rules](https://eslint.org/docs/latest/extend/custom-rules#applying-fixes) · fixes are ranges into the linted source, so cross-file fixing is not expressible
- Lombok `@ToString.Exclude` and `RetentionPolicy.SOURCE` — the source-only-retention comparison in §5.2; see `pii-redaction-plan.md` §3.2 for the primary sources

---
---

# 14. RE-EVALUATION under a narrowed threat model

*Added 2026-07-20, after §1–§13. Same machine, same toolchain (Node v22.11.0, TypeScript 6.0.3). New spike code in `spike/sinks.js`, `spike/reeval.js`, `spike/reverify.js`, `spike/sink-legality.js`, `spike/anomalies.js` and four new fixtures; the original apparatus was reused rather than rebuilt — `classifySource`, `isMarked`, `classifyHost`, `applyFixes`, `build` and `makeWorkTree` are imported from `core.js` and `run.js` unchanged.*

> **§1–§13 are not superseded and were not edited.** They record why the design failed under the broader model, which is the evidence that justifies narrowing it. This section returns a **different verdict on a different design**, and says plainly where the narrowing does *not* help.

## 14.1 What changed, and the fresh verdict

The user's ruling, now ratified as **DEC-025 — *Trust boundary: adorn secures its own emissions, not the application's*** (written into `DECISIONS.md` concurrently with this re-evaluation, not by it):

> *"I don't consider this an issue since we're not protecting against bad developers, we're protecting our own output — so as long as they stay within the framework and aren't malicious with logging they should be fine."*

So a developer writing a raw ``console.log(`${user.ssn}`)`` is **out of scope** — adorn was never in that call path. This is the boundary an OpenTelemetry instrumentation library draws: it secures its own attribute emission, not the application's `printf`.

**DEC-025 already names the risk this section has to quantify.** Its consequences state: *"a developer may believe adorn covers them when the leak path simply exits the framework… do not let 'adorn protects your PII' become the shorthand."* §14.6 measures that population rather than restating the warning.

**The verdict, in one sentence: the narrowing rescues a design DEC-023 did not propose, and rejects again the one it did.**

| | Outcome under the narrowed model |
|---|---|
| **DEC-023 point 1 — iterated single-hop propagation, materialized in source** | **STILL REJECTED.** The narrowing does not rescue it. Its annotations remain **64% inert** (§14.5), it still stalls on `TS1206` at every free-function intermediate (§14.3), and it rescues **zero** of the 17 blind spots (§14.4). |
| **A one-pass, report-only, direct-source-to-adorn-sink detector** — *not what DEC-023 proposed* | **VIABLE, and materially better than anything in §1–§13.** Its annotation target is **provably always decorator-legal** (§14.3), its inert rate is **0%** (§14.5), it needs no iteration, no fixpoint and no `--fix` loop, and it terminates in a **leak report** rather than a marking. |

**Confidence.**

- **HIGH** on the legality result (§14.3) — 18 compiler probes, zero counter-examples, and the coincidence has a *reason* rather than being empirical luck.
- **HIGH** on "the fixpoint now carries signal" (§14.2) and on the 0% inert rate (§14.5) — the latter is structural, not a fixture artifact: if annotations can only land at sinks, an inert one is not expressible.
- **MEDIUM-HIGH** on the blind-spot count of 17 (§14.4). Fixture-dependent, exactly as §10 records. The robust claim underneath it is not the number: it is that **severing is a property of the source-side expression, so moving the sink changes nothing**, and that claim does not depend on my fixtures.
- **MEDIUM** on the *size* of the new false-confidence surface (§14.6). Its **existence** is structural; the "2 of 6" figure is from a fixture I wrote to contain it.

## 14.2 Question 1 — does the killer finding dissolve? **Yes, in JSDoc mode. No, in decorator mode.**

First, the sink set, **determined from the codebase** (`spike/sinks.js` header records the file and line for each):

| # | Emitter | Where | What reaches the emission | Is it a flow sink? |
|---|---|---|---|---|
| **S1** | `@Log()` | `src/MethodDecorators/Log.ts:92` — `context.args.map(arg => safeStringify(arg))` | **every argument**, and the return value | **YES** — every parameter of the method |
| **S2** | violation message, parameter path | `src/Core/Descriptor.ts:314` `formatMessage` → `:323` `formatReceived`, reached from `ParameterDecoratorFactory.ts:407` | the received value of the **constrained** parameter | **YES** — that parameter only |
| **S3** | `@Telemetry.value()` | `observability-plan.md` §5.3 — **proposed, not implemented** | the opted-in parameter | **YES**, by construction |
| S4 | violation message, field path | `FieldDecoratorFactory.ts:609` | the **field's** value | No — a field is already covered by `@Sensitive` on the field (`pii-redaction-plan.md` §5.1). No parameter analysis needed. |
| S5 | `@Time()` | `src/MethodDecorators/Time.ts:126` | `record.label` and `record.durationMs` **only** | **No.** A decorator is not automatically an emitter. |
| S6 | diagnostics | `ContractDiagnostics.ts:167`, `Configuration.ts:311` | structural messages, no runtime values | No |
| S7 | docs projection | `src/Projections/docs.ts` | `constraint`, `params`, `describe()` | No — never a runtime value |

**S5 is the one worth dwelling on.** `@Time` is decorated, adorn-owned, and writes to `console.log` — and it is *not* a sink, because it emits no argument value. A design that treated "has an adorn decorator" as "is an emitter" would re-inflate exactly the false-positive rate the narrowing exists to reduce. The fixture pins this: `Metrics.emitTiming(label)` receives `customer.ssn` and must not be reported.

### The 5-hop chain, re-run

`spike/fixtures/chain-sink.ts` is structurally identical to `chain.ts` — same 5 hops, same branch at 3, same merge at 4, two terminal sinks — with one change: the terminal functions are now `@Log()`-decorated **methods** instead of free functions that happen to call `console.log`.

**JSDoc `--fix` mode** (`node spike/reeval.js`):

```
round  1  findings=3  written=3   hop=2 leak=1
      [LEAK via @Log] Customer.ssn -> AuditService.writeAuditLog(entry)   <- the DIRECT case
round  2  findings=2  written=1   hop=1 leak-covered=1
round  3  findings=3  written=2   hop=2 leak-covered=1        BRANCH
round  4  findings=3  written=1   hop=2 leak-covered=1        MERGE, deduped
round  5  findings=3  written=1   leak-covered=2 leak=1
      [LEAK via @Log] audit(subject) -> Metrics.emitMetric(label)         <- the CHAINED case
round  6  findings=3  written=0   leak-covered=3               CONVERGED
```

`CONVERGED=true` · 8 annotations · 769 ms · **fixed tree compiles: YES**.

**Where the terminal annotations landed — this is the question §4.3 asked and answered badly:**

| | Count |
|---|---|
| On an **adorn sink** parameter — *load-bearing; this is what the emitter reads to redact* | **2** — `writeAuditLog(entry)`, `emitMetric(label)` |
| On an intermediate non-sink parameter — bookkeeping only | 6 |
| **Leaks reported** — source → sink → emitter, named | **2** |

**The killer finding does dissolve, and precisely as predicted.** §4.3's complaint was that the tool "walked the value from the field to the log statement and on arrival wrote `@sensitive` onto the parameter of the function that logs it, and reported success." It still writes the annotation there — but that is now **the correct and useful outcome**, because `writeAuditLog` is an `@Log`-decorated method and `entry` is a position adorn itself is about to render. The annotation is not decoration of the crime scene; it is the instruction the emitter needs.

And the terminal state is no longer uninformative. The run distinguishes three states that were previously one: *converged having found 2 leaks*, *converged clean*, and *not run*. The output is a leak report with a named source, a named sink and a named emitter, not merely a marking set.

### But decorator mode still stalls, and this is not a footnote

```
round  1  findings=3  written=2  unfixable=1
      [hop]  Customer.ssn -> validate(taxId)   {free-function, deco-ILLEGAL}
      [LEAK via @Log] Customer.ssn -> AuditService.writeAuditLog(entry)  {class-method, deco-LEGAL}
round  2  findings=2  written=0  unfixable=1   CONVERGED=true
```

`CONVERGED=true` with **one permanently unfixable finding**, 2 annotations, and — decisively — **the chained leak at `emitMetric` was never discovered at all.** The iteration is stuck at hop 1 forever because `validate` is a free function, exactly as §5.1 measured. The direct leak is found and annotated legally; the 5-hop leak is invisible.

So: **the fixpoint carries signal only in the notation that has no runtime existence.** §5.2's two-vocabulary problem is untouched by the narrowing — a JSDoc `@sensitive` on `writeAuditLog(entry)` is erased by the compiler and `@Log` cannot read it at runtime.

## 14.3 Question 2 — is chain propagation necessary? **No for the direct case, yes for the chained one — and that bifurcation is the whole result.**

### The crux: `TS1206` is moot at a sink, and it is not a coincidence

`spike/sink-legality.js` compiles three probes per syntactic position: can `@Sensitive()` go on the parameter; can `@Log()` (a `MethodDecorator`) decorate this function; can `@Enforce.minLength()` (a `ParameterDecorator`) go on the parameter.

| Position | `@Sensitive()` | `@Log()` host | `@Enforce` param | Can be a sink? |
|---|---|---|---|---|
| class method parameter | LEGAL | LEGAL | LEGAL | **YES** |
| class constructor parameter | LEGAL | *n/a* | LEGAL | **YES** |
| class static method parameter | LEGAL | LEGAL | LEGAL | **YES** |
| class accessor parameter | LEGAL | LEGAL | LEGAL | **YES** |
| destructured class-method parameter | LEGAL | LEGAL | LEGAL | **YES** |
| optional class-method parameter | LEGAL | LEGAL | LEGAL | **YES** |
| rest class-method parameter `@S() ...v` | LEGAL | LEGAL | LEGAL | **YES** |
| free function declaration | TS1206 | TS1206 | TS1206 | no |
| exported free function | TS1206 | TS1206 | TS1206 | no |
| function expression | TS1206 | TS1109 | TS1206 | no |
| arrow function | TS1109 | TS1005 | TS1109 | no |
| object literal method | TS1206 | TS1136 | TS1206 | no |
| interface method signature | TS1206 | TS1131 | TS1206 | no |
| function type node | TS1110 | TS1110 | TS1110 | no |
| class method overload signature | TS1206 | TS1249 | TS1206 | no |
| abstract class method | TS1206 | TS1249 | TS1206 | no |
| `declare function` | TS1206 | TS1206 | TS1206 | no |
| **class *expression* method parameter** | **TS1206** | TS1206 | TS1206 | no |

> **Positions that can host an adorn emitter: 7 of 18. Of those, positions where `@Sensitive()` is illegal: 0. No counter-example.**

**The two legal sets are identical, and there is a reason rather than a coincidence** — which matters, because a coincidence could be broken by a future TypeScript release and a reason cannot. `@Log`, `@Enforce.*`, `@Telemetry.value()` and `@Sensitive` are *all legacy decorators*, and TypeScript admits a legacy decorator only on a class declaration's concrete members. An adorn emitter therefore **cannot be declared** anywhere that `@Sensitive()` cannot be written. A free function can never be an `@Log` method; an interface method signature can never be one; an arrow function can never be one.

**So `TS1206` — the blocker that independently killed `--fix` in §5 — cannot bite at a sink.** Verified end-to-end rather than argued: `spike/reeval.js` writes a real `@Sensitive()` **decorator** at every leak target on the chain fixture and compiles the result — 1 annotation writable, 0 skipped as illegal, **fixed tree compiles: YES**, and a second pass reports `leaks=0 covered=1`. A single report → annotate → confirm cycle closes the direct case.

### The catch, stated plainly

`TS1206` is moot **only if you do not propagate**. The moment the design walks a chain, every intermediate hop is a free function, and §5's table applies to those intermediates with full force — which is exactly what §14.2's decorator-mode run shows. The blocker is not repealed; its *scope* shrinks to the intermediates, and the intermediates are only needed by the design that is still rejected.

**Answer to question 2, precisely:**

- Propagation is **not necessary** to catch a `@Sensitive` value handed straight to an adorn emitter. One pass, no fixpoint, decorator-legal, compiles.
- Propagation **is** necessary to catch a value that reaches an emitter through intermediate frames — and it cannot be made to work, for the same reason as before.
- The design does therefore collapse to *"detect, report, developer annotates at the sink"* — but it collapses to a **strictly smaller** design than the chained one, not to an equivalent one. What is given up is measured in §14.4 and it is most of the coverage.

**Cost, for the record.** One pass on this 15k-LOC repo is one round: **~907 ms**, 61.6 ms/kLOC (`spike/bench.js`, re-run). Against the chained design's 6 rounds ≈ 5.5 s, that is a 6× reduction — and, more importantly, §8.3's maddening developer-driven loop disappears entirely, because there is no loop.

## 14.4 Question 3 — re-partitioned blind spots. **17 of 22 in-scope cases are still genuine silent misses.**

`spike/fixtures/blindspots-sink.ts` re-points each of the 25 shapes at an `@Log()`-decorated method **wherever the shape realistically permits**, leaving as out-of-scope only those that genuinely exit the framework. Ground truth is tagged `SCOPE-IN` / `SCOPE-OUT` in the fixture and read back by `spike/reverify.js`.

**Only 3 of 25 become out of scope:**

| Case | Why out of scope |
|---|---|
| `bs8_direct` — ``console.log(`user ${s.ssn}`)`` | Raw `console.log`. adorn is not in this call path. *(This was §6.2's "most dangerous blind spot".)* |
| `bs16_directSink` — `console.log(s.ssn)` | Same. *(This was one of the few **detected** cases.)* |
| `bs5_hof` — receiver is a function-typed parameter | A function type node **can never host `@Log`** (§14.3), so this receiver cannot be an adorn emitter. *(This was §6.3's "detected, and the fix target is a parse error" case — the unfixable-position problem dissolves.)* |

**The remaining 22 are in scope, and 17 of them are still silently missed:**

| Result | Count |
|---|---|
| Out of scope under the narrowed model | **3** |
| In scope — **SEEN** | **5** — `bs0_control`, `bs4_jsonBoundary`, `bs9_assign`, `bs13_rest`, `bs15_cast` |
| In scope — **STILL A GENUINE SILENT MISS** | **17** |
| Rescued by adding propagation | **0** |

> **The real number is 17.** That is **77% of in-scope cases**, against 68% of the original inventory. The rate got *worse*, because the narrowing removed from the denominator two cases that were previously counted and one that was previously detected.

**Why the narrowing does not help here, and this is the most important sentence in §14.4:** every one of these shapes severs the chain on the **source side** — `const copy = s.ssn`, `` `user ${s.ssn}` ``, `{ssn} = s`, `{...s}`, `s[key]`, `s.ssn.slice(-4)`, `bs10_read(s)`. Whether the value's eventual destination is `console.log` or an `@Log`-decorated method is irrelevant to whether the analyser can see the argument expression at all. **Moving the sink cannot repair a source-side blindness.**

And note the category the brief warned against waving away, measured rather than assumed: **`bs8_template` — `SINK.emit(\`user ${s.ssn}\`)`, template interpolation into an `@Log` argument — is `SCOPE-IN` and is a silent miss.** The most common leak shape in JavaScript is squarely adorn's problem under the narrowed model and remains invisible. Only the raw-`console.log` twin left scope.

### A new blind spot the narrowing *creates*: interface dispatch

`bs17_iface` was recorded in §3 as one of the spike's two positive surprises — *"interface dispatch resolves."* Under the narrowed model it inverts into a miss, and `spike/anomalies.js` verifies it:

```
call site: r.report(s.ssn)
resolves to: Reporter.report  (MethodSignature)
classifySink on the resolved parameter: sink=false
>>> the CONCRETE @Log implementation (LoggingReporter.report) is NEVER consulted
for reference, LoggingReporter.report(v) is a sink: true via @Log
```

`getResolvedSignature` resolves to the **interface's** method signature. An interface method signature can never carry `@Log` (§14.3), so the concrete `@Log`-decorated implementation is never examined and the sink is invisible. Under the broad model this did not matter — the receiver's identity was irrelevant, because any receiver was annotated. Under the narrowed model the receiver's identity **is the entire question**, so resolving to the abstract declaration defeats it.

**This is not a corner case.** Calling a logging or audit service through an injected interface is the ordinary shape in dependency-injected TypeScript, and it is precisely where an `@Log`-decorated method lives. A sink-aware analysis must resolve to implementations, which means class-hierarchy analysis — more work than the single hop, and work the original design never had to do.

## 14.5 Question 4 — false positives. **63% → 0%, but only by dropping propagation.**

`spike/fixtures/realistic-sink.ts` is the same payments service, re-pointed at adorn emitters, with a four-valued ground truth: `ADORN-SINK` (the annotation is load-bearing), `REACHES` (bookkeeping), `INERT`, and `ESCAPES` (a real leak the narrowed model declares out of scope).

| Design | Annotations | Load-bearing | Bookkeeping | Inert | **Inert rate** |
|---|---|---|---|---|---|
| §8.5 original, broad model | 8 | — | 3 reach a sink | 5 | **63%** |
| **One pass, report at sink** | **1** | **1** | 0 | **0** | **0%** |
| Propagate to fixpoint | 11 | 2 | 2 | 7 | **64%** |

**The improvement is real and total — and it is not attributable to the narrowed threat model.** It is attributable to *not propagating*. Under the one-pass design an inert annotation is **not expressible**: an annotation can only be written at a position that is already an adorn emission position, so by construction it affects an emitter. That is the DEC-021 move — make the wrong thing unexpressible rather than merely rare — arrived at here for free.

The propagating variant is **64% inert, essentially identical to the original 63%**, and it is worse in a way the raw rate hides: **82% of its annotations are non-load-bearing** (inert *plus* bookkeeping). It also annotates `emitTiming(label)`, a `@Time`-decorated method that emits no argument value — a false positive created by decoration, which is the failure mode S5 was built to catch.

## 14.6 Question 5 — what is still genuinely lost, and the new false-confidence risk

**Yes, the narrowing creates a new false-confidence risk, and it is a different and in one respect worse shape than the original's.** Stating it plainly, because `pii-redaction-plan.md` §11.2 holds that a design letting someone believe they are covered when they are not is worse than no design.

**Measured.** On `realistic-sink.ts`, the one-pass analysis classifies **6 findings as out of scope. Two of them are genuine leaks** — `debugDump(pan)` and `dumpEmail(address)`, a PAN and an email address interpolated into raw `console.log`. Under the broad model these were findings. Under the narrowed model they are silently reclassified as *not adorn's problem* and never appear in any output.

The structural point:

- The original design's silence was **uniform**. It was silent about everything, which is bad but at least not misleading about its own shape.
- The narrowed design **actively partitions real leaks into two classes** — reported and permanently unreported — and **emits no signal for the second class**. A developer sees a clean report and cannot distinguish "no sensitive data reaches a log" from "sensitive data reaches several logs, but by a route we declined to analyse."

This is survivable, but only on a condition, and the condition is not optional:

> **A one-pass sink detector must print its own scope on every run, not merely its findings.** Something of the form: *"Analysed N adorn emission positions (`@Log` methods, `@Enforce` parameters). Observed M `@Sensitive` values flowing to non-adorn receivers; these were NOT analysed and may leak."* The out-of-scope count is already computed — it is the `out-of-scope` finding class in `spike/sinks.js` — so this costs nothing and converts a misleading silence into an honest boundary. Without it the tool fails `pii-redaction-plan.md` §11.2 and should not ship.

**Also genuinely lost, and each should be said out loud rather than discovered:**

1. **17 in-scope shapes, silently.** §14.4. Including template interpolation into an `@Log` argument. This is the largest loss and the narrowing does nothing about it.
2. **Interface-dispatched sinks.** §14.4. The ordinary DI shape defeats the analysis.
3. **The annotation covers the last hop only.** Marking `writeAuditLog(entry)` tells `@Log` to redact. It says nothing about the four intermediate frames the value already sat in. That is *correct* for an emission obligation and must not be oversold as flow coverage — the value was copied five times before adorn saw it.
4. **The runtime-retention problem is untouched.** §14.2: the fixpoint carries signal only in JSDoc mode, and a JSDoc tag is erased. If the annotation is to be read by `@Log` at runtime it must be a real decorator — which §14.3 shows is legal at a sink, so the one-pass design escapes this, but the propagating design does not.
5. **`@Time` proves "adorn-owned" ≠ "emits values".** The sink set must be maintained per-emitter and re-derived whenever an emitter is added. A future `@Telemetry.value()` (S3) enlarges it; a future decorator that renders arguments and is not added to the set becomes a silent hole. This is a maintenance obligation the design creates and does not discharge.

## 14.7 What I would build now, revised

§9.3 recommended (1) a report-only direct-sink ESLint rule and (2) a whole-program reachability report. **The narrowing changes the priority and improves item (1) substantially.**

**(1) A report-only, one-pass, adorn-sink ESLint rule — now clearly worth building.** It is no longer the thin `console.log(s.ssn)` special case §9.3 described. It answers a question adorn is uniquely positioned to answer and no logging library can: *is a `@Sensitive` value reaching a position adorn itself is about to render?* Zero false positives (§14.5), one pass (§14.3), and — because the target is provably decorator-legal — it *could* carry a fixer without the `TS1206` problem. **It still should not.** §7.2's cross-file constraint is unchanged: the fix target is the callee's parameter, usually in another module, and an ESLint fix cannot cross files. Report-only, permanently, for the reason §7.4 gives.

**(2) The reachability report is still the thing with real value**, and §14.4 is why: 17 of 22 in-scope shapes need it, and no amount of sink-awareness substitutes for it. It also now has a better output, because the sink set is closed — it can name the *emitter*, not just the log statement: *"`Customer.ssn` reaches `@Log AuditService.writeAuditLog` via `start → validate → route → accept → audit`."*

**(3) New, and cheap:** the intersection projection of `pii-redaction-plan.md` §8.1 gets sharper under the narrowed model, because "every adorn emission position" is now an *enumerable registry read* rather than an analysis. `@Log`-decorated methods and `@Enforce`-constrained parameters are already in `ContractRegistry`. A report listing every emission position and whether it carries a `@Sensitive` marking needs **no flow analysis at all** — it is a pure registry read, in the shape DEC-007 and `docs.ts` already established. It will not tell you what *reaches* those positions, and it must say so; but "here are the N places adorn will render a value, and here is which of them you have marked" is a genuine privacy-review artifact that costs almost nothing and has no false-confidence failure mode, because it makes no claim about flows.

## 14.8 Proposed amendment to DEC-023 / DEC-024

> **A proposal, in this document.** `DECISIONS.md` was **not** edited by this re-evaluation.
>
> **Numbering note — DEC-021's warning fired during this work.** While §14 was being measured, `DECISIONS.md` gained **DEC-025 — *Trust boundary: adorn secures its own emissions, not the application's*** (status ACCEPTED, user ruling), written concurrently by another hand. That entry **is** the narrowed threat model this section re-evaluates against, and it is the governing decision — §14 is the *evidence* for what follows from it, not a competing statement of it. The proposal below is therefore renumbered **DEC-026**. Anyone transferring it should re-check the highest allocated identifier first; this is the second time this repo has had two agents reach for the same number.

### DEC-026 — the sensitive-flow sink set is closed; a one-pass report-at-sink detector is admitted, propagation stays rejected
**Status:** PROPOSED · **source:** the §14 re-evaluation · **follows from:** DEC-025 (the trust boundary) · **amends:** DEC-024 (which amends DEC-023) · **relates to:** DEC-PII-1, DEC-PII-5, DEC-OBS-2, DEC-016, DEC-021

**Context.** DEC-024 rejected DEC-023's iterated single-hop propagation on three measured findings, the decisive one being that the analysis has *no notion of a sink* and therefore converges by propagating the marking onto every logger. **DEC-025 has since drawn the trust boundary**: adorn is responsible for its own emissions, not for application code's `console.log`. DEC-025's own consequences section anticipates the key point — *"the sink set becomes closed and enumerable, which is what makes any analysis tractable at all"* — and this entry supplies the measurement of exactly how much that buys, which is more than nothing and much less than the design DEC-023 proposed.

**Decision.**

1. **The sink set is closed, enumerable, and normative.** It is: a parameter of an `@Log()`-decorated method; a parameter carrying an `@Enforce.*` constraint (the violation-message path); and the proposed `@Telemetry.value()` opt-in. **`@Time()` is explicitly not a sink** — it emits a label and a duration, never an argument value. Adding an emitter to adorn is a change to this set and must be treated as one.
2. **DEC-023 point 1 remains REJECTED.** Re-measured under the narrowed model: annotations still **64% inert** (82% non-load-bearing), still stalled at hop 1 by `TS1206` on free-function intermediates, and rescuing **zero** blind spots. The narrowing does not rescue propagation.
3. **A one-pass, report-only, direct-source-to-adorn-sink detector is ADMITTED** as the successor to IDEA-10(a). One pass, no fixpoint, no `--fix`. Measured: **0% inert annotations**, annotation target **provably always decorator-legal**, ~907 ms on this repo.
4. **It must print its scope, not only its findings, on every run.** A run must state how many adorn emission positions were analysed **and how many `@Sensitive` values were observed flowing to non-adorn receivers and therefore not analysed.** This is a **condition of shipping**, not a nicety: the narrowed model partitions real leaks into reported and permanently unreported, and a clean report that does not disclose the second class is the false-confidence failure `pii-redaction-plan.md` §11.2 calls worse than no design.
5. **`@Sensitive` remains never load-bearing** (DEC-PII-1 unchanged). The detector supplements deny-by-default emission (DEC-OBS-2); it does not become the thing that makes emission safe.

**Rationale — what the re-evaluation established that DEC-024 could not.**

- **`TS1206` cannot bite at a sink, for a structural reason.** Measured across 18 syntactic positions: 7 can host an adorn emitter, and in **0** of those is `@Sensitive()` illegal. The sets are identical because `@Log`, `@Enforce`, `@Telemetry` and `@Sensitive` are all legacy decorators, which TypeScript admits only on a class declaration's concrete members. **An adorn emitter cannot be declared where `@Sensitive()` cannot be written.** DEC-024's finding 2 is therefore *scoped*, not repealed: it applies to intermediate hops, which only the rejected design needs.
- **DEC-024's finding 1 — the uninformative fixpoint — genuinely dissolves.** With a terminal sink the run reports *"`Customer.ssn` reaches `@Log AuditService.writeAuditLog(entry)`"* and distinguishes converged-with-findings from converged-clean from never-run. The annotation lands on the emitter's parameter, which is what the emitter needs to redact.
- **DEC-024's finding 3 — the blind spots — does NOT dissolve, and this is the reason propagation is not merely unnecessary but insufficient.** Only 3 of 25 cases leave scope. **17 of the 22 in-scope cases remain silent misses (77%)**, unchanged by propagation, because every one severs the chain on the **source side** and moving the sink cannot repair source-side blindness. Template interpolation into an `@Log` argument is in scope and invisible.
- **A new blind spot appears that the broad model did not have:** interface dispatch. `getResolvedSignature` resolves to the interface's `MethodSignature`, which can never carry `@Log`, so the concrete decorated implementation is never consulted. Verified. This is the ordinary dependency-injected shape.

**Consequences.**

- **IDEA-10(a) is superseded** by the one-pass adorn-sink detector, which is strictly better scoped and better motivated. **IDEA-10(b), the reachability report, is unchanged and is still the item with real value** — §14.4 quantifies exactly how much is left on the table without it (17 of 22 shapes).
- **A third, near-free artifact is admitted:** an emission-position report — every `@Log` method and `@Enforce` parameter, and whether each carries a `@Sensitive` marking. It is a **pure registry read**, needs no flow analysis, follows `docs.ts`'s extract/render shape, and has no false-confidence mode because it makes no claim about flows. It inherits DEC-007's enumeration caveat and must print its basis.
- **DEC-PII-5 still stands unweakened.** The primitive gap is still closed only by a hand-written `@Sensitive()`. What changed is that the tool can now reliably tell you *where one is missing at an emission position* — and still cannot tell you where one is missing anywhere else.
- **The sink set is a maintenance obligation.** A new value-rendering decorator that is not added to it becomes a silent hole. This should be pinned by a test that fails when a method decorator renders arguments without being declared a sink.

## 14.9 What the re-evaluation could not measure

Everything in §10 still stands. Additionally:

- **`@Telemetry.value()` (S3) does not exist.** It is in the sink set on the strength of `observability-plan.md` §5.3 and `pii-redaction-plan.md` §6.2, not measurement. If its shape changes, the set changes.
- **The out-of-scope population size is fixture-controlled.** The "2 genuine leaks silently reclassified out of scope" figure comes from a fixture I wrote to contain exactly that. The risk's *existence* is structural; its *frequency in real code* is unmeasured and is the single most decision-relevant unknown in §14.6.
- **Class-hierarchy resolution was not attempted.** §14.4 identifies interface dispatch as a miss but did not build the implementation-resolving analysis that would fix it, so its cost and precision are unknown.
- **`@Enforce`-path sinks (S2) were exercised only structurally.** `AuditTrail.checkPan(@Enforce.minLength(12) pan)` is classified correctly by `classifySink`, but no fixture drives a *flow* into a constraint-decorated parameter, so S2's detection is verified by construction rather than by a leak case.
- **The 0% inert rate is a property of one fixture and one design.** It is structurally guaranteed for annotations *at sinks*; it says nothing about how often a real codebase has a `@Sensitive` value reaching a sink directly rather than through the 17 severing shapes. **That ratio — direct versus severed, in real code — is what actually determines whether the one-pass detector is useful or merely correct**, and it is not measured here.
- **Nothing was measured against the real `@Log`.** The fixtures use inert stand-ins in `spike/fixtures/adorn-markers.ts` that mirror the real decorators' *shapes* (`MethodDecorator`, `ParameterDecorator`). Runtime behaviour is irrelevant to a static analyser, but the stand-ins are not `src/`'s decorators and a divergence in decorator *shape* would invalidate the legality result.

## 14.10 What changed my mind during the re-evaluation

**1. I expected the blind spots to improve and they did not — at all.** Going in, the plausible story was that a closed sink set would let the analysis stop caring about long chains, converting many misses into out-of-scope non-problems. It converts **three**. The reason is obvious in hindsight and I did not see it until the table printed: these shapes sever the value on the **source side**, and the sink's identity is downstream of the severing. This is the finding that keeps the overall verdict modest — the design that survives is *precise*, not *capable*.

**2. The legality result was better than I expected, and for a reason I had not anticipated.** I expected to measure "the sink positions happen to be a subset of the legal positions" and report a fortunate overlap. What the probes actually show is that the sets are **identical**, and that this follows from both being legacy decorators under the same TypeScript rule. That upgrades the finding from an empirical coincidence to a structural guarantee — which matters, because a coincidence would need re-measuring on every TypeScript upgrade and a structural guarantee does not.

**3. Interface dispatch flipped from the spike's best surprise to a real hole.** §12.3 recorded barrels-and-interfaces resolving as the one place the design was *stronger* than assumed. Under the narrowed model, resolving to the interface signature is precisely the wrong answer, because the whole question is now "what is the receiver, and is it decorated?" The same compiler behaviour, unchanged, is a positive under one threat model and a defect under the other. That is worth recording as a general caution: **a capability finding is only meaningful relative to the question being asked of it.**

**4. I set out to test whether the narrowing rescues the design and found it rescues a different one.** The honest framing is not "DEC-023 point 1 works after all under a narrower model" — it does not, and §14.5's 64% is the evidence. It is that the narrowing makes a *simpler* design viable that nobody had proposed, because under the broad model a one-pass detector would have been obviously useless (there is no enumerable sink set to point it at). The narrowing did not repair the iteration; it removed the need for it, in the one case it can serve.

---
---

# 15. THIRD PASS — two alternative approaches: runtime observation, and full interprocedural analysis

*Added 2026-07-20, after §1–§14. Same machine, same toolchain (Node v22.11.0, TypeScript 6.0.3). New spike code in `spike/observe.js`, `spike/observe-fixtures.js`, `spike/observe-run.js`, `spike/observe-collide.js`, `spike/observe-scope.js`, `spike/observe-bench.js`, `spike/observe-limits.js` and `spike/observe-optionb.js`. The existing apparatus was reused rather than rebuilt: `classifySource` and `isMarked` are imported from `core.js` unchanged, and the 22 SCOPE-IN shapes are transcribed one-for-one from `spike/fixtures/blindspots-sink.ts`.*

> **§1–§14 are not superseded and were not edited.** Both prior verdicts stand. This section evaluates two designs neither considered, and returns a **reject** on both — but for the first time in this document one of them **moves the 17**, and the reason it is still rejected is the most decision-relevant finding of the whole spike.

## 15.1 The verdicts

| | Verdict | Confidence |
|---|---|---|
| **Option A — runtime observation via the `@Sensitive` getter, value-membership in a call-scoped set** | **REJECT.** It works. It catches **15 of the 17** by exact membership and **16 of 17** with substring matching — the only mechanism in this spike that has moved that number at all. It is rejected because its **coverage is a property of execution history rather than of code**, it **cannot enumerate its own misses** (so it cannot satisfy DEC-026 point 4, a condition of shipping), and **no eligibility policy is simultaneously safe and useful**. | **HIGH** on rejection. The two decisive findings (§15.6b, §15.6c) are structural, not fixture-dependent. **MEDIUM-HIGH** on the specific false-positive percentages. |
| **Option B — full interprocedural static analysis, rebuilt on every build** | **REJECT AS POSED**, and the framing is wrong. Measured: only **10 of the 17** need interprocedural reasoning. **6 are ordinary local severings** a single-function-body pass sees, and one of those is `bs8_template` — §6.2's "most dangerous blind spot" and §14.4's headline in-scope-and-invisible case — which **falls to a six-line local propagator at zero false-positive cost**. A full taint engine is being proposed for a problem where a bounded local pass gets the highest-value half. | **HIGH** on rejecting the full engine. **MEDIUM-HIGH** on the 6-of-17 split (fixture-dependent, as §10 records). |
| **Are A and B complementary?** | **Arithmetically yes, as a design no.** Union is **16/17** against 15 for A alone and 6 for B alone — so the premise holds. But **static's entire unique contribution is one case**, and that case is cheaper and cleaner from the static side. Combining them buys one shape and inherits every one of Option A's disqualifying properties. | **HIGH** — this is a direct computation over the case set (§15.10). |

**The one-sentence version.** Option A is the first thing in this spike that actually closes the source-side gap, and it closes it by making adorn's redaction depend on what the program happened to do rather than on what the developer declared — which trades a gap you can enumerate for a gap you cannot.

## 15.2 What was built

`spike/observe.js` mirrors `src/Core/FieldDecoratorFactory.ts`'s accessor shape exactly, so the measurements transfer: a **non-enumerable prototype trampoline** (`installFieldContract`, `FieldDecoratorFactory.ts:386`) whose setter installs an **own, enumerable accessor over a closure slot** (`defineInstanceSlot`, `:558`). The only addition is a `record()` call inside the getter.

The mechanism under test is **not branding** — `pii-redaction-plan.md` §5.5 already rejected that on measured grounds. It is **value-membership in a call-scoped set**: the getter records what it returned, and the emitter checks membership before printing. A copied string is the same string, so `const copy = s.ssn` is caught. That is the positional appeal the brief identified, and it is real.

`Log()` mirrors `src/MethodDecorators/Log.ts:92` — it renders **every** argument — with a structural walk so a nested value (`emitObj({...s})`, `emitWrapped({value: s.ssn})`) is reached.

## 15.3 Question A.1 — does it catch the 17? **Yes. 15 of them, and 16 with substring.**

`node spike/observe-run.js`, over the 22 SCOPE-IN shapes:

| Mode | In-scope caught | **Of the 17 static blind spots, rescued** | Still missed |
|---|---|---|---|
| **exact value membership** | 20 / 22 | **15 / 17** | `bs8_template`, `bs11_transform` |
| **substring matching** | 21 / 22 | **16 / 17** | `bs11_transform` |
| exact, strings of length ≥ 8 | 20 / 22 | 15 / 17 | `bs8_template`, `bs11_transform` |

**This is a real result and it deserves to be stated without hedging.** Every shape §14.4 called a genuine silent miss — `const copy = s.ssn`, `const {ssn} = s`, `{...s}`, `s[key]`, `bs10_read(s)`, the callback, the index-signature bag, the laundering through an unmarked field — is caught, because all of them read the field first and the getter fires before any severing occurs.

**Two of the rescues are worth naming individually, because §14 recorded them as structural problems:**

- **`bs2_any` — the `any`-typed holder.** §6.3 called this "total. No symbol, no declaration, no marking." At runtime there are no types, so `any` is not a category. The accessor fires exactly as it does for a declared `Subject`.
- **`bs17_iface` — interface dispatch.** §14.4 introduced this as *"a new blind spot the narrowing creates"* and called it "not a corner case," being the ordinary dependency-injected shape. Runtime dispatch always arrives at the concrete method, so the `@Log`-decorated implementation is the one that runs. **The blind spot the re-evaluation discovered is dissolved entirely.**

**The two residual misses, precisely:**

- **`bs8_template`** — ``SINK.emit(`user ${s.ssn}`)``. The getter fires and records the SSN, but the emitted string is a *different* string containing it. Exact membership misses; substring catches it. §15.4c prices that.
- **`bs11_transform`** — `s.ssn.slice(-4)`. Missed by **both** modes and by every static approach, and §15.8 argues it is the most interesting case in the inventory.

## 15.4 Questions A.2, A.4, A.5 — the correlation, collision and substring problems

The property that makes the design work — a copy is the same value — is exactly the property that breaks it. An unrelated value that happens to equal a sensitive one is indistinguishable from it. `true` is `true`.

`node spike/observe-collide.js`: 500 benign emission leaves drawn from realistic pools (booleans, small integers and status codes, short enums, ids, messages, dates), against a `Customer` whose eight sensitive fields deliberately span the shapes a real record has — an 11-character SSN, a 7-character email, a 10-character date of birth, a 2-character country code, a 1-character tier, an **empty** middle name, a **boolean** consent flag and a **zero** failed-login count.

| Eligibility policy | False positives | FP rate | Sensitive fields protected | TP rate |
|---|---|---|---|---|
| exact, record everything | 119 / 500 | **23.8%** | 8 / 8 | 100% |
| exact, strings only | 57 / 500 | **11.4%** | 6 / 8 | 75% |
| exact, strings length ≥ 4 | 12 / 500 | **2.4%** | 3 / 8 | 37.5% |
| exact, strings length ≥ 8 | 12 / 500 | **2.4%** | 2 / 8 | 25% |
| exact, strings length ≥ 12 | 0 / 500 | **0.0%** | 0 / 8 | **0%** |
| **substring**, record everything | 147 / 500 | **29.4%** | 8 / 8 | 100% |
| substring, strings length ≥ 8 | 12 / 500 | 2.4% | 2 / 8 | 25% |

> **There is no knee in this curve.** The trade is monotone from end to end. Protect everything and one emission in four is corrupted; get the false-positive rate to zero and the mechanism protects nothing at all.

**The individual collisions, counted:**

| Sensitive value | Benign leaves it collides with |
|---|---|
| `true` | 48 / 500 (**9.6%**) |
| `""` (empty middle name) | 23 / 500 (4.6%) |
| `0` (failed logins) | 14 / 500 (2.8%) |
| `"US"` (country code) | 13 / 500 (2.6%) |
| `"1981-04-02"` (date of birth) | 12 / 500 (2.4%) |
| `"A"` (tier) | 9 / 500 (1.8%) |
| `"123-45-6789"` (SSN) | 0 / 500 |
| `"a@b.com"` (email) | 0 / 500 |

**Is the collision containable, as the brief asks? No, and the reason is sharper than "short values collide."**

A length guard removes the boolean, the zero, the empty string and the short enums — and with them 6 of the 8 fields' protection. What it does **not** remove is the residual, and `spike/observe-bench.js` attributes it exactly:

> At `minLength ≥ 8`, **100% of the remaining false positives are the date of birth** colliding with ordinary benign dates — 34 of 500 in the benchmark corpus, 12 of 500 in the collision corpus.

**A date of birth is a sensitive value shaped exactly like a timestamp.** No length threshold can separate `1981-04-02` from `2024-01-15`, because there is nothing to separate — they are the same shape, the same length, the same character class. The one guard that suppresses collisions is structurally incapable of suppressing the collision that matters most in a PII context. Containment fails not at the margin but on one of the canonical PII field types.

### 15.4b The correlation problem, measured — and it is not what I expected

A value being *read* is not a value being *logged*, and reads vastly outnumber emissions. I expected the observed set to accumulate through a request until it matched half the world. **It does not, and the reason is worth recording because it cuts in the design's favour.**

`spike/observe-bench.js`, false-positive rate against the number of records read in one scope:

| Records read | Set size | FP (record everything) | FP (strings ≥ 8) |
|---|---|---|---|
| 1 | 7 | 34.0% | 6.8% |
| 10 | 16 | 34.0% | 6.8% |
| 100 | 106 | 34.0% | 6.8% |
| 1,000 | 1,006 | 34.0% | 6.8% |

**Flat.** Long values are unique per subject, so adding a thousand more SSNs to the set adds a thousand values nothing will ever collide with. The false-positive rate is driven by the **shape** of the sensitive fields, not by the **size** of the observed set. Scope-membership is therefore a better approximation than I predicted: it does not degrade with scope length.

That is a genuine positive and it is why the verdict does not rest here. The 23.8% is bad; it is bad *at one record*, and it is bad because of what a `boolean` is, not because of anything the scope accumulated.

### 15.4c Substring matching — is there a defensible middle?

**No.** Substring buys exactly one case (`bs8_template`) and prices it three ways:

1. **False positives rise**, 23.8% → **29.4%**.
2. **Cost becomes O(n·m).** Per emission of a realistic 12-leaf payload: **757 ns** at 1 observed value, **1,049 ns** at 10, **4,427 ns** at 100, **38,970 ns** at 1,000 — **63×** the exact-match path, and it scales with set size where exact matching does not.
3. **An empty observed string matches every string.** The prototype has to special-case it, and a sensitive field that is legitimately empty is common (an absent middle name, an unset optional).

And the case it buys is available for free from the other direction: §15.9 shows a **six-line static propagator** catches `bs8_template` with **zero** false positives and no per-emission cost. Substring matching is the expensive way to buy something already on the shelf.

## 15.5 Question A.3 — scope propagation, and the finding that decides Option A's fate

`node spike/observe-scope.js`. **`AsyncLocalStorage` is excellent at the thing it is for and irrelevant to the thing that matters.**

| Case | Scope survived? |
|---|---|
| synchronous read and emit | **YES** |
| `await` across a `setTimeout` | **YES** |
| `Promise.all`, emit in a concurrent branch | **YES** |
| `setTimeout` callback, after the scope function returned | **YES** |
| `process.nextTick` | **YES** |
| `EventEmitter`, listener registered outside, `emit()` called inside | **YES** |
| `EventEmitter`, value read in scope and emitted after it closed | **NO** |
| request A reads and caches, request B emits | **NO** |
| request B emits request A's secret (ALS correctly isolates them) | **NO** |
| **nothing opened a scope at all** | **NO** |
| field read at startup, emitted inside a scope | **NO** |

> **6 of 11.** Every async-control-flow hop survives. Every *architectural* boundary loses it.

**The decisive row is "nothing opened a scope at all," and it is not an edge case — it is the default.** adorn is a decorator library. It does not own the request lifecycle, cannot assume a consumer installed middleware, and has no hook that runs before application code. Absent a scope the emitter **fails open, silently**: full rendering, no redaction, no diagnostic.

The only scope adorn can open for itself is one per **decorated method call**. `spike/observe-scope.js` §A.3b measures what that covers:

| | Redacted? |
|---|---|
| field read **inside** an adorn-decorated frame | **YES** |
| field read in the **caller**, then passed to a decorated method | **NO** |
| free function, no adorn frame anywhere | **NO** |

**So the real coverage boundary is "reads that occur inside an adorn-decorated call frame."** The read-in-the-caller shape is not exotic; it is the ordinary one — a handler reads the field, then calls the logging or audit service. The design covers the case where the developer's own code is already inside adorn, which is a much smaller set than "reads of sensitive fields."

## 15.6 Question A.7 and the false-confidence surface — **the two findings the verdict rests on**

### 15.6a It observes reads of decorated fields, not sensitive data

`node spike/observe-limits.js`, seven probes:

| Probe | Result |
|---|---|
| decorated field, read normally — **the control** | REDACTED |
| plain object from `JSON.parse` (a wire payload) | **LEAKED** |
| null-prototype row from a DB driver | **LEAKED** |
| value read before any scope existed, emitted inside one | **LEAKED** |
| `Object.defineProperty` shadowing the instance accessor | **LEAKED** |
| **undecorated sibling field on a decorated class** | **LEAKED** |
| the same secret typed as a literal at the call site | **LEAKED** |

> **6 of 7 leaked.** The covered case is exactly one: a read of a **decorated** field, **through the accessor**, inside an **open scope**.

The brief anticipated this and it is confirmed: the mechanism sees *reads of decorated fields*, which is strictly narrower than *sensitive data*. Note this is not unique to Option A — the ratified object-walk path (`pii-redaction-plan.md` §5.1) also cannot see a `JSON.parse`'d plain object, because there is no prototype to resolve markings from. **Partial marking is likewise not new.** Marking one field of three gives partial redaction under the existing design too. Fairness requires saying so.

### 15.6b What IS new, and it is worse than partial coverage

**Coverage becomes a property of execution history rather than of code.** `spike/observe-limits.js` §A.10 demonstrates it with an utterly ordinary memoised read:

```
request 1 (cache miss)    REDACTED  [REDACTED]
request 2 (cache hit)     LEAKED    123-45-6789
request 3 (cache hit)     LEAKED    123-45-6789
```

One `SINK.emit(ssn)`. **The same line of code**, redacted on the first request and in the clear on every subsequent one. No declaration changed. No code changed. Nothing was reported. **A test written against request 1 passes and proves nothing about request 2.**

This is precisely the failure `pii-redaction-plan.md` §3.1 identifies as *"the single most instructive result in the survey"* and instructs adorn to treat *"as a warning rather than a template"* — class-transformer [#146](https://github.com/typestack/class-transformer/issues/146), *"leaked on one route and not another."* Option A reproduces that failure by construction, and in one respect **more severely**: class-transformer fails deterministically per route, so a route-level test catches it. Option A's outcome depends on cache state, on which branch ran, on whether an earlier request warmed something. It is not reliably testable.

### 15.6c It cannot enumerate its own misses — so it cannot satisfy DEC-026 point 4

**DEC-026 point 4 made scope disclosure a condition of shipping**, in terms this spike wrote for itself:

> *"A run must state how many adorn emission positions were analysed **and how many `@Sensitive` values were observed flowing to non-adorn receivers and therefore not analysed.** This is a **condition of shipping**, not a nicety."*

A static pass satisfies this from a pure registry read: it can print *"N fields are `@Sensitive`; M fields on contracted classes are not"* with no flow analysis at all. **Option A definitionally cannot.** To report *"a sensitive value reached an emitter without being observed"* it would have to already know the value was sensitive — and observing the read is the only way it ever learns that. The mechanism's knowledge is created by the very event whose absence it would need to report.

Measured: emitting an unmarked sensitive field prints `hypertension` with no warning, no counter, and no difference of any kind from emitting a non-sensitive value.

### 15.6d And the emission actively signals safety

`spike/observe-limits.js` §A.8 — a `Patient` with three sensitive fields, one marked:

```
emitted: {mrn:[REDACTED],diagnosis:hypertension,insuranceId:INS-4410-22}
```

**The record is one-third protected and the output contains a `[REDACTED]` token.** A visible censor mark is the strongest possible signal to a reader that redaction is working. This is a materially worse false-confidence shape than anything measured in §1–§14: §4.3's failure was *silence*, which is at least ambiguous, and §14.6's was a *quiet reclassification*. This one **affirmatively displays evidence of protection** on a payload that is mostly in the clear.

Against `pii-redaction-plan.md` §11.2 — *"a design that lets a developer believe they are covered when they are not is worse than no design at all"* — this is the strongest instance the spike has produced.

## 15.7 Question A.6 — cost

`node spike/observe-bench.js`.

**Per field read:**

| | ns | vs. plain |
|---|---|---|
| plain data property read | 1.6 | 1.0× |
| adorn accessor, no scope open | 4.6 | 2.8× |
| adorn accessor, scope open, value already recorded | 22.1 | **13.5×** |
| adorn accessor, scope open, a new value every read | 293.6 | 180× |
| *(control)* accessor **write** only, no scope | 6.7 | 4.1× |

The 2.8× line is adorn's accessor today and is not attributable to this design. **The design's own cost is the jump to 22.1 ns — a `Set.has` plus an eligibility check on every read of every decorated field.** The 293.6 ns figure is the pathological unbounded case, where the `Set` grows to 500,000 entries and rehashing dominates; it is an upper bound on a scope that never closes, not a per-read cost.

**Per emission** (one realistic 12-leaf payload):

| Observed-set size | no store | exact | substring |
|---|---|---|---|
| 0 | 637 ns | 698 ns | 791 ns |
| 1 | — | 658 ns | 757 ns |
| 10 | — | 588 ns | 1,049 ns |
| 100 | — | 597 ns | 4,427 ns |
| 1,000 | — | 618 ns | **38,970 ns** |

**Exact membership is free at the emitter** — within noise of rendering the payload at all, and flat in set size. **Substring is 63× at 1,000 observed values and grows without bound.** Cost is not what rejects Option A; exact matching is cheap enough to ship.

**One cost that is not CPU time, and it is a genuine objection rather than a curiosity.** The observed set is a **plaintext index of sensitive values**, retained for the scope's lifetime:

| Records read | Values retained | Plaintext held |
|---|---|---|
| 1 | 7 | ~0.1 KiB |
| 100 | 106 | ~3.8 KiB |
| 10,000 | 10,006 | ~408 KiB |

A control that works by **building an in-memory register of every secret the process touched** has created a new exposure — reachable from a heap dump, a core file, or any debugger — in order to reduce an old one. Against GDPR Art. 25 (data protection by design) and Art. 32 (security of processing), and `pii-redaction-plan.md` §3.3's approving note that `secrecy` **zeroizes on drop**, that is the wrong direction. It is not disqualifying on its own; it belongs on the ledger.

## 15.8 `bs11_transform` — the case neither option catches, and why it matters most

`s.ssn.slice(-4)`. Missed by exact membership, missed by substring, missed by the local static pass, and missed by every propagating design in §1–§14.

**And an off-the-shelf static engine would not merely miss it — it would declare it clean.** `pii-redaction-plan.md` §3.4 records that CodeQL's Java query treats `substring`/`take`/`takeLast` of **≤ 7 characters** as **sanitizing**, and that `notSensitiveRegexp()` ends a taint flow at any callee whose *name* looks like hashing. Against PCI-DSS 3.5.1.1 — *"keyed cryptographic hashes of the entire PAN"* — and 3.5.1.c's requirement that truncated and hashed forms *"cannot be correlated to reconstruct the original PAN"*, and against GDPR Recital 26, that is a contested privacy conclusion baked into the analyser.

So `bs11` is the case where **building your own means adopting a sanitizer policy, and a sanitizer policy is a regulatory judgement.** Deciding whether `.slice(-4)` sanitizes an SSN is not a decorator library's decision to make, and shipping a tool that silently encodes an answer is worse than shipping no tool. This single case is the strongest argument in §15.9 that Option B is a security-tool project wearing a library's clothes.

## 15.9 Option B — assessed comparatively, and the framing is wrong

The brief asks for a comparative assessment, not a taint engine, and one bounded probe was worth running because it changes the question. `spike/observe-optionb.js` is a deliberately minimal **intraprocedural** pass — local `const` aliases, destructuring, template-literal propagation, literal-keyed element access — within a single function body. **No summaries, no fixpoint, no heap model, no cross-function reasoning of any kind.**

| Of the 17 source-side blind spots | Count |
|---|---|
| **Caught by a purely LOCAL pass** | **6** — `bs1_localVar`, `bs3_dynamic`, `bs6_destructure`, `bs6_paramDestructure`, **`bs8_template`**, `bs19_optional` |
| A **sink-resolution** problem, needing class-hierarchy analysis (not source severing) | 1 — `bs17_iface` |
| Needing genuine interprocedural reasoning, or unsolvable | 10 |

> **`bs8_template` falls to a six-line local propagator.** §6.2 called it *"the most dangerous blind spot,"* winning "on all three axes that matter." §14.4 singled it out as the shape that is *in scope and invisible*. It is neither interprocedural nor hard — it is a template literal with a marked expression in one of its spans, and Semgrep has a name for the rule that catches it (a *propagator*).

**This reframes Option B entirely.** "Full interprocedural analysis, rebuilt on every build" is being proposed to close a gap of which **a third is local**, including its single most-cited member. The expensive answer is being priced against a problem the cheap answer partly solves.

**On cost and "rebuild on build."** One pass on this 15k-LOC repo is ~907 ms (§14.3), and the local extension adds no rounds and no fixpoint — it is the same single walk. A *full* engine is a different proposition: program construction is superlinear in cross-file type resolution (§8.2), nothing amortises because each build sees changed sources, and DEC-013 caps TypeScript at 6.x, so a taint engine is a permanent maintenance commitment against a moving compiler API. Meta shipped annotation-carried taint kinds in Pysa and **backed them out** (`pii-redaction-plan.md` §3.4); the ECOOP 2025 survey attributes non-adoption of type-based taint checking to *"false positives and annotating existing codebases."*

**On the CodeQL precedent, answering the brief's question directly.** That the best-resourced analyser in the industry *guesses at variable names* cuts **both ways**, and both must be said:

- **For adorn.** CodeQL guesses because *nothing in the source language declares sensitivity*. adorn has the declaration. It is not rolling its own version of CodeQL's hardest problem — that problem is solved by `@Sensitive`, and Mariana Trench's `has_annotation` constraint is direct production evidence the approach works.
- **Against adorn.** The *sanitizer* problem is unavoidable and adorn would inherit it whole (§15.8). CodeQL's answer to it contradicts GDPR Recital 26 and PCI 3.5.1.1 — and CodeQL has a security research team. A decorator library taking on the same obligation, with a fraction of the resources and no security-research function, would produce a worse answer and ship it inside a library people trust for *contracts*. It would also inherit CodeQL's own defensive posture: `isBarrierIn` exists purely to contain the blast radius of imprecise sources.

**Verdict on B: reject the full engine; admit the local pass.** A bounded intraprocedural extension to the already-admitted DEC-026 one-pass detector is cheap, deterministic, zero-false-positive on the measured set, needs no new vocabulary, writes nothing to source, and takes the blind-spot count from 5-of-22-seen to 11-of-22-seen in one pass. It stays inside what a library can honestly maintain. Everything past that boundary is a different project.

## 15.10 The question that matters most — are A and B complementary?

**The user's read was that they are complementary: static sees all paths but is blind to source-side severing; runtime sees severed values but only on executed paths. The premise is exactly right. The conclusion does not follow, and the computation shows why.**

`spike/observe-optionb.js` §B.2, over the 17:

| | Count | Cases |
|---|---|---|
| Caught by **both** | 5 | `bs1_localVar`, `bs3_dynamic`, `bs6_destructure`, `bs6_paramDestructure`, `bs19_optional` |
| **Runtime only** (A) | **10** | `bs2_any`, `bs5_callback`, `bs5_install`, `bs7_objectSpread`, `bs7_argSpread`, `bs10_caller`, `bs12_wrapped`, `bs14_fieldWrite`, `bs17_iface`, `bs18_indexSig` |
| **Static only** (B, local pass) | **1** | `bs8_template` |
| Caught by **neither** | 1 | `bs11_transform` |
| **Union** | **16 / 17** | |

**So the complementarity is real and it is almost entirely one-directional.** The union (16) beats either alone (15 runtime, 6 static), which vindicates the premise. But:

1. **Static's entire unique contribution is one case.** Runtime already covers the other five it finds.
2. **That one case is cheaper from the static side.** `bs8_template` costs six lines and zero false positives statically, versus a 29.4% false-positive rate and 63× emission cost to get it through substring matching. **Same case, two prices** — and the static price is better.
3. **So there is no combination worth building.** Take the static local pass and you have 6 of 17 at zero false-positive cost, deterministic, CI-checkable, and able to print its own scope. Add runtime observation and you gain 10 more shapes and inherit every disqualifying property of §15.5 and §15.6.

**And the deeper reason they should not be combined: they are complementary in coverage and incompatible in kind.** Static coverage is a property of *code* — enumerable, checkable in CI, identical on every run, and reportable in the shape DEC-026 point 4 requires. Runtime coverage is a property of an *execution*. Union them and the resulting artifact's coverage is a checkable set unioned with an uncheckable one, with **no way for a developer to tell which half caught anything, or which half missed**. A combined design does not inherit the stronger guarantee; it inherits the weaker one, and hides the fact that it has done so.

**The brief's hypothesis therefore holds arithmetically and fails as a design**, and the arithmetic is what shows the failure — because it reveals the complementarity is worth exactly one case.

## 15.11 Does Option A create a new false-confidence surface? **Yes — a new *kind*, not merely more of the existing one.**

The brief asks this precisely, and the honest answer has three parts.

**1. The partial-marking case the brief describes is NOT new.** A developer marking one field of three gets partial coverage under the ratified object-walk design too (`pii-redaction-plan.md` §5.1). Option A should not be charged for that.

**2. But under the existing design, coverage is a *declarative* property — and that is the whole difference.** What is marked is enumerable from `ContractRegistry`. §14.7(3)'s emission-position report can print *"here are the N places adorn will render a value, and here is which of them you have marked"* from a **pure registry read, with no flow analysis**. A developer can be told the shape of their own coverage.

**3. Under Option A, coverage is an *execution* property, and the design cannot report it.** §15.6b: the same line redacts on a cache miss and leaks on a cache hit. §15.6c: the mechanism is definitionally unable to enumerate its own misses, so it **cannot satisfy DEC-026 point 4** — which this spike itself made a condition of shipping. §15.6d: the emission **displays a `[REDACTED]` token** on a record that is two-thirds in the clear, actively signalling protection that is not there.

> **That is a new false-confidence surface, and it is the worst one this spike has measured.** §4.3's was silence. §14.6's was a quiet reclassification with a fix available (print your scope). This one is an **affirmative safety signal that cannot be qualified**, on a mechanism that **cannot describe its own boundary**, with an outcome that **varies between two runs of identical code**. There is no disclosure that repairs it, because the design does not know what to disclose.

## 15.12 Recommendation

**Build neither Option A nor Option B as posed. Build the local pass, and keep the primitive gap honestly open.**

1. **Reject Option A.** Do not ship runtime observation, in any eligibility policy. Record the 15-of-17 result prominently — it is the only mechanism that has moved that number, and a future reader who rediscovers the idea deserves to know it works and why it was still refused.
2. **Reject Option B as posed.** No taint engine, no interprocedural analysis, no sanitizer policy.
3. **Extend DEC-026's admitted one-pass detector with the bounded local pass** — local `const` aliases, parameter and body destructuring, template-literal propagation, literal-keyed element access. Measured: **6 of 17** additional shapes, zero false positives, no additional rounds, ~907 ms. This takes the detector from 5-of-22 to 11-of-22 in-scope shapes seen. Its scope-disclosure obligation (DEC-026 point 4) is unchanged and still binding.
4. **Ship §14.7(3)'s emission-position report.** A pure registry read, no flow analysis, no false-confidence mode. Against §15.11 it is the *only* artifact here that can honestly describe its own coverage, which makes it the most valuable thing in the whole area.
5. **DEC-PII-5 stands unweakened, for the third time.** The primitive gap is closed only by a hand-written `@Sensitive()`. Three independent designs have now failed to close it automatically, by three different mechanisms, and the failures are not the same failure — which is the strongest available evidence that the gap is real rather than an artifact of one approach.

**What would change this verdict.** Option A becomes reconsiderable if — and only if — it can (a) enumerate its own misses, and (b) make coverage deterministic across executions. I do not believe (a) is achievable: it requires knowing a value is sensitive without having observed it, which is the mechanism's definition of knowing. **If someone finds a way to do (a), reopen this.** That is the load-bearing claim, and it is the one to attack.

## 15.13 Proposed decision entry

> **A proposal, in this document.** `DECISIONS.md` was **not** edited.
>
> **Numbering.** DEC-026 is itself still `PROPOSED` (§14.8) and is not yet in `DECISIONS.md`; the highest ACCEPTED identifier is **DEC-025**. This entry is therefore proposed as **DEC-027**, assuming DEC-026 lands first. **Re-check the highest allocated identifier before transferring** — DEC-021's numbering hazard has now fired twice in this document's history.

### DEC-027 — runtime observation is rejected; static analysis is capped at an intraprocedural pass
**Status:** PROPOSED · **source:** the §15 third pass · **extends:** DEC-026 (proposed) · **relates to:** DEC-PII-1, DEC-PII-5, DEC-023, DEC-024, DEC-025, DEC-016, DEC-021

**Context.** DEC-024 and DEC-026 both rejected iterated single-hop propagation, the second under DEC-025's narrowed threat model. Both left the same residue: **17 of 22 in-scope leak shapes remain silent misses, and every one severs the value on the source side**, where static analysis is structurally blind. Two alternatives address that residue from opposite directions — runtime observation through the `@Sensitive` accessor, which fires at the source before severing; and full interprocedural static analysis, which the single-hop design existed to avoid.

**Decision.**

1. **Runtime observation is REJECTED.** adorn's emitters must not consult a scope-held set of observed field values. This holds for every eligibility policy and both matching modes.
2. **Full interprocedural static analysis is REJECTED.** No taint engine, no cross-function summaries, and — decisively — **no sanitizer policy**. Whether `.slice(-4)` sanitizes an SSN is a regulatory judgement, not a library's.
3. **DEC-026's one-pass detector MAY be extended intraprocedurally**: local `const` aliases, body and parameter destructuring, template-literal propagation, and literal-keyed element access, within a single function body. No fixpoint, no rounds, no interprocedural reasoning. Measured at 6 of 17 additional shapes, zero false positives, no additional cost over the existing single pass.
4. **DEC-026 point 4 (print your scope) is reaffirmed and generalised**: any flow artifact adorn ships must be able to describe its own coverage boundary. **A design that cannot enumerate its own misses is disqualified on that ground alone**, independent of its catch rate.
5. **DEC-PII-5 stands unweakened.** The primitive gap is closed only by an explicit hand-written `@Sensitive()`.

**Rationale — and the order matters, because the first finding is the one that decides it.**

- **Runtime observation works, and that is not enough.** Measured: **15 of the 17** source-side blind spots caught by exact value membership, **16 of 17** with substring matching — the first mechanism in three passes to move that number. It dissolves `bs2_any` (runtime has no types) and `bs17_iface` (runtime dispatch reaches the concrete method), the latter being the new blind spot DEC-026 discovered. **The design is rejected despite this, not for want of it.**
- **Coverage becomes a property of execution history rather than of code.** Measured with a memoised read: one `SINK.emit(ssn)` line redacted on a cache miss and printed in the clear on every subsequent request, with no code change and no report. This is class-transformer #146's failure shape — which `pii-redaction-plan.md` §3.1 designates *"a warning rather than a template"* — and is **worse**, because class-transformer fails deterministically per route and is therefore testable.
- **It cannot enumerate its own misses, so it cannot satisfy DEC-026 point 4.** Reporting *"a sensitive value reached an emitter unobserved"* requires knowing the value is sensitive without having observed the read — which is the only way it ever knows. A static pass discharges the same obligation from a pure registry read.
- **It emits an affirmative safety signal on unprotected data.** With one of three sensitive fields marked, the emission reads `{mrn:[REDACTED],diagnosis:hypertension,insuranceId:INS-4410-22}`. A visible censor token is the strongest possible signal that redaction is working. Against `pii-redaction-plan.md` §11.2 this is the most severe false-confidence shape the spike has measured — worse than §4.3's silence, because silence is at least ambiguous.
- **No eligibility policy is both safe and useful.** Record everything: **23.8%** false positives at 100% protection. Strings of length ≥ 8: **2.4%** false positives at **25%** protection. Length ≥ 12: 0% and **0%**. The trade is monotone with no knee. And at length ≥ 8, **100% of residual false positives are a date of birth colliding with ordinary dates** — a collision no length guard can ever remove, because a DOB is shaped exactly like a timestamp.
- **adorn cannot open the scope.** `AsyncLocalStorage` survives every async hop measured (6 of 6) and fails at every architectural boundary (5 of 5), the decisive one being that **nothing opens a scope by default** and the emitter then fails open, silently. The only scope adorn can open is per-decorated-call, covering reads *inside* a decorated frame but not reads in the caller — and the caller is the ordinary shape.
- **The full static engine is aimed at the wrong target.** Measured: only **10 of 17** shapes need interprocedural reasoning. **6 are local**, including `bs8_template` — §6.2's *"most dangerous blind spot"* — which falls to a six-line propagator. The expensive design is priced against a problem a bounded pass partly solves.
- **The CodeQL precedent cuts both ways and both were weighed.** adorn has the declaration CodeQL lacks, so the *source* problem is genuinely solved (Mariana Trench's `has_annotation` is production evidence). But the *sanitizer* problem is unavoidable, and CodeQL — with a security research team — answers it in a way that contradicts GDPR Recital 26 and PCI 3.5.1.1. A decorator library would answer it worse and ship it inside something trusted for contracts.
- **The two options are complementary in coverage and incompatible in kind.** Union 16/17 against 15 and 6 alone, so the hypothesis holds arithmetically — but **static's unique contribution is exactly one case**, and that case is cheaper statically (zero false positives, six lines) than through runtime substring matching (29.4% false positives, 63× emission cost). Combining a checkable coverage set with an uncheckable one yields an artifact inheriting the weaker guarantee while obscuring that it has.

**Consequences.**

- **The 15-of-17 result must be recorded prominently, not buried in a rejection.** It is the only mechanism that has moved that number, and the next person to propose it deserves to learn that it works before learning why it was refused.
- **A new general rule, and it is the transferable part:** *a privacy mechanism whose coverage varies between two executions of identical code is disqualified regardless of its catch rate.* This is DEC-016's asymmetry-of-failure argument applied to emission, and it generalises past `@Sensitive`.
- **The observed set would itself be a PII repository** — ~408 KiB of plaintext sensitive values at 10,000 records, reachable from a heap dump, held for the scope lifetime. A control that builds an index of every secret the process touched has created an exposure to reduce one. Recorded because it is the kind of second-order cost a later proposal will otherwise miss.
- **`bs11_transform` (`.slice(-4)`) is caught by nothing** — not runtime, not substring, not static, at any budget — and an off-the-shelf engine would declare it **clean**. It is the permanent floor on any automated approach here and should be documented as such rather than rediscovered.
- **`@Time()` remains not a sink** (DEC-026 point 1, unchanged). The sink set's maintenance obligation is unchanged.
- **Q-18 is untouched and remains the decision-relevant unknown.** What fraction of real leaks reach an emitter *directly* rather than through a severing shape still determines whether the detector is useful or merely correct. Nothing in §15 answers it.

## 15.14 What the third pass could not measure

Everything in §10 and §14.9 still stands. Additionally:

- **The false-positive corpus is mine.** 500 benign leaves drawn from pools I chose with weights I chose. The *shape* of the result is robust — a boolean collides with every boolean, and a DOB is shaped like a timestamp regardless of corpus — but **23.8% and 2.4% are properties of my weighting, not population estimates.** A corpus with fewer booleans moves the first number a lot.
- **The runtime fixtures are transcriptions, not the TypeScript fixtures themselves.** `spike/observe-fixtures.js` reproduces the 22 SCOPE-IN shapes in plain JavaScript so they can be *executed*. Types erase, so every runtime-relevant construct is identical — but they are a transcription, and a transcription error would be invisible to the harness.
- **Nothing was measured against the real `@Log` or the real `@Sensitive`.** As in §14.9, the emitter and the field decorator are stand-ins. The accessor shape is mirrored from `FieldDecoratorFactory.ts` deliberately and closely, but it is a mirror.
- **The 6-of-17 local-pass figure is from a probe, not an implementation.** It handles the constructs the fixtures contain. Real code contains `let` reassignment, closures over mutable bindings, and conditional assignment, none of which the probe models — so **6 is an optimistic bound for that design**, and the honest reading is "at least a third of the 17 are local," not "exactly six."
- **`bs17_iface` is counted as a runtime catch on the strength of dynamic dispatch**, which is sound, but no fixture exercises a *proxy* or a runtime-composed delegate, where the concrete method may not be the decorated one.
- **`AsyncLocalStorage` was measured on Node v22.11.0 only.** Its propagation semantics have changed across major versions, and no other runtime (Bun, Deno, workerd) was tested. A design depending on it would need that matrix; this one does not, because it is rejected.
- **No measurement of how often a developer marks a subset of a record's sensitive fields.** §15.11's partial-marking argument is structural, and the one-of-three fixture is illustrative rather than representative.
