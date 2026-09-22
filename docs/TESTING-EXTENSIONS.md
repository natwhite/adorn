# Completing the design-by-contract core (with stateful & seam testing as the payoff)

**Status:** plan of record set 2026-09-21, after a four-angle planning pass and a consolidated
adversarial review. The objective is **completing adorn's design-by-contract model for stateful
objects**, with stateful-sequence and seam testing as the payoff. **Object/composite generation has
shipped (DEC-088), the `@EnabledWhen` enforcement/reification band has shipped (DEC-089), and the
stateful-sequence tester `fuzzSequence` that consumes it has shipped (DEC-090) — completing sequence #1
of the payoff.** The state precondition is named **`@EnabledWhen`** (not `@Guard` — the latter collides
with the `ContractTrust='guard'` term). The sections below are the vision and rationale; the **Plan of
record** at the end is the sequenced decisions and scope changes.

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

### 1. State-aware guards — `@EnabledWhen` (the keystone)
**Missing:** a precondition can't read `this` — `PreconditionPredicate = (...args) => boolean`, evaluated
with no receiver (`Preconditions.ts`, `ContractInstaller.ts:520`). So a state precondition is
inexpressible.

**Ideal:** a first-class **`@EnabledWhen((self, ...args) => boolean)`** band — a state precondition that
gates *enabledness*. Distinct from `@Requires` (not a stylistic split) because the two carry **opposite
operational meaning** the engine cannot recover from a unified decorator: a failed `@Requires` = "these
args are never valid" (a **generation/starvation** signal — `preconditionGate` measures it); a failed
`@EnabledWhen` = "correctly not enabled in this state now" (an **expected skip**). A mixed predicate
(`amount <= self.balance`) can't be statically split into generate-vs-enabledness, so unifying breaks
the derivability of the command model. `@EnabledWhen` also keeps `@Requires` arg-only and schema-projectable
(a guard can't project into an input schema — no argument choice satisfies it), and it only taxes
authors of *stateful* contracts. **Concession:** Eiffel unifies the two, and for enforcement alone they
behave identically (both throw, caller-blame); `@EnabledWhen`'s justification is adorn-specific — projection
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

- **Object/composite generation — SHIPPED (DEC-088).** `arbitraryForConstraint` no longer declines on
  `shape`/`fields`/`nullable`/`const`/`dictionary`/`uuid`/`dateTime`/`ipv4`; each has a sound generator
  (per-field stacks routed through `arbitraryForParameter` for DEC-082 base selection, a
  backward-compatible depth bound, and a predicate soundness guard). Object-typed inputs and
  descriptor-driven seams now generate, and `fuzzMethod`/`fuzzFunction` are upgraded for free.
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

- **#1 Stateful call-sequence testing** — a *true* model-based tester: `@EnabledWhen` gives derivable
  enabledness, `old()` gives the transition oracle, constructor contracts give the start state; no
  carve-outs, DEC-034 invariant intact.
- **#2 Seam / composition testing** — static gap-finder via the Core implication engine (confirm-or-
  decline, witnessed), dynamic path via harvest; consumer-driven contract testing derived from the
  code's own contracts.
- **Still future (recorded):** declared relations (`@Inverse`/`@Idempotent`/`@Metamorphic`) and trace
  conformance (testing × observability); the self-growing counterexample corpus (DEC-046) and
  differential testing; the `adorn test` CLI + coverage-of-contract report (which methods are fully
  auto-tested vs invariant-floored).

## Phasing (original core-first ideal — superseded by the Plan of record below)

1. **`@EnabledWhen`** (core) — the keystone; unlocks true model-based sequences.
2. **`old()` / pre-state** (core) — the transition oracle.
3. **Constructor contracts + invariant-at-construction** (core) — proper start states.
4. **Complete object/composite generation** (addon) — also upgrades `fuzzMethod`.
5. **Descriptor-implication engine** (Core) — powers seam-static + contract-diff.
6. **#1 stateful-sequence testing** and **#2 seam testing** on the completed core.
7. **Contract-diff projection**, on the same engine.

Each core capability is validated by its testing consumer as it lands (the sequence driver is the best
test of `@EnabledWhen`).

## Design sub-decisions (leans — settled 2026-09-21; see the Plan of record below)

- **`@EnabledWhen` vs widen `@Requires`:** `@EnabledWhen` (argument above) — pending final confirmation.
- **`old()` snapshot depth:** shallow + opt-in capture expression, not deep-clone-everything.
- **Constructor wrapping:** validating subclass over Proxy; scope = "wrap when there's a construction
  contract or a class invariant", not minimal.

## The honest limit (unchanged)

Contract-derived testing tests **what the contract says**. What stays the adopter's: semantic
correctness the contract doesn't encode, external side-effects, anything below the contract's
resolution. The virtuous loop is the sell — every contract clause now does quadruple duty (enforce +
document + project + test) — but the completed DbC core widens *how much* the contract can say, which is
the whole point.

## Plan of record (2026-09-21)

Set after the four-angle planning pass and a consolidated adversarial review. The review's central
finding — *no current consumer has a stateful object with invariants; both live at the LLM tool
boundary* — was weighed, and the DbC-completion bet was **kept deliberately** (building for the
capability and the library's completeness, not only current demand), but its **sequence and scope were
revised** by what survived scrutiny.

**Sequence:**
1. **Object/composite generation — DONE (DEC-088).** The cheapest, consumer-requested, dependency-free win.
2. **`@EnabledWhen` + stateful-sequence testing — SHIPPED (DEC-089 + DEC-090).** The `@EnabledWhen`
   enforcement/reification band (DEC-089): a receiver-reading state precondition, a separate registry
   band so downstream tells enabledness (expected skip) from a precondition (starvation), enforced last
   in the pre-call gate, with `evaluateEnabledness` exported as the one oracle. The `fuzzSequence` driver
   (DEC-090): generates sequences of enabled calls against one evolving instance (`fc.array(fc.oneof(...))`,
   hand-rolled — not `fc.commands`), pre-checks enabledness against the live instance (clean-false = skip,
   throw = finding), runs enabled steps through the reused oracle body, and checks invariants survive every
   transition. Start-state from the existing `subject` factory; enumerates enabledness-only nullary methods
   (`pop()`) via `getEffectiveEnablednessKeys`. No drift (DEC-006/DEC-034).
3. **`old()` / pre-state** — only if the sequence driver shows the invariant-preservation floor needs a
   transition oracle, and then **sound by construction** (below).
4. **Contract-diff projection + its `fragmentImplies` engine** — deferred; the seam static-checker's
   decidable subset is low-value while real seams are opaque `@Ensures` (harvest covers them soundly).

**On hold (deliberately):** the LLM tool-boundary projections (MCP, multi-provider tool schemas,
structured-output) — demand-backed and on the README north star; revisit after the sequence-testing bet.

**Scope changes the adversary earned:**
- **Name:** `@EnabledWhen`, not `@Guard` (collides with `ContractTrust='guard'` / `disableGuardEnforcement()`).
- **`@EnabledWhen` semantics:** a guard that *returns false* is an expected skip; a guard that *throws*
  is a finding (guards must be total over reachable state). `fuzzMethod` gains little from it (a fresh
  subject makes a state-guard near-constant) — its value is entirely in the sequence driver.
- **`old()` sound by construction:** **no shallow-alias default** (it aliases object fields by reference,
  so an in-place mutation makes `old.x === self.x` and a transition postcondition silently passes on the
  commonest case). Primitive fields by value; non-primitive pre-state via a *mandatory* explicit capture
  evaluated pre-`proceed()`; an undeclared nested read fails loudly, never silently-wrong.
- **Constructor: band before wrapper.** Ship the *registry band* (widen the param-decorator to accept a
  constructor param's `undefined` key; record ctor params) — additive/semver-minor — which is all the
  fuzzer needs to generate a valid start instance and check the invariant itself. **Defer the
  construction-wrapping** (validating subclass, `new`-interception, invariant-at-construction) that makes
  it a semver-major identity change, until a consumer needs *enforced* construction. The sole class
  consumer prefers the documented static-factory idiom and isn't pushing.
- **Evidence-gated, not built ahead of demand:** `old()`, the constructor wrapper, and `fragmentImplies`
  are each gated on a concrete need. The "no partial fixes" principle governs the *design* of each piece,
  not a mandate to ship all pieces at once.
