# adorn — Build-Time `@Sensitive` Flow Analysis: Feasibility Spike

*A spike, not a feature. Produced 2026-07-20. Proof-of-concept code in `spike/`, excluded from the build, the linter and Prettier.*

> **Status: spike report. This discharges DEC-023 point 4** — *"A feasibility spike precedes any implementation."* DEC-023 is `ACCEPTED (governs the spike) · feasibility **unproven** — see sensitive-flow-spike.md`, so this document is the evidence it gates on, and it returns a **negative** result on point 1. Nothing here is implemented in `src/`, and the code in `spike/` is throwaway. §11 contains a proposed **amendment to DEC-023** written in `DECISIONS.md` style; it is a **proposal in this document** and `DECISIONS.md` was not edited.
>
> **DEC-023 named both hazards correctly before I started, which is worth recording.** It flags *"a tool that cannot see a flow and does not say so"* and *"silent because converged and silent because never re-run look identical"*. I measured both. They are not risks to be designed against — they are what the design does (§6, §4.3, §8.4).
>
> **How to read the claims.** Every number in this document was produced by running code in this repo on this machine (Node v22.11.0, TypeScript 6.0.3, ESLint 9.39.5, typescript-eslint 8.64.0). Where I could not measure something I say so, in §10. §1 is the verdict; §2–§8 are the measurements; §9–§11 are the recommendation.
>
> **This builds on `docs/pii-redaction-plan.md` §5.4, §5.5, §9 and §13 (DEC-PII-1, DEC-PII-5) and does not restate them.** That document establishes the primitive-parameter gap and the never-load-bearing principle. This one answers the question it left open: *can the gap be closed at build time instead?*

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
