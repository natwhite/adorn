# Completing the design-by-contract core (with stateful & seam testing as the payoff)

**Status:** reframed 2026-09-08. What began as "two testing-projection extensions" is now understood
as **completing adorn's design-by-contract model for stateful objects**, of which stateful-sequence
and seam testing are the payoff that both motivates and proves the completion. A planning +
adversarial pass on this reframing is underway; the plan of record will be appended.

## The reframe

adorn calls itself a design-by-contract library — `@Requires` / `@Ensures` / `@Contract`, caller/
callee blame — but it implements only the **stateless subset**: contracts over a call's *arguments*
and *result*. It cannot yet express three things any DbC system needs for *stateful objects*, all of
which are standard (Eiffel has had them for decades):

1. a **precondition that reads object state** ("`withdraw` requires `balance >= amount`") — today that
   has to hide in the method body, which is precisely the drift adorn exists to prevent;
2. a postcondition that references **pre-call state** (`old`) — so you can say what an operation
   *does*, not just that the invariant survived;
3. an **invariant established at construction**.

The four-angle planning pass kept routing *around* these gaps ("guard by execution", "skip
precondition violations", a `@Throws` marker for domain throws, "ship on a `subject` factory and call
the constructor work additive", "harvest dodges the object-generation gap"). Under the standing
principle — **change the core when it yields a better library; no partial fixes when an ideal exists**
([[prefer-root-fixes-not-additive-workarounds]]) — those are symptoms, not solutions. Completing the
DbC core removes them at the root, and makes the whole library stronger for *enforcement*, not only
testing. Stateful-sequence testing is then the natural consumer that exercises the full model.

## Where the testing projection is today

`adorn/test` tests **one unit against its own contract**: `fuzzMethod`/`fuzzFunction`/`fuzzClass`
generate inputs (sound-generation-or-decline, DEC-082/083), run the unit, and check both postcondition
bands + field invariants through one target-agnostic oracle (`makeCall → {receiver, result}`, DEC-084)
whose property is **"the fuzzer flags an input exactly when the enforced wrapper throws"** (DEC-034).

## The three core completions

### 1. State-aware guards — `@Guard` (the keystone)
**Missing:** a precondition can't read `this` — `PreconditionPredicate = (...args) => boolean`, evaluated
with no receiver (`Preconditions.ts`, `ContractInstaller.ts:520`). So a state precondition is
inexpressible.

**Ideal:** a first-class **`@Guard((self, ...args) => boolean)`** band — a state precondition that
gates *enabledness*. Distinct from `@Requires` (not a stylistic split) because the two carry **opposite
operational meaning** the engine cannot recover from a unified decorator: a failed `@Requires` = "these
args are never valid" (a **generation/starvation** signal — `preconditionGate` measures it); a failed
`@Guard` = "correctly not enabled in this state now" (an **expected skip**). A mixed predicate
(`amount <= self.balance`) can't be statically split into generate-vs-enabledness, so unifying breaks
the derivability of the command model. `@Guard` also keeps `@Requires` arg-only and schema-projectable
(a guard can't project into an input schema — no argument choice satisfies it), and it only taxes
authors of *stateful* contracts. **Concession:** Eiffel unifies the two, and for enforcement alone they
behave identically (both throw, caller-blame); `@Guard`'s justification is adorn-specific — projection
and testing, adorn's differentiators.

**Fixes in enforcement:** you can finally declare "`withdraw` requires sufficient balance" as a
contract. **Fixes in testing:** stateful testing becomes a *true* model-based tester — enabledness is
derivable, so the driver generates only enabled commands, shrinking is genuinely minimal, and a
legitimate `pop()`-on-empty is simply not enabled (no false positive, no marker). **The DEC-034 "flag
exactly when the wrapper throws" invariant is preserved, not carved out.**

### 2. `old()` / pre-state capture
**Missing:** postconditions get `(result, ...args)` with no pre-state (`Postconditions.ts`), so
transition *relations* are inexpressible.

**Ideal:** a pre-`proceed()` snapshot protocol exposing `old` (and post-state `self`) to postconditions:
`@Ensures((result, old, self) => self.balance === old.balance - amount)`. **Enforcement** gains real
transition contracts; **testing** gains a *true transition oracle* — testing what each operation
*does*, not just that the invariant survived. Snapshot **shallow by default with an opt-in capture
expression** (deep-cloning arbitrary graphs is often impossible); "capture what the postcondition
names."

### 3. Constructor contracts + invariant-at-construction
**Missing:** constructor parameters can't be decorated, and no invariant is established at construction
(IDEA-5's absent hook).

**Ideal:** the constructor-decorator feature, promoted from "additive Phase 4" to foundational.
Construction becomes an enforced boundary **whenever there is something to enforce there** —
constructor-param contracts *or* a class invariant to establish — consistent with how methods are
always wrapped (a principled scope, not a minimal one). **Enforcement** gains the DbC "invariant holds
after construction" guarantee; **testing** gets a valid, invariant-satisfying starting instance
generated *from contracts*. Mechanism: a validating **subclass** over a Proxy (debuggable, avoids the
static-`#private` trap).

## Two completions (finish the job, don't dodge it)

- **Object/composite generation.** `arbitraryForConstraint` declines on `shape`/`fields`/`nullable`/
  `const`/`dictionary`/`uuid`/`dateTime` (arbitraries.ts:251, the `default`). Complete it (recurse
  field descriptors → `fc.record`, etc.) so object-typed inputs and descriptor-driven seams work — this
  also upgrades today's `fuzzMethod`.
- **A first-class descriptor-implication engine in Core.** Nothing computes `A ⊨ B` today (only
  conjunction-merge in `schema.ts` and a single-contradiction detector in `unsatisfiable.ts`). Build
  `fragmentImplies` in `src/Core/` (the `unsatisfiable.ts` hoist precedent), shared by seam static-
  checking *and* the future contract-diff projection.

## What honestly stays as-is (not every decline is a gap)

Opaque `@Ensures`/custom-predicate logic is genuinely undecidable to compare statically, so the seam
static-checker **correctly declines** there and the sound **harvest** path (run the producer, feed the
consumer its real outputs) covers it. That is the right handling of arbitrary logic — not a workaround —
and no core change improves it. Fast-check isolation (DEC-019) also stays: dependency hygiene, not
additive-minimalism.

## The payoff: the testing features on a completed core

- **#1 Stateful call-sequence testing** — a *true* model-based tester: `@Guard` gives derivable
  enabledness, `old()` gives the transition oracle, constructor contracts give the start state; no
  carve-outs, DEC-034 invariant intact.
- **#2 Seam / composition testing** — static gap-finder via the Core implication engine (confirm-or-
  decline, witnessed), dynamic path via harvest; consumer-driven contract testing derived from the
  code's own contracts.
- **Still future (recorded):** declared relations (`@Inverse`/`@Idempotent`/`@Metamorphic`) and trace
  conformance (testing × observability); the self-growing counterexample corpus (DEC-046) and
  differential testing; the `adorn test` CLI + coverage-of-contract report (which methods are fully
  auto-tested vs invariant-floored).

## Phasing (inverted — core first, testing lands clean on top)

1. **`@Guard`** (core) — the keystone; unlocks true model-based sequences.
2. **`old()` / pre-state** (core) — the transition oracle.
3. **Constructor contracts + invariant-at-construction** (core) — proper start states.
4. **Complete object/composite generation** (addon) — also upgrades `fuzzMethod`.
5. **Descriptor-implication engine** (Core) — powers seam-static + contract-diff.
6. **#1 stateful-sequence testing** and **#2 seam testing** on the completed core.
7. **Contract-diff projection**, on the same engine.

Each core capability is validated by its testing consumer as it lands (the sequence driver is the best
test of `@Guard`).

## Design sub-decisions (leans)

- **`@Guard` vs widen `@Requires`:** `@Guard` (argument above) — pending final confirmation.
- **`old()` snapshot depth:** shallow + opt-in capture expression, not deep-clone-everything.
- **Constructor wrapping:** validating subclass over Proxy; scope = "wrap when there's a construction
  contract or a class invariant", not minimal.

## The honest limit (unchanged)

Contract-derived testing tests **what the contract says**. What stays the adopter's: semantic
correctness the contract doesn't encode, external side-effects, anything below the contract's
resolution. The virtuous loop is the sell — every contract clause now does quadruple duty (enforce +
document + project + test) — but the completed DbC core widens *how much* the contract can say, which is
the whole point.
