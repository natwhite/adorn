# Plan — `@Requires` cross-parameter preconditions in the `@adorn/test` fuzzer

**Status:** PLAN (design only) · advances DEC-057's deferred fuzzer integration · advances IDEA-6
**Scope:** `addons/test/` only. No production code, no root surface change, fast-check stays a devDep.

---

## 1. Problem statement

`@Requires((...args) => boolean, description?)` (DEC-057) records a **closure** cross-parameter
precondition into the `preconditionsByTarget` band. Enforcement runs it **before** `proceed()` and, under
the default policy, throws when the arguments do not satisfy it (`checkPreconditions`,
`ContractInstaller.ts:583-611` → `new Error(preconditionMessage(...))`, `Preconditions.ts:61-64`).

The fuzzer (`oracle.ts`) generates arguments from **per-position** parameter constraints, runs the real
`@Contract()`-installed method, and checks postconditions. It is **not** `@Requires`-aware. So it will
generate a tuple that satisfies each parameter individually but violates a cross-parameter `@Requires`
— e.g. `start=9, end=2` for `@Requires((s,e)=>s<e)`. The method's **still-live precondition guard** (only
the *assert/postcondition* trust gate is suppressed during a run, `oracle.ts:33-36`, `oracle.ts:686-695`)
throws `"Precondition failed: …"`. `classifyThrow` (`oracle.ts:631-636`) runs that through
`isAdornViolation` (`oracle.ts:846-852`), which only recognises the `"Value Error:"` prefix — so the
throw is misclassified as an **`unexpected-throw`**: a spurious "the method crashed" finding. **A false
positive.** This is the exact hole DEC-057 flagged as deferred:

> "the add-on's generator does not yet respect `@Requires`, so fuzzing a `@Requires` method can still
> surface precondition failures as false positives until it does." — DEC-057, surface note (`DECISIONS.md:980`)

**Goal:** the fuzzer must test the method **only** on argument tuples that satisfy the *effective*
preconditions — filtering generated tuples through the exact function enforcement runs, so a
precondition-satisfying tuple can never trip the installed `@Requires`.

---

## 2. The hook point — a whole-args gate over the composed tuple

A precondition relates **multiple parameters**, so the filter **cannot** live in a per-parameter
arbitrary (each of those sees one value). It must wrap the **composed argument tuple**. That tuple is
built by `buildArgsArbitrary(coverage, gapFill)` (`oracle.ts:777-785`), whose single call site is
`prepareRun` at `oracle.ts:394`. **That is the insertion point.**

`prepareRun` already reads the other effective bands here — `entry.contract.post` and
`getEffectivePostconditions` at `oracle.ts:386-387`. We add the third band read alongside them and gate
the tuple:

### Before (`oracle.ts:394`)

```ts
const argsArbitrary = buildArgsArbitrary(coverage, gapFill);
```

### After

```ts
const baseArgs = buildArgsArbitrary(coverage, gapFill);

// Cross-parameter preconditions, read effectively (inheritance-unioned) — the SAME read the installer
// plans from (ContractInstaller.ts:322) and the SAME the enforced wrapper checks. Consumed from adorn's
// PUBLIC root, exactly as this module already consumes getEffectivePostconditions/evaluatePostconditions
// (oracle.ts:70), so the add-on stays a plain downstream consumer (DEC-044).
const pres = getEffectivePreconditions(entry.target, method);

const gate = preconditionGate(baseArgs, pres);      // new helper, described in §3
if (gate.declined) {
    return {
        declined: declinedResult(
            className, methodName, isStatic, coverage,
            gate.reason!, oraclesChecked, mode,       // note: mode/oraclesChecked already computed above
        ),
    };
}
const argsArbitrary = gate.arbitrary;
const preconditionWarnings = gate.warnings;          // threaded onto PreparedRun; see §3
```

### Resulting control flow (per generated case)

```
draw candidate tuple  →  [.filter: evaluatePreconditions(pres, args).ok]  →  reach oracleOutcomeSync
        ↑                          │ !ok                                          (run method + postconds)
        └──────── discard & redraw ┘
```

`oracleOutcomeSync`/`oracleOutcomeAsync` (`oracle.ts:497`, `:520`) and every downstream check are
**untouched**: because the filter sits on the arbitrary, an invalid tuple never reaches the method
`invoke` (`oracle.ts:816-818`). The false-positive hole closes at the source.

Both entry points inherit the fix for free: `fuzzMethod` and `fuzzMethodAsync` both build `p.argsArbitrary`
via the one `prepareRun`, and both consume it (`oracle.ts:197`, `:253`). Preconditions are synchronous
`(...args)=>boolean` closures, so the filter is synchronous and composes with `fc.asyncProperty` unchanged.

---

## 3. Generate-and-filter is the only sound option — and it reuses the add-on's existing discipline

**Why filter, not invert.** A `@Requires` closure is a black box: no identity, no serialisable params
(`ContractRegistry.ts:155-175`, Q-3/SMELL-14). You cannot invert it to generate satisfying tuples
directly — the same wall `arbitraries.ts` hits for hand-written predicates. So you **generate and
filter**. This is not a new mechanism; it is the governing law the add-on already runs under:

> "A generator must produce **only** values the constraint accepts, or **decline**. … When [a faithful
> generator] does not [exist], **filter** a tighter base to the accepted set. When filtering would
> **starve** … **decline**." — DEC-031 (`DECISIONS.md:610-621`); `arbitraries.ts:19-37`

The `@Requires` filter is exactly one more generate-and-filter layer — a **whole-tuple** one rather than a
per-position one — and it must mirror `arbitraries.ts`'s starvation discipline, not invent its own.

**Honest consequence (DEC-031).** A narrow precondition starves the generator: most drawn tuples are
discarded, so the run covers far fewer distinct valid tuples than its case count suggests. That must be
*surfaced*, never hidden.

### `preconditionGate(baseArgs, pres)` — the new helper (internal to `oracle.ts`)

Mirrors the per-parameter filter path in `arbitraries.ts:401-428` (measure acceptance → decline at 0% →
warn below threshold → filter):

1. **No-`@Requires` guard (zero overhead).** `getEffectivePreconditions` returns the frozen
   `NO_PRECONDITIONS` (`ContractRegistry.ts:813`) for a method with none. `if (pres.length === 0) return
   { arbitrary: baseArgs, warnings: [] }` — the tuple is returned **byte-for-byte unchanged**, no filter,
   no measurement. A no-`@Requires` method is bit-for-bit its current behaviour (§5, guard verified).

2. **Measure acceptance.** Reuse `arbitraries.ts`'s `measureAcceptance` (`arbitraries.ts:608-614`) — lift
   it to an exported add-on-internal helper (it is currently module-private; `STARVATION_THRESHOLD` is
   already exported from the add-on, `arbitraries.ts:90`, `index.ts:40`). Measure the fraction of sampled
   `baseArgs` tuples satisfying `args => evaluatePreconditions(pres, args as unknown[]).ok`. Sampling the
   **unfiltered** base never starves (same reasoning as `arbitraries.ts:604-614`), and the fixed
   `seed: 0` keeps the acceptance figure — and therefore the decline/starve verdict — deterministic.

3. **0% → decline honestly.** `return { declined: true, reason: 'no generated argument tuple satisfies
   the effective precondition' + (pres[0].description ? \` ("${…}")\` : '') }`. This is the DEC-024/DEC-031
   "don't silently cover nothing" rule: an unsatisfiable-over-the-domain precondition must *decline*, not
   pass with zero valid samples. `declined` stays distinct from `passed` (`oracle.ts:117-119`, §3 of the
   report contract).

4. **Otherwise → filter, and warn if starving.**
   ```ts
   const arbitrary = baseArgs.filter(args => evaluatePreconditions(pres, args as unknown[]).ok);
   const starved = rate < STARVATION_THRESHOLD;
   const warnings = starved ? [preconditionStarvationWarning(rate, pres)] : [];
   return { arbitrary, warnings };
   ```
   The warning mirrors the per-parameter starvation warning shape (`oracle.ts:858-863`): e.g.
   *"@Requires generate-and-filter accepts only 8% of candidate tuples — the run may cover far fewer
   distinct valid tuples than its case count suggests (foundation §7.2)."*

**Reuse both existing mechanisms; invent neither.**
- `.filter(...)` on the arbitrary is the **hard soundness guarantee**: fast-check enforces it during
  generation **and shrinking**, so every tuple that reaches the method — and every shrunk counterexample
  — is precondition-valid.
- fast-check's **built-in filter-starvation throw** is the free backstop: if the filter genuinely can't
  produce a value, `fc.check` throws and is already caught → declined `"generation starved: …"`
  (`oracle.ts:200-212` sync, `:259-269` async). No new decline plumbing for the extreme case.
- The up-front `measureAcceptance` is what fast-check's filter alone **cannot** give: fast-check only
  throws at the very extreme; a 10%-acceptance filter silently yields few distinct tuples — precisely the
  "silently cover little" hole. Measuring surfaces the 0%→clear-decline and `<25%`→warn signals with a
  precondition-specific reason, exactly as `arbitraries.ts:401-415` does per position.

**Rejected: `fc.pre()` inside the property.** It discards runs against the `numRuns` budget rather than
against generation, does not compose with the arbitrary-level discipline the add-on already uses, and
risks the property body reaching the method before the guard unless hand-ordered — muddying the "only
valid tuples reach the method" guarantee. Filtering the arbitrary keeps invalid tuples out of
`oracleOutcomeSync` entirely.

---

## 4. No-drift + soundness

The filter predicate is `evaluatePreconditions(getEffectivePreconditions(target, key), args)` — the
**exact** pair enforcement uses:
- `getEffectivePreconditions` is the inheritance-aware read the installer plans from
  (`ContractInstaller.ts:322`) and the fuzzer now consumes (`ContractRegistry.ts:832-862`).
- `evaluatePreconditions` is *the* single function the runtime wrapper calls
  (`ContractInstaller.ts:589`), documented as the one-oracle-two-consumers no-drift guarantee
  (`Preconditions.ts:1-8`, `:35-51`; DEC-057 "One oracle, two consumers", `DECISIONS.md:976`).

Both are already exported from adorn's **root** (`index.ts:110`/`:341` and `:120`/`:346`) — the fuzzer
imports them from `../../index` exactly as it already imports `evaluatePostconditions`/
`getEffectivePostconditions` (`oracle.ts:70`). No re-implementation, so the tuples the fuzzer tests are
**exactly** the tuples enforcement accepts.

**Consequence — the hole is provably closed.** Any tuple that passes the filter has
`evaluatePreconditions(pres, args).ok === true`; enforcement's `checkPreconditions` short-circuits on the
same `ok` (`ContractInstaller.ts:589-590`) and never throws. So a precondition-satisfying tuple can never
trip the installed `@Requires` → no more spurious `unexpected-throw`. Symmetric to the DEC-034 postcondition
no-drift pin (`oracle.postcondition.test.ts:334-400`), which asserts *enforced-throws(x) ⟺ oracle-flags(x)*;
here we assert *filter-admits(x) ⟺ enforcement-accepts(x)*.

---

## 5. Interaction with what's already there

- **`@Optional` (DEC-051).** An optional position sometimes generates absence via `fc.option(...,{nil:
  undefined})` (`oracle.ts:755-775`). The precondition filter needs **no special handling**: the filter
  receives the *same* tuple the method is invoked with (`invoke` spreads `method(...args)`,
  `oracle.ts:817`; `evaluatePreconditions` spreads `pre.predicate(...args)`, `Preconditions.ts:43`). So a
  `@Requires` closure sees `args[i] === undefined` for an absent optional exactly as the enforced wrapper
  does — one tuple, checked and run identically. No drift.
- **Postconditions.** Still checked *after*, on the surviving tuples: the filter only narrows which tuples
  reach `oracleOutcomeSync`; `checkSettled`/`checkPostconditionBands` (`oracle.ts:549-628`) are unchanged.
  Layering, not replacement.
- **Async.** `fuzzMethodAsync` shares `p.argsArbitrary` (§2). The synchronous filter runs at generation
  time, before the awaited `oracleOutcomeAsync`. Unchanged.
- **Inheritance.** `getEffectivePreconditions` already unions the prototype chain base-most-first
  (`ContractRegistry.ts:832-862`; DEC-057 inheritance note, `DECISIONS.md:978`), so an **inherited**
  `@Requires` is respected **for free** — the fuzzer reads the effective set, gets the conjoined
  base+subclass closures, and filters by all of them. Confirmed: no subclass-specific code needed.
- **No `@Requires` → unchanged.** The `pres.length === 0` guard (§3 step 1) returns `baseArgs` untouched:
  no filter, no `measureAcceptance` call, no warning. Byte-for-byte the current run. This is the DEC-031
  "a declined constraint costs coverage, an unsound one costs trust" ethic applied to overhead too —
  methods that never opted into `@Requires` pay nothing.

---

## 6. Public API surface — purely internal, DEC-044 preserved

**No new export, option, or config on adorn's root.** The integration reads only the **already-public**
`getEffectivePreconditions` + `evaluatePreconditions` (added to the root by DEC-057, surface 91→94,
`DECISIONS.md:980`) and reuses the add-on-internal `STARVATION_THRESHOLD`/`measureAcceptance`. The root
surface count is **unchanged (94)**.

- Lifting `measureAcceptance` from module-private to an add-on-internal export (`arbitraries.ts` →
  `index.ts`) touches only the add-on's own surface, never `dist`.
- fast-check stays a devDep; nothing new enters the library build (`isolation.test.ts` unaffected).
- DEC-044 add-on isolation intact: `require('adorn')` still pulls no fast-check.

Optional (a later slice, not required for correctness): a `preconditions` summary on `FuzzResult` and a
named precondition line in `report.ts`. Slice 1 surfaces starvation through the **existing** warnings
channel, which is sufficient for the honesty contract.

---

## 7. Build sequence

Small enough for **one slice**, but staged so each step is independently reviewable/testable:

1. **Read + filter (the correctness core).** In `oracle.ts`: import `getEffectivePreconditions` +
   `evaluatePreconditions` from `../../index`; add `preconditionGate`; wire it into `prepareRun` at the
   `oracle.ts:394` hook (§2). Handle `pres.length === 0` (identity), 0% (decline), and the filter path.
   Export `measureAcceptance` from `arbitraries.ts`/`index.ts` and reuse it. — closes the false positive.
2. **Starvation surfacing.** Thread `gate.warnings` onto `PreparedRun` (`oracle.ts:313-326`) and merge
   them in `collectWarnings` (`oracle.ts:854-866`) so `assemblePassed`/`assembleFinding` carry them. The
   0%-decline reason already routes through `declinedResult` (`oracle.ts:868-891`) → `report.ts:87-89`.
3. **Tests** (§8).
4. *(Optional later slice)* enrich `FuzzResult`/`report.ts` with a named precondition-coverage line.

---

## 8. Tests to add — `addons/test/requires-fuzzing.test.ts`

Mirror the shape of `optional-fuzzing.test.ts` and `oracle.postcondition.test.ts` (classes declared
**inside** each test — SMELL-18; `resetConfiguration()` in `beforeEach` to restore default throw
enforcement the no-drift pins rely on).

1. **No false positive (the pre-integration bug).** `@Contract class Range { span(@Between(0,10) s, @Between(0,10) e) {…} }`
   with `@Requires((s,e)=>s<e, 'start before end')`. `fuzzMethod` → `result.passed === true`,
   `result.finding` undefined. (Before the fix this surfaced an `unexpected-throw` from the live
   precondition guard.)
2. **Narrow precondition surfaces a decline/warning, never a silent pass.** A precondition satisfiable by
   almost no tuple over the generated domain (e.g. `@Requires((a,b)=>a===b)` on two independent broad
   numeric params). Assert **either** `result.declined === true` with a reason naming the precondition
   (0% path) **or** `result.passed` with a starvation warning present (`<25%` path) — and assert it is
   **never** a clean run reporting a full case count with zero valid samples.
3. **Inherited `@Requires` is respected.** `Base` declares `@Requires`, `Sub extends Base` overrides the
   method redeclaring nothing. Fuzz `Sub`: no false positive → the inherited precondition was applied
   (proves `getEffectivePreconditions`' union is consumed).
4. **No-`@Requires` method is unaffected.** A method with none: `result` identical in shape to today; the
   composed `result.coverage[i].arbitrary` samples are unchanged (assert the arbitrary is the plain tuple
   — no filter wrapping), and no precondition warning appears. The zero-overhead guard.
5. **No-drift pin (only precondition-valid tuples reach the method).** Symmetric to
   `oracle.postcondition.test.ts:334-400`: install a `@Requires`, record the tuples the method actually
   receives (via a spy/counter in the method body), and assert **every** received tuple satisfies
   `evaluatePreconditions(getEffectivePreconditions(target,key), args).ok` — i.e. `filter-admits(x) ⟺
   enforcement-accepts(x)`. Also assert a hand-picked violating tuple both fails the filter predicate and
   makes the enforced wrapper throw `/Precondition failed/`.
6. **`@Requires` + postcondition together.** A method with both a `@Requires` and an `@Ensures`/`@Returns`:
   the fuzzer filters by the precondition **and** still catches a genuine postcondition break on the
   surviving tuples (proves layering — the filter did not suppress the postcondition oracle).
7. **Async twin.** `fuzzMethodAsync` on a `@Requires` async method → no false positive (shared arbitrary
   path).

---

## 9. Risks / open questions (for the adversarial reviewer)

1. **`measureAcceptance` sample vs. `fc.check` draw distribution.** The starvation figure is measured on a
   `seed:0`, 200-sample draw of the *base* tuple (`arbitraries.ts:93`, `:608-614`); the real run draws
   with fast-check's own seed and count. The measured rate is an *estimate* of coverage health, not the
   actual run's discard rate — same limitation the per-parameter filter already ships with. Acceptable, or
   do we want the warning to reflect the real run? (Recommend: keep the estimate; it is the established
   discipline and it is deterministic.)
2. **Filter starvation vs. slow generation.** A `<25%`-but-`>0%` precondition doesn't decline — fast-check
   keeps drawing. Could a very low (but nonzero) rate make a run pathologically slow before fast-check's
   own retry cap throws? The `measureAcceptance` warning fires, but should there be a *lower* auto-decline
   threshold distinct from `STARVATION_THRESHOLD` (which today only warns)? Open.
3. **Non-deterministic precondition closures.** A `@Requires` that reads clock/state could accept a tuple
   at filter time and reject at method time (or vice-versa), re-opening a narrow false-positive window.
   Enforcement has the identical exposure; the fuzzer inherits it. Document as a known limit (mirrors the
   nondeterministic-method note at `oracle.ts:650-662`), don't try to solve here.
4. **Shrinking through a filter.** We rely on fast-check re-applying the `.filter` predicate during
   shrinking so the reported counterexample stays precondition-valid (hence the classification re-run at
   `oracle.ts:231`/`:274` won't trip the live guard). Confirm fast-check's `FilterArbitrary` preserves the
   predicate under shrink for a *tuple* arbitrary (it does for the per-parameter filters already in use —
   verify it holds for the whole-tuple filter too, and add a test asserting the surfaced counterexample
   satisfies the precondition).
5. **Interaction with a declined position.** If a per-position plan already declined (`oracle.ts:365-381`)
   the run declines before the precondition gate is reached — so the precondition filter never sees a
   partially-ungeneratable tuple. Confirm ordering is intended (it is: no base tuple ⇒ nothing to filter).
6. **Reporting placement.** Slice 1 surfaces precondition starvation only through the foot-of-report
   warnings channel, not the per-parameter coverage block (which has no natural slot for a cross-parameter
   concern). Is a warning enough, or does the honesty contract (§3 of the report doc) want a first-class
   named precondition line now rather than in the optional later slice? Reviewer's call.

---

## 10. Adversarial review outcome & resolutions (BUILT — DEC-058)

An adversarial review verified every load-bearing claim against the code (verdict **BUILDABLE-WITH-FIXES**).
The core mechanism, the hook point (`oracle.ts:394`), the zero-overhead guard, the no-drift exactness, and
risk #4 (shrinking through the filter — fast-check re-applies `.filter` under shrink, so counterexamples
stay precondition-valid) all **HOLD**. Two significant findings were resolved with the user's decisions:

- **Finding F (a `@Requires`-only method is never fuzzed).** `findMethodEntry` reads only the *contract*
  band, which `@Requires` does not write to, so a precondition-only method declines *before* the gate — and
  fuzzing it would need argument arity the runtime cannot recover without a per-position decorator (Q-10,
  deferred). **Resolution (user):** ship the mixed-case filter (the actual false-positive fix) and make the
  decline reason **accurate** (name the cross-parameter `@Requires` + the Q-10 arity limit) instead of the
  misleading "no contract recorded"; leave actually-fuzzing `@Requires`-only methods to the deferred arity
  work. `methodHasPreconditions` drives the corrected message.

- **Finding C (the "fast-check filter-starvation throw" backstop does not exist).** Verified against
  fast-check 4.9.0: `FilterArbitrary.generate` is an unbounded loop with **no** starvation throw. So the
  measured **0%-acceptance decline** — not any fast-check backstop — is the sole guard against an infinite
  draw; a tiny-but-nonzero cross-parameter precondition (which starves *combinatorially* worse than a
  per-position filter) terminates but covers little, surfaced as a warning. **Resolution (user):** strike
  the false claim (§3, and the pre-existing `oracle.ts:201` comment — both corrected), keep the 0%→decline +
  `<25%`→warn discipline (matching the shipped per-position filters), and document the combinatorial caveat.

Minor fixes applied: `measureAcceptance` exported from `arbitraries.ts` only (not `index.ts` — the add-on's
public surface is untouched). Risks #1/#3/#5 stand as documented; #2 is addressed by the C resolution; #6's
first-class precondition report line remains the optional later slice. Root surface count unchanged (94);
fast-check stays a devDep. Shipped as `addons/test/requires-fuzzing.test.ts` (9 tests, incl. the no-false-
positive case, 0%-decline, `<25%`-warn, inherited-respected, layering-with-postconditions, async, the
no-drift pin, zero-overhead, and the finding-F accurate-decline).
