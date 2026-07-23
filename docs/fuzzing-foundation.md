# adorn — The Contract-Driven Testing & Fuzzing Foundation

> **Scope.** This is a vision-and-foundation document, not a build plan and not code. It works out
> what a *solid foundation* for contract-driven generative testing looks like for adorn, where the
> seams already are, and — decisively — where the honest boundary of each piece falls. It is written
> because the user asked for this part specifically: *"testing needs a solid foundation… I want this
> part done right."*
>
> **Sourcing.** Claims about other tools (fast-check, `clojure.spec`, Hypothesis, icontract) are cited
> inline and are **verified fact**. Claims about adorn's own code cite the file. Everything describing
> what adorn *should* do is labelled **Proposed** and is design, not commitment. The two are kept
> visibly apart throughout, in the discipline the rest of `docs/` already uses.
>
> **Governing philosophy (the north star for this whole area).** In the user's words:
> *"I would honestly rather poise a library like this to provide functionality and trust developers to
> use it responsibly. We'll still need warnings, but I'm not sure this is a problem we need to 'solve'
> since protecting devs from themselves is a slippery slope."* So the aim of fuzzing in adorn is
> **capability, not guarantee.** This document never designs a system that promises soundness,
> completeness, or coverage, or that tries to prevent misuse. It designs one that gives developers
> powerful generative testing they opt into, is honest about its limits, warns where a risk is hidden
> from them, and trusts them everywhere else. That lineage is already in the repo — DEC-020 put a
> decision "where the information is," and DEC-025 drew a *bounded* responsibility rather than an
> unbounded promise — and §7 draws the same line for fuzzing explicitly.

---

## 1. What "done right" means here

The temptation is to define this feature by its most exciting output — "decorate your code, get a fuzz
suite." That framing is precisely what the repo has already ruled undeliverable: *"'decorate your code,
get a fuzz suite' is not deliverable. Coverage is partial by construction"* (ISSUES.md **Q-3**). Doing
it right therefore cannot mean maximising coverage. It means getting the **foundation and the honesty**
right, so that whatever coverage the tool does deliver can be trusted exactly as far as it goes and not
one inch further.

A contract-driven test foundation is four separable pieces. Each has a job, a seam, and a boundary, and
the whole point of "done right" is that the boundaries are stated, not blurred:

| Piece | What it does | Where it rides in adorn | Its honest boundary |
|---|---|---|---|
| **Input generation** | Turn a *precondition* into a generator of inputs that satisfy it | the `arbitrary` hook on each constraint descriptor (`src/Core/Descriptor.ts`) | Only some constraints yield generators; hand-written predicates yield none (Q-3) |
| **The oracle** | Decide whether a run of the method was *correct*, given a generated input | the reserved `post` slot on `MethodContract` (`src/Core/ContractRegistry.ts`) — plus field invariants, which exist today | Without postconditions, the only question askable is "did it crash / break an invariant?", not "was it right?" |
| **Shrinking** | Reduce a failing input to a minimal counterexample | **fast-check**, entirely | adorn contributes nothing here and should not try to |
| **Reproducibility** | Replay a failing run deterministically | **fast-check** seeds + path | inherited for free, because generators are pure functions of frozen params (DEC-010) |

The foundation is those four wired correctly and — the load-bearing part — **a fifth thing that is not a
feature but a discipline: the tool reports its own coverage boundary.** It must be able to say, for any
method it fuzzed, *"I generated real inputs for these parameters, I generate-and-filtered these, I could
not generate these, and my oracle was `X`."* This is the direct descendant of two things already shipped:
`schema.ts`'s "under-claim, never over-claim" ethic, and the sensitive-flow detector's scope report
(*"a clean `Leaks: none` never masquerades as a clean bill of health"*, DEC-028 point 3). A fuzzer that
runs 10,000 cases and finds nothing has said something almost worthless unless it also says *what it
generated* — and the difference between those is the entire deliverable.

**"Done right" restated in one sentence:** a foundation where generation is *sound* (it only ever produces
inputs the contract accepts), the oracle is *honest* (it never claims to have checked more than it did),
and the tool's *own coverage* is a reportable artifact rather than an implied one — riding fast-check for
everything fast-check already does well, and inventing nothing that promises correctness.

---

## 2. The tradition this rides on (verified)

adorn is not inventing generative testing; it is projecting its contracts into a mature one. Grounding
the vision in what these tools *actually* do keeps the design honest about what is hard.

- **QuickCheck → fast-check.** Property-based testing checks a statement of the form *"for all `x` such
  that `precondition(x)`, `property(x)` holds"* by sampling `x` from a generator (an *Arbitrary*), and on
  failure **shrinks** the counterexample to a minimal one; runs are **seeded** and **replayable** by
  passing the seed (and a path) back
  ([fast-check overview](https://www.npmjs.com/package/fast-check),
  [jrsinclair, getting started](https://jrsinclair.com/articles/2021/how-to-get-started-with-property-based-testing-in-javascript-with-fast-check/)).
  This is the exact shape of "contract in, tests out": the precondition is the `such that`, the
  postcondition is the `property`.

- **`clojure.spec` — the closest model, and the one that names the hard part.** One `spec` declaration
  serves *both* as a validator *and* as a generator; `s/fdef` specs a function's `:args`/`:ret`/`:fn`,
  and `check` generates ~1000 argument sets valid per `:args`, runs the function, and asserts `:ret`/`:fn`
  ([clojure.org/about/spec](https://clojure.org/about/spec),
  [Practicalli, generative testing](https://practical.li/clojure/clojure-spec/generative-testing/)). Two
  facts from the rationale matter enormously for adorn:
  1. *"There are built-in associations between many of the `clojure.core` data predicates and
     corresponding generators, and the composite ops of spec know how to build generators atop those."*
     Generation works because the **primitive predicates are known**, not arbitrary.
  2. *"If you call `gen` on a spec and it is unable to construct a generator for some subtree, it will
     throw an exception that describes where."* And the fix is `s/with-gen` — **you supply the generator
     spec cannot derive** ([clojure.org/about/spec](https://clojure.org/about/spec)). Composition via
     `s/and` *"uses the generator of its first component spec, then filters"* — the exact fallback adorn
     will need, and the exact place it can starve.

  This is Q-3, verbatim, from the language that pioneered the idea: a generator can be derived from a
  *known* constraint, not from an *arbitrary* one.

- **Hypothesis (Python) — the honesty machinery.** Hypothesis shrinks to a minimal example, persists
  failing examples in a `.hypothesis/` **database** and replays them on later runs (a found bug stays
  found even after the seed moves), and — the part adorn should copy in spirit — ships a
  **`filter_too_much` health check** that fires when a strategy filters out far more candidates than it
  keeps, because that *"will make your tests much slower and probably distort the data generation quite a
  lot"*. `assume()` marks a generated example as bad rather than failing the test
  ([Hypothesis health checks](https://hypothesis.readthedocs.io/en/hypothesis-python-4.57.1/healthchecks.html)).
  The health check is the template for how adorn should treat generate-and-filter starvation: **surface
  it as information, do not silently absorb it.**

- **icontract-hypothesis — the precise blueprint for the boundary.** This is the tool most like what
  adorn wants to be: it *infers* Hypothesis strategies from a function's **preconditions** and uses its
  **postconditions as the oracle**, so evolving the contract evolves the test
  ([icontract-hypothesis](https://github.com/mristin/icontract-hypothesis)). Its strategy inference is a
  three-tier cascade, and adorn's arbitrary-generation boundary is the same three tiers:
  1. **Direct pattern match** → a parametrised strategy. *"`5 < x < 10` gives a search strategy
     `integers(min=6, max=9)`."* It handles **numeric bounds and regexes on strings** this way.
  2. **Single-argument filter** → generate by type hint, compose with a `FilteredStrategy`.
  3. **Whole-tuple filter** → *"the remainder of the pre-conditions are enforced by filtering on the whole
     fixed dictionary."*

  And the invariant that makes it trustworthy: *"icontract-hypothesis guarantees that the inferred
  strategy must satisfy the preconditions"* ([icontract-hypothesis](https://github.com/mristin/icontract-hypothesis)).
  That guarantee — **generate only what the contract accepts** — is the one adorn must adopt as its own,
  and §4 makes it the foundation's central invariant.

---

## 3. The seam is already in the code

Three facts about the current tree make this a *wiring* problem, not a green-field one, and they are why
the earlier decisions insisted on reifying contracts as data (DEC-006, DEC-010):

1. **The `arbitrary` hook exists, shape-only.** Every constraint descriptor already carries an optional
   `arbitrary?: () => Arbitrary`, and `Arbitrary` is typed `unknown` "because `fast-check` is not a
   dependency of this package… When the fast-check bridge lands (`Projections/arbitraries.ts`), narrow
   this alias in one place" (`src/Core/Descriptor.ts`). The optionality is deliberate and is the whole
   Q-3 boundary encoded in a type: `'arbitrary' in descriptor` is designed to be *"an honest answer to
   'can this constraint be fuzzed?'"* (Descriptor.ts, `createDescriptor`).

2. **The oracle slot exists, reserved and empty.** `MethodContract` carries `pre` and `post` as
   *"reserved slots, always present and always empty… declared now because postconditions are a
   prerequisite for the flagship goal, not a nicety — without an oracle, generated inputs can only ever
   test 'it did not throw'"* (`src/Core/ContractRegistry.ts`). There is deliberately **no writer** for
   them yet (Q-11): *"the fuzzing projection cannot function without them: postconditions are the
   oracle."* A separate agent is planning postconditions; §5 states exactly what the fuzzer needs from
   that work.

3. **There is a working template for a projection over this seam.** `src/Projections/schema.ts` is a
   *second* renderer over the same registry reads that `docs.ts` uses (`getContractsForClass`,
   `getFieldContractsForClass`), reading `descriptor.schema()` off each descriptor. The fuzzing
   projection is the **third** renderer over that identical seam, reading `descriptor.arbitrary()`
   instead of `descriptor.schema()`. It inherits, for free, the two-key-band walk (DEC-018) and the
   inheritance union (DEC-021 fields, DEC-022 methods), and it is bound by the same layering rule
   (DEC-012): a projection may depend on `Core/` and `Contracts/` only, never on a decorator adapter.

The upshot: the arbitraries bridge is `schema.ts` again with a different hook, and the honest boundary is
already carved into the types. What remains is to say precisely *which* constraints fill the hook, and how.

---

## 4. Arbitraries from descriptors — the precise boundary (the crux)

This section is the one the user most needs done right. It maps every built-in constraint to exactly one
of three outcomes, and states the invariant that makes any of them trustworthy.

### 4.1 The one invariant: generation is *sound*, or it declines

**Proposed.** A generator derived from a constraint must produce **only** values that satisfy that
constraint — icontract-hypothesis's *"the inferred strategy must satisfy the preconditions"*
([icontract-hypothesis](https://github.com/mristin/icontract-hypothesis)), adopted as adorn's law. This
is the *generation* analogue of the *schema* ethic already shipped ("under-claim, never over-claim",
schema.ts): a schema must never reject a value enforcement accepts; a generator must never *produce* a
value enforcement rejects. There are exactly three sound outcomes, and the descriptor's optional
`arbitrary?` hook already encodes the choice among them:

- **Parametric** — derive the generator from `params`, sound by construction. `min:1, max:100` becomes
  `fc.integer({min:1, max:100})`; every value it makes is in range because the *generator* is
  parametrised by the same numbers the *predicate* checks. No drift, by the DEC-010 mechanism.
- **Generate-and-filter** — generate a broad arbitrary of the right type, then `.filter(descriptor.predicate)`.
  Sound because it reuses the *exact predicate enforcement runs* (again no drift), but it can **starve**.
- **Decline** — supply no `arbitrary` hook at all. The honest absence. `'arbitrary' in descriptor` is
  `false`, and the scope report says so.

The rule that ties them together: **never generate an invalid input and label it valid.** When in doubt,
filter; when filtering would starve, decline. A declined constraint costs coverage; an *unsound* one costs
trust, and trust is the only thing this foundation is actually building.

### 4.2 The per-constraint map (built-ins, today)

The constraint files already sketch this boundary in their own headers — this makes it precise. **Verified**
facts about each constraint are its `params` and `derive` (from `src/Contracts/number.ts` and
`src/Contracts/string.ts`); the generator column is **Proposed**.

| Constraint | `params` | Outcome | Proposed generator | Note |
|---|---|---|---|---|
| `min` / `GreaterThanEqual` | `{min}` | **Parametric** | `fc.integer/double({min})` | inclusive bound is native to fast-check |
| `max` / `LessThanEqual` | `{max}` | **Parametric** | `fc.integer/double({max})` | |
| `greaterThan` | `{exclusiveMin}` | **Parametric** | `fc.double({min, minExcluded:true})` | fast-check has exclusive-bound options; else nudge |
| `lessThan` | `{exclusiveMax}` | **Parametric** | `fc.double({max, maxExcluded:true})` | |
| `between` | `{min, max}` | **Parametric** | `fc.integer/double({min, max})` | the cleanest case; a bounded range is what generators are best at |
| `integer` | `{}` | **Parametric** | `fc.integer()` | composes with a range by merge (§4.3) |
| `multipleOf` | `{multipleOf}` | **Parametric** | `fc.integer().map(n => n * divisor)` | sound via `map`; but see the float caveat below |
| `minLength` / `notEmpty` | `{minLength}` | **Parametric** | `fc.string({minLength})` | number.ts/string.ts call this "obvious" |
| `maxLength` | `{maxLength}` | **Parametric** | `fc.string({maxLength})` | |
| `matches` | `{pattern:{source,flags}}` | **Parametric*** | `fc.stringMatching(new RegExp(source, flags))` | fast-check *inverts* regexes — see §4.4 |
| `email` | `{pattern}` (fixed) | **Curated** | a sample set of valid addresses, or `stringMatching` on the approximate pattern | string.ts: "the honest answer is a curated sample set rather than a pretence of full generality" |
| `url` | `{protocols}` | **Curated / constructed** | compose `protocol` + host samples, or a curated list | parsed with `new URL`, no regex to invert |
| **any `CreateSimpleDecorator` closure** | — (none) | **Decline** | — | a hand-written predicate carries no identity and no params; it never reaches the registry (SMELL-14) and can never be inverted (Q-3) |

Three things this table makes exact, and each is a place the design earns "done right":

- **`multipleOf` has a floor.** `n => n * divisor` is sound and even *guarantees* the property (every
  output is a multiple), which is better than filtering. But the *fractional* case number.ts already
  documents — `0.3 % 0.1 !== 0` in binary floating point — means a `map`-based generator for a fractional
  divisor and a filter-based one can disagree on edge values. The honest move is to generate the integer-
  multiple case parametrically and, for fractional divisors, either accept the same relative tolerance the
  predicate uses or decline. Stated, not hidden.

- **`email` and `url` are the "curated, not general" cases**, and string.ts says so outright. A generator
  that pretends to cover RFC 5322 is a lie; a curated sample of realistic addresses plus a few adversarial
  ones is honest and more useful. This is the same instinct as the approximate email *pattern* — err
  toward a small true thing over a large false one.

- **The `CreateSimpleDecorator` decline is not a gap, it is consistency.** Those closures are *already*
  invisible to `docs` and `schema` (SMELL-14: *"a class using only them is enforced yet undocumented…
  Q-3 surfacing as an API-level split"*). They are invisible to fuzzing for the identical reason, and that
  is correct: a black box cannot be inverted. The irony worth stating to users (see §8): the methods a
  careful developer hand-wrote a bespoke predicate for are exactly the ones that generate *worst*.

### 4.3 Composition is conjunction, and generation makes it harder than schema did

**Verified (repo).** Stacked constraints on one parameter are a conjunction — the same logical AND the
enforcement wrapper applies and the same union DEC-021/DEC-022 resolve down a prototype chain — and
`schema.ts` already merges them: disjoint keywords coexist, a repeated bound takes the tighter value,
`integer ⊂ number` resolves to `integer`, and anything uncombinable falls back to `allOf`
(`src/Projections/schema.ts` module header).

**Proposed.** Generation cannot fall back to an `allOf`-style "just AND them" — a generator must actually
*produce* a value in the intersection, not merely describe it. The strategy mirrors `clojure.spec`'s
`s/and` (*"uses the generator of its first component… then filters"*,
[clojure.org/about/spec](https://clojure.org/about/spec)) and icontract-hypothesis's cascade:

1. Build the **tightest parametric generator** from the combinable subset — `Integer()` ∧ `Between(1,100)`
   → `fc.integer({min:1, max:100})`, exactly the merge schema.ts already computes from the same params.
2. **`.filter()` by the conjunction of the remaining predicates** — the constraints that had no parametric
   contribution are enforced by rejecting generated values that fail them, reusing their real predicates.
3. If the filtered fraction is tiny, **surface it** (§7) — Hypothesis's `filter_too_much` in spirit.

So the merge logic schema.ts wrote is directly reusable for step 1; step 2 is where the difficulty that
schema.ts *didn't* have shows up. A schema can always describe an intersection it cannot generate a member
of; a fuzzer cannot.

### 4.4 The regex case is *delegated*, not unsolved

The task framed `Matches(/regex/)` as "harder" than a bounded number, and in principle it is — inverting an
arbitrary regular expression into a generator is real work. The important **verified** update is that
adorn does not have to do that work: **fast-check ships `fc.stringMatching(regex)`**, which *"generates an
`Arbitrary<string>` for strings matching a provided regex"* (available since 3.10.0; Unicode property
escapes `\p{…}` added in 4.7.0)
([fast-check `stringMatching`](https://fast-check.dev/api-reference/functions/stringMatching.html),
[fast-check 4.7.0 notes](https://fast-check.dev/blog/2026/04/18/whats-new-in-fast-check-4-7-0)). So `matches`
rides fast-check's regex inverter and moves from "hard" to "parametric via delegation." This is the whole
posture in miniature: **adorn does not reinvent generation; it projects its descriptors onto a library that
already does it.** The caveats are fast-check's and should be inherited honestly — older fast-check couldn't
invert `\p{…}`; an unanchored pattern matches a *substring*, which is already the author's stated
responsibility (string.ts: *"Anchoring is the author's business"*); and `g`/`y` flags are already refused at
authoring time (string.ts `toPatternSpec`), which happens to be exactly the hygiene a generator wants too.

### 4.5 Where the boundary lands, in one paragraph

Bounded numbers and lengths generate **well** (parametric, sound by construction). Patterns generate **well
too, by delegating to fast-check's regex inverter**. `email`/`url` generate **honestly but partially**, as
curated samples rather than a pretence of generality. Everything with a repeated or relational constraint
generates by **filter**, soundly, and degrades exactly when the accepted set is a tiny slice of the type's
space. And any **hand-written predicate generates nothing** — the permanent Q-3 floor, consistent with those
same closures being invisible to every other projection. That sentence is the crux, and the tool's job is to
*say which bucket each parameter landed in* rather than to pretend the buckets don't exist.

---

## 5. The oracle

A generated input is only as useful as the question you can ask about the result (vision.md: *"A generated
input is only as useful as the question you can ask about the result"*). That question is the oracle, and
the oracle is postconditions.

### 5.1 The asymmetry that makes the oracle *easier* than generation

There is a structural fact worth stating loudly because it changes the sequencing: **generation must
*invert* a constraint; an oracle only has to *run* one.** Inverting `matches(/^a+$/)` into a generator is
hard (Q-3); *evaluating* whether a returned string matches `/^a+$/` is trivial and always possible. So while
preconditions must be *reified descriptors* to be generated from, **postconditions can be black-box closures
and still serve perfectly as oracles.** The Q-3 black-box problem is a *precondition* problem; it does not
bite on the oracle side. This is why the weaker mode (§5.3) is shippable and why postconditions, once they
exist in any form, immediately unlock full-mode fuzzing.

### 5.2 What the fuzzer needs from the postcondition work (the hand-off)

A separate agent is designing postconditions. Treated as the oracle input, here is precisely what the
fuzzing projection needs from that design — stated as requirements, not as a design of postconditions:

1. **An evaluation interface, total.** Something the fuzzer can call as
   `evaluate(post, {result, args, receiver, old}) → boolean` that returns `false` on violation rather than
   throwing — or an explicit convention that a *throwing* postcondition is itself a finding. Predicate
   totality was already made a first-class property for *preconditions* (BUG-4, P3.3 — "a fuzzer feeds it
   `null` in the first hundred cases"); the oracle needs the same guarantee or a documented convention,
   because a postcondition that throws on a surprising result is indistinguishable from the bug it was
   meant to catch.
2. **A decision on prior-state capture (`old()`).** Many useful postconditions compare against pre-call
   state ("balance decreased"). The postcondition agent owns *how* that snapshot is taken; the fuzzer only
   needs a defined way to obtain `old` and pass it in. (Contracts must stay pure — contract-driven-development.md
   §2.5 — which matters doubly under fuzzing, where the oracle runs thousands of times.)
3. **A reified form where possible.** A postcondition that is *also* data (an identity + a message, like a
   `ConstraintDescriptor`) lets the scope report *name what it checked* — "verified `result` is sorted" —
   instead of only "oracle passed." Not required for the oracle to *function* (per §5.1), but required for
   the report to be honest about *which* guarantees were exercised.
4. **A note on the current slot's type.** `post` is typed `ReadonlyArray<ConstraintDescriptor>` today
   (ContractRegistry.ts). A `ConstraintDescriptor` is a *single-value* predicate (`(value) => boolean`); a
   real postcondition ranges over `result` **and** `old` **and** `this`. So the reserved slot is very likely
   *under-typed* for genuine postconditions — flagged here as a question the postcondition agent should
   settle, because the fuzzer reads whatever shape they choose.

### 5.3 The weaker mode is worth shipping first — and it is stronger than "didn't throw"

**Proposed.** Ship a fuzzing mode *before* postconditions exist. This is not a consolation prize; it is how
the generation foundation gets exercised end-to-end at low risk — the same move that made the **documentation**
projection the first one built (*"proved the architecture end to end at the lowest available risk"*,
schema.ts header, IDEA-7). Without an output oracle, a generated input can still assert two real things:

1. **Robustness — it doesn't throw an unexpected error.** This is what "fuzzing" classically means:
   crash-finding. It needs only the *generation* half of the foundation, so it validates §4 in isolation.
2. **Invariant preservation — it doesn't corrupt the object's own state.** This is the part usually missing
   from "it didn't throw," and adorn *already has it*: DEC-021 established that **a field constraint is a
   class invariant** ("guards every assignment for the object's whole life… invariants are covariant"). So
   the weaker oracle available *today*, with zero dependency on the postcondition work, is: **generate
   inputs that satisfy a method's preconditions, run the method, then re-check every field contract on the
   receiver.** If a decorated method leaves a `@Enforce`-constrained field out of bounds, that is a genuine
   finding — a real invariant violation, not merely a crash.

So the weaker mode's assertion is *"for all precondition-valid inputs, the method neither throws unexpectedly
nor violates any field invariant."* That is meaningfully more than crash-fuzzing, it ships without blocking
on Q-11/IDEA-4, and it must be **labelled as weaker** so a green result is not over-read (§7, §8). It is the
right first landing.

---

## 6. fast-check integration and dependency posture

### 6.1 What adorn contributes, and what it must never reinvent

**Proposed.** The division of labour is strict:

- **adorn contributes:** the generators (from descriptors, §4) and the oracle (§5). That is all.
- **fast-check contributes:** the property-checking loop, **shrinking**, **seeding**, and **replay** — all
  verified capabilities ([fast-check](https://www.npmjs.com/package/fast-check),
  [jrsinclair](https://jrsinclair.com/articles/2021/how-to-get-started-with-property-based-testing-in-javascript-with-fast-check/)).
  adorn builds none of these and should resist any temptation to. Reproducibility in particular is *inherited
  for free*: because generators are pure functions of frozen params (DEC-010), the only source of randomness
  is fast-check's seed, so "same seed → same run" holds without adorn doing anything.

The wiring: a new `src/Projections/arbitraries.ts` (the name Descriptor.ts already anticipates) reads each
descriptor's `arbitrary()` hook off the same registry seam schema.ts uses, composes per-parameter arbitraries
into a method-level `fc.tuple(...)` over the argument list (gap-filling undecorated positions with a broad
arbitrary, mirroring schema.ts's `{}` / `prefixItems` gap-fill and its arity caveats, Q-10), and hands the
tuple to fast-check together with the oracle as the property body. The single type change on the core side is
the one Descriptor.ts pre-committed to: **narrow the `Arbitrary = unknown` alias to `fc.Arbitrary<unknown>`
in exactly one place** when the bridge lands.

### 6.2 fast-check is a peer/optional of a *testing add-on*, never core — the DEC-019 lesson

**Verified (repo).** This project has already paid, in full, for putting an optional dependency in the wrong
place. `rxjs` was demoted to an optional peer, but `require('adorn')` *still failed* with `MODULE_NOT_FOUND:
rxjs` because `index.ts` eagerly imported `@Memoize`, which eagerly required `rxjs` (DEC-019). The resolution
was to **remove `rxjs` and `@Memoize` from core entirely** and record the reactive future as a *separate
package*, `@adorn/rx` (GAP-6, IDEA-8): *"a separate module with added functionality that ends up including
it."*

**Proposed.** fast-check gets exactly that treatment, and for exactly that reason:

- **Core stays clean.** Core keeps only the shape-only `arbitrary` hook typed `unknown`. It imports
  fast-check **nowhere**. `require('adorn')` must never pull fast-check, the same bar GAP-6 set for rxjs
  (CI even asserts rxjs is *absent* — GAP-4).
- **The testing surface is a separate opt-in package** (`@adorn/test` or similar), which takes `fast-check`
  as a real dependency — which it may, being opt-in — and *there* narrows the `Arbitrary` alias and imports
  fast-check. This is the `@adorn/rx` shape reused, and it keeps the "four artifacts from one declaration"
  promise honest: docs and schema ship in core with no third-party runtime dependency; **tests/fuzzing ship
  in an add-on**, because they are the projections that need a peer.
- **If any in-core entry point is ever wanted** (e.g. an `adorn fuzz` CLI command alongside IDEA-9's
  `adorn docs`/`schema`/`check`), it must reach fast-check through a **guarded lazy `require`**, the pattern
  `@Time` already uses for rxjs in `loadObservable()` (degrading to a clear error when absent), never a
  top-level import. But the separate-package posture is the primary recommendation; the lazy-require is the
  fallback for a single CLI seam.

The layering rule (DEC-012) is consistent with this: a projection may depend on `Core/`+`Contracts/`, and the
add-on package is a projection consumer that *additionally* depends on fast-check — it never asks core to.

---

## 7. Honest limits, and the warn-vs-trust line (where the philosophy lives)

This is the section the user cares about most: *"protecting devs from themselves is a slippery slope."* The
design must be honest about limits and warn where warranted — and then **stop**, and trust. The organising
test, drawn straight from DEC-020's *"put the decision where the information is"*:

> **Warn about what the developer cannot see at the point of decision. Trust them with what they can.**
> A risk that is hidden, silent, and irreversible earns a warning. A risk that is the developer's own
> visible, deliberate choice earns capability and silence.

### 7.1 The honest limits — state them, in plain words, in user docs

Per DEC-025's ruling that a boundary *"belongs in user-facing documentation in plain words, not buried in a
decision log"* (the exact instruction it gave for the PII boundary), these must be said out loud where users
read them:

- **Partial coverage by construction (Q-3).** "Decorate your code, get a fuzz suite" is *not* what this is.
  It fuzzes contracted parameters well, filters where it can, and declines hand-written predicates. The scope
  report is the mechanism that makes this honest rather than a surprise.
- **"adorn fuzzed this and found nothing" ≠ "adorn proved this correct."** adorn **never** does the latter.
  Property-based testing *samples*; it does not *verify* ([Hypothesis](https://hypothesis.readthedocs.io/en/hypothesis-python-4.57.1/healthchecks.html)).
  This is the single most important sentence to put in front of users, and it is the direct analogue of
  DEC-025's *"do not let 'adorn protects your PII' become the shorthand"* — do not let "adorn tested this"
  become "adorn guarantees this."
- **Weak mode is weak.** "Passed weak-mode fuzzing" means "no generated input crashed it or broke a field
  invariant," not "it returns correct answers." The report must distinguish weak-mode from postcondition-mode
  runs so a green check cannot be over-read — the same false-confidence discipline as the sensitive-flow
  scope report (DEC-028 point 3).
- **Generate-and-filter can starve.** A narrow filtered constraint may reject almost every candidate, so
  "10,000 cases, no failures" can secretly mean "200 real cases, no failures." This one deserves an *active*
  warning, not just a doc line — see §7.2.

### 7.2 What is warranted to warn about (the risk is hidden from the developer)

- **Filter starvation.** Copy Hypothesis's `filter_too_much` in spirit: when a generator rejects far more
  than it keeps, *tell the developer*, because the distortion is invisible from the outside and silently
  guts the run's value. This is information that helps them (write a custom generator, widen the constraint),
  not a rail that blocks them.
- **Running side-effecting methods under fuzzing — the sharpest one.** Fuzzing *executes the real method*,
  thousands of times, with generated inputs. If that method sends email, charges a card, or writes to a
  database, the consequence is real and irreversible and the developer may not have thought it through at the
  moment they pointed the fuzzer at it. This earns a **loud, up-front warning** — it is a genuine foot-gun
  whose blast radius is hidden — of the same seriousness the repo assigns a live PII exposure.
- **The scope boundary itself.** Every run must print *what it did and did not fuzz* (which parameters were
  parametric / filtered / declined; which oracle was used). A tool that stays silent about its own coverage
  produces exactly *"the false confidence the redaction plan calls worse than no design"* (DEC-023
  consequences). The scope report is a *condition of shipping*, not a nicety — the standard DEC-028 point 3
  already set for the sensitive-flow detector.

### 7.3 Where to stop warning and just trust (the risk is the developer's visible choice)

This is the half the philosophy insists on, and it is where a lesser design would over-reach:

- **Custom generators may be unsound — trust the override.** When adorn cannot derive a generator, the
  developer supplies one (clojure's `s/with-gen`, [clojure.org/about/spec](https://clojure.org/about/spec)).
  adorn *may* offer a cheap, opt-in sanity check (sample the custom arbitrary, confirm it satisfies the
  constraint's real predicate — which is trivially available), but it must **not** enforce soundness on a
  developer's own generator. Overriding is a deliberate, visible act; DEC-021 already ruled that *"a warning
  that fires on correct code is worse than none."*
- **Impure or expensive predicates/postconditions — document, don't detect.** Purity matters
  (contract-driven-development.md §2.5), but detecting impurity is undecidable and intrusive. Say it in the
  docs; do not build an effect-analyzer to police it.
- **No nanny rails on generation.** No mandatory case caps, no refusing to fuzz "risky-looking" methods, no
  opt-in ceremony beyond the obvious act of asking to fuzz. Opting in *is* the consent.
- **Do not sandbox execution or try to prove a method safe to run.** This is the decisive trust call and it
  follows directly from DEC-025's *bounded* responsibility. adorn cannot know which methods are safe to call
  ten thousand times, and it should not try — that is unbounded, the way "prevent all PII leaks" was
  unbounded. adorn's obligation is to **warn clearly** that fuzzing runs real code (§7.2) and then **trust
  the developer** to aim it at pure, safe methods. It secures *its own* output (sound generation, honest
  reporting); it does not police the developer's method bodies. That is the same line DEC-025 drew for
  emissions, applied to execution.

The through-line: adorn is honest to the point of printing its own blind spots, warns loudly about the two
things a developer genuinely cannot see coming (silent starvation, real side effects under mass execution),
and then gets out of the way. It provides a powerful capability and trusts the person holding it.

---

## 8. What a developer expects vs. what they get (managing the gap is the whole game)

**Expectation:** "I decorated my methods; give me a suite that finds my bugs." **Reality**, and where each
diverges — managing this gap *honestly* is the entire deliverable:

1. **Only contracted parameters generate.** A method with one `@Between` parameter and three plain ones is
   only meaningfully fuzzed on the one. Undecorated positions fall back to a broad arbitrary or, where arity
   is unknown (Q-10), can't be filled at all.
2. **Without postconditions, it finds crashes and invariant breaks, not wrong answers** — and "wrong answer"
   is what most people *mean* by "bug." The weak/full-mode label (§7.1) is how this stops being a surprise.
3. **Hand-written predicates generate nothing** — so the methods a careful developer wrote a bespoke check
   for fuzz the *worst*. This inversion is counter-intuitive and must be stated (§4.2).
4. **It samples; it does not prove** (§7.1).

The tool cannot close these gaps — they are structural (Q-3, Q-5, Q-10). What it *can* do, and what "done
right" requires, is **refuse to let the expectation quietly exceed the reality**, by making the scope report
a first-class output: every run says what it generated, how, and what it checked. That is the same discipline
DEC-025 and DEC-028 already committed the project to elsewhere; fuzzing is where it matters most, because a
green fuzz result is the most over-readable artifact the library will ever produce.

---

## 9. Phased sketch

Conceptual sequence, not a schedule. Each phase assumes the last.

- **Phase A — the foundation lands (blocked on nothing but fast-check as an add-on dependency).**
  Build `Projections/arbitraries.ts`: parametric generators for every built-in numeric and string
  constraint (§4.2), `stringMatching` for `matches` (§4.4), curated generators for `email`/`url`, filter
  fallback with starvation reporting, decline for black boxes. Compose per-method tuples and hand them to
  fast-check for the loop/shrink/seed/replay (§6). Oracle = **weak mode**: doesn't-throw **plus** field-
  invariant preservation, which needs no postcondition work (§5.3). Ship the **scope report** (§7). Narrow
  the `Arbitrary` alias in one place. This proves the generation architecture end-to-end at the lowest risk,
  exactly as docs proved the projection architecture (IDEA-7).

- **Phase B — the oracle arrives (blocked on postconditions, IDEA-4 / Q-11).**
  With a `post`-slot writer and the evaluation interface of §5.2, fuzzing gains a *real* oracle and full mode
  becomes possible — "the declaration supplies the generator, the guarantee supplies the oracle"
  (vision.md mid-horizon) finally holds. Cross-parameter preconditions (the `pre` slot, IDEA-6) improve
  generation for relational constraints via tuple-filtering or smart constructors. `old()` state capture
  lands with the postcondition design.

- **Phase C — far horizon.**
  A `with-gen`-style custom-generator registry for constraints adorn cannot derive
  ([clojure.org/about/spec](https://clojure.org/about/spec)); a persisted failing-example corpus so a found
  counterexample stays pinned (Hypothesis's `.hypothesis/` database,
  [Hypothesis](https://hypothesis.readthedocs.io/en/hypothesis-python-4.57.1/healthchecks.html)); fast-check
  **model-based testing** for stateful invariant sequences
  ([fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)); and an
  `adorn fuzz` CLI command as the delivery vehicle (IDEA-9's pattern). Vision.md's far horizon — contracts
  across service boundaries — sits beyond even this.

---

## 10. Open questions this raises (hand-offs, not resolutions)

- **Postcondition slot typing (§5.2, point 4).** Is `post: ReadonlyArray<ConstraintDescriptor>` rich enough
  for postconditions that range over `result`, `old`, and `this`? Likely not — a question the postcondition
  agent owns, and one the fuzzer's oracle interface depends on.
- **Add-on package vs. lazy-require seam (§6.2).** Primary recommendation is a separate `@adorn/test`
  package; the lazy-require pattern is the fallback for an `adorn fuzz` CLI seam. Which ships first is a
  packaging call adjacent to IDEA-8's `@adorn/rx`.
- **Q-5 stands.** Postcondition *expressiveness*, not plumbing, is the real difficulty — *"useful
  postconditions often need prior state and can be as hard to write correctly as the implementation they
  describe."* No amount of generation quality fixes a weak oracle; adoption may stall there regardless, and
  the honest framing (§7, §8) is what keeps that from becoming a broken promise.
- **Arity (Q-10)** still bounds how completely a method's argument tuple can be generated; the same limit
  that blocks a faithful OpenAPI emitter blocks full-tuple generation.

---

## 11. References

**adorn (this repo).** `docs/vision.md` (north star; the four projections; mid-horizon oracle);
`docs/DECISIONS.md` — DEC-006 (contracts as single source), DEC-010 (predicates derived from params),
DEC-012 (projection layering), DEC-018 (two-band registry read), DEC-019 (optional-peer packaging lesson),
DEC-020 (put the decision where the information is), DEC-021 (field constraints are class invariants),
DEC-022 (method precondition union), DEC-025 (bounded responsibility; state the boundary in plain words),
DEC-028 (scope report as a shipping condition); `docs/ISSUES.md` — Q-3 (arbitraries for hand-written
predicates unsolved), Q-4 (descriptor/predicate drift), Q-5 (postcondition expressiveness), Q-10 (arity),
Q-11 (`pre`/`post` have no writer), IDEA-3 (integrate fast-check), IDEA-4 (postconditions), IDEA-6
(cross-parameter), IDEA-8 (`@adorn/rx` add-on pattern), SMELL-14 (`CreateSimpleDecorator` closures bypass the
registry); `src/Core/Descriptor.ts` (the `arbitrary` hook, shape-only); `src/Core/ContractRegistry.ts` (the
reserved `pre`/`post` slots); `src/Projections/schema.ts` (the projection template and the merge logic);
`src/Contracts/number.ts`, `src/Contracts/string.ts` (the constraints and their own notes on generability);
`docs/contract-driven-development.md` (DbC background; contract purity, §2.5).

**External (verified, accessed July 2026).**
- fast-check — npm overview. https://www.npmjs.com/package/fast-check
- fast-check — getting started (arbitraries, shrinking, seed/path replay), J.R. Sinclair. https://jrsinclair.com/articles/2021/how-to-get-started-with-property-based-testing-in-javascript-with-fast-check/
- fast-check — `stringMatching` API. https://fast-check.dev/api-reference/functions/stringMatching.html
- fast-check — 4.7.0 (`\p{…}` in `stringMatching`). https://fast-check.dev/blog/2026/04/18/whats-new-in-fast-check-4-7-0
- fast-check — model-based testing. https://fast-check.dev/docs/advanced/model-based-testing/
- clojure.spec — rationale and overview (generators derived from predicates; `gen` throws where it cannot; `s/and` filters; `with-gen`; `fdef`/`check`). https://clojure.org/about/spec
- Practicalli — generative testing with spec (`check` generates ~1000 arg sets, asserts `:ret`/`:fn`). https://practical.li/clojure/clojure-spec/generative-testing/
- Hypothesis — health checks (`filter_too_much`), `assume()`, `.hypothesis/` database, shrinking. https://hypothesis.readthedocs.io/en/hypothesis-python-4.57.1/healthchecks.html
- icontract-hypothesis — infer strategies from preconditions; three-tier cascade; "the inferred strategy must satisfy the preconditions"; postconditions as oracle. https://github.com/mristin/icontract-hypothesis
