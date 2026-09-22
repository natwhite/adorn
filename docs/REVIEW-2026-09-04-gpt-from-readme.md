# External review — GPT, from the README alone (2026-09-04)

**Source:** a GPT model, given only `README.md` (no source, no tests, no `dist`). ~90s.
**Nature:** a *positioning* review, not a consumer bug report. Because the reviewer never
ran the library, nothing here is a discovered defect in behaviour — every criticism is
either (a) something the README **states too strongly**, or (b) a **forward-looking
architecture opinion**. That distinction is the headline finding, and it is a good result:
a sharp adversarial reader with only the marketing copy found **no false claim about what
the code does** — only three over-strong framings and a set of pre-1.0 design directions.

The praise is worth recording too, because it lands on the thesis: *"the descriptors are
the real library and the decorators are an ergonomic syntax layer over them … constraints
as reified data, with multiple projections derived from that data … is much more
interesting than 'validation using decorators.'"* That is DEC-006 read back to us by an
outsider who was not told to believe it. It also correctly singled out the pieces that
signal thought-beyond-the-demo: descriptive-vs-prescriptive schema, weaken-rather-than-
overclaim, nullable-vs-optional, closed-Shape-vs-open-Dictionary, caller/callee blame,
safe-by-default redaction, subpath add-ons, and the live-OpenAI capstone.

---

## Verdict table

| # | Reviewer's point | My assessment | Disposition |
| - | ---------------- | ------------- | ----------- |
| 1 | Descriptor model is the real core; decorators are sugar over it | **Right** — it is DEC-006 | Confirmation, no action |
| 2 | Built on legacy decorators; param decorators are `experimentalDecorators`-only; TC39 decorators don't support them | **Right, and important** | README framing note (A2) |
| 3 | "Constructor parameters can't carry decorators (TS1239)" is misleading | **Substantially right** | README honesty fix (A1) |
| 4 | "Don't drift by construction" is overstated | **Right about the unqualified claim** | README precision fix (A1) |
| 5 | 101 exports "frozen" at 0.1.0 is a warning sign | **Partly right** (misreads *which* surface is frozen; the *posture* critique lands) | Owner decision (B1) |
| 6 | Ambient global config → wants a `createContractRuntime()` object | **Right as a future direction, not a defect** | Owner direction (B2) |
| 7 | "strict" is a provider property; wants `{provider, strict}`; don't say "provider-neutral" | **Right as design; caution is preventive** | Recorded for provider #2 (B3) |
| 8 | Wants benchmarks | **Right — genuine gap** | Work item (C1) |
| 9 | Make the reified model constitutional, decorators the preferred adapter; drop the freeze posture now | **Agree** — it is where we already are, minus the framing | Synthesis of A2 + B1 |

---

## Point by point

### 2 — legacy decorators / portability. RIGHT, and the single most valuable structural note.
Parameter decorators (`@NotEmpty() location: string`) exist **only** under
`experimentalDecorators`; the TC39 standard decorators shipped in TS 5.0 do not cover
parameters, and TypeScript documents that split. So adorn's decorator *syntax* is tied to
the legacy model. The reviewer's own conclusion is the right one and is **already true of
our architecture**: the descriptor model does not depend on decorator syntax, and DEC-074
shipped the decorator-free path deliberately — `contract()`, `toolSchemaFrom`,
`defineConstraint`, `Verify.check`, functional observation. The gap is **framing**: the
README presents `contract()` as a "twin"/"analog"/"the fourth of four decorator jobs
available as a function," so a README-only reader concludes *decorators → everything* when
the real shape is *descriptors → {decorators, functional, projections}*. This is not an
architecture problem; it is a narrative one, and it is the review's best insight.

### 3 — "Constructor parameters can't carry decorators (TS1239)". SUBSTANTIALLY RIGHT.
Legacy TypeScript **does** support constructor-parameter decorators — every DI framework
(`@Inject()`) relies on it; the decorator simply receives `undefined` for `propertyKey`.
Our parenthetical already blames "the decorator signature," not TypeScript — more careful
than the reviewer credits — but the bald lead-in "**can't** carry decorators" reads as a
TypeScript prohibition, which it is not. The true statement: *adorn's* parameter-decorator
signature types `propertyKey` as `string | symbol` (and its registry keys off that key), so
a constructor parameter's `undefined` key yields TS1239. It is an **adorn** limitation,
fixable in principle (widen the signature + handle undefined-key registration), currently
**deferred** (job-agent §2.2). The static-factory pattern is the right recommendation
*today* — but as adorn's current shape, not as a workaround for something TypeScript forbids.

### 4 — "don't drift by construction". RIGHT that the unqualified claim overreaches.
Two counterexamples, both real:
- `foo(@Default(10) x = 20)` → the **schema** default is `10` (what `@Default` publishes),
  the **runtime** default is `20` (the TS default the body applies). They disagree with no
  error. DEC-086/087 actually *sharpen* this: the TS default is now authoritative for
  enforcement while `@Default` remains authoritative for the schema — so the two channels
  can legitimately diverge. The README's own gotcha box (lines 132–139) already documents
  the underlying fact ("a TS default is invisible to projections"); the tagline just
  doesn't inherit that honesty.
- `foo(@GreaterThan(0) x: string)` → the TS type says `string`, the contract says `number`.
  adorn cannot see the TS type at runtime (without `emitDecoratorMetadata`), so it cannot
  reconcile the two.

The tagline's "they … don't drift" refers to the *derived artifacts* (validation, schema,
docs, telemetry), which genuinely can't drift **from each other** — so the claim is true in
scope. But the unqualified phrasing invites exactly the broader reading the reviewer gives
it. The honest form is the reviewer's: *runtime enforcement and every generated projection
derive from one descriptor, so they can't drift from each other; the descriptor still has to
be authored to match the TS type and any TS default — channels adorn does not police.* This
is squarely our own "weaken rather than overclaim" ethos applied to our own headline.

### 5 — "101 exports frozen at 0.1.0". PARTLY RIGHT.
A partial misread: the "101 values" (line 7) are **pinned by a test** (a regression guard,
already de-"frozen"ed last round), not promised stable; only the **registry read surface**
(the `getContracts`/`getEffective…` family) is called "semver-frozen" (lines 296/302,
DEC-039) — a much narrower thing than 101 exports. But the underlying critique lands anyway:
"**semver-frozen** … at **0.1.0**" is in tension with semver itself, whose 0.x range is the
explicitly-unstable one, and boasting 101-at-0.1.0 reads as a warning rather than a
strength. The reviewer's instinct — *at 0.1.0 the freedom to delete a bad abstraction is
worth more than API stability* — is the right prior. The subpath suggestion (`adorn/tools`,
`adorn/schema`, `adorn/observe`) is a legitimate pre-1.0 option; note we already subpath the
two **add-ons** (`adorn/otel`, `adorn/test`), so the precedent exists — splitting the core
root is the larger, owner-level call.

### 6 — global config → runtime object. RIGHT as direction, not a defect.
The README already documents the concurrency limitation candidly (lines 290–294: mutating
global policy per-request in a shared process is unsafe and unsupported). The reviewer
grants this ("correctly acknowledges the concurrency problem"). `createContractRuntime({...})`
with the globals kept as a default-runtime convenience is a sound future shape and avoids
AsyncLocalStorage magic. Non-urgent by the reviewer's own grade ("acceptable now").

### 7 — provider-parameterized tool schema. RIGHT as design; the terminology caution is preventive.
`providerStrict: boolean` bakes "strict" as one boolean, but strict is a property of the
**OpenAI projection**, not of the contract. When a second provider lands, `{provider,
strict}` scales where a growing set of `providerXStrict` flags would not — aligns with
DEC-048/068–071. The "don't call it provider-neutral" caution is a guardrail we have not
actually tripped: the README says the enum target is one "several providers honour" and
labels OpenAI strict explicitly; it does **not** market the tool schema as provider-neutral.
Worth honouring the caution proactively. No change needed for single-provider 0.1.0.

### 8 — benchmarks. RIGHT — a genuine gap.
1,303 tests bound correctness, not cost. "Enforced at the boundary of **every** function
that carries one" (line 31) invites a performance question the docs don't answer. The
reviewer's own carve-out is fair (moot for LLM boundaries — the API call dominates by orders
of magnitude), but it matters for hot paths. A small benchmark suite — bare vs. contracted
call, nested `Shape`, a 1,000-element `ArrayOf`, deep inheritance, async `settle`, and
class-init/registry cost — would close it.

---

## Recommended actions

**A — small honesty fixes to the README (ready to apply on go; low risk; pure precision):**
- **A1.** Tighten "don't drift by construction" so its referent is the derived artifacts, and
  add a one-line scope caveat that the descriptor must still be authored to match the TS type
  and any TS default (cross-link the existing gotcha box). Reword the constructor-decorator
  bullet to attribute the limitation to adorn (fixable, deferred), not to a TypeScript
  prohibition; keep the static factory as the current recommended pattern.
- **A2.** Add a short framing note — the reified descriptor model is the constitutional core;
  decorators are the *preferred TypeScript adapter*, and `contract()` is a first-class
  decorator-free adapter over the same model — so a codebase can adopt adorn without buying
  into legacy decorators.

**B — owner-level decisions (surfaced, not taken):**
- **B1.** The 0.1.0 stability posture. Reconcile "pinned by a test" (line 7) with
  "semver-frozen read surface" (lines 296/302), and decide whether to claim *any* freeze at
  0.1.0 vs. "the surface we intend to hold through 1.0." Optionally: subpath the core root.
- **B2.** A `createContractRuntime({...})` object, globals retained as a default-runtime
  convenience — the isolation story for tests / workers / multi-tenant hosts. Post-0.1.
- **B3.** When provider #2 lands, migrate `providerStrict` → `{provider, strict}`; keep
  "provider-neutral" out of the tool-schema copy.

**C — work items:**
- **C1.** A benchmark suite (the cases in §8). Owner sets priority.

No code or README change is made by this document. A1/A2 await go; B/C are the owner's calls.

---

## Cross-links
- §4 (`@Default(10) x = 20`) is the same seam the job-agent hit at §2.1 and we resolved in
  DEC-086/087 — the reviewer rediscovered it from the README alone, independent corroboration.
- §2/§9 (reified core, decorators as adapter) is the direction DEC-074 already set with
  `contract()`; the finding is that the README under-sells it.

---

## Owner disposition — 2026-09-05

**A1/A2 applied** (commit `5ef08a0`): the drift claim is scoped to the derived artifacts with an
honest TS-type/TS-default caveat, the constructor-parameter bullet is re-attributed to adorn (a
deferred feature, not a TypeScript prohibition), and a framing note now names the reified
descriptor model as the core with decorators as the preferred adapter.

**B1/B2/B3/C1 reviewed and deprioritized.** An adversarial pass found the review's *diagnoses*
sharper than its *prescriptions*: the subpath restructure (B1) imports the add-ons' optional-dep
rationale into a `tslib`-only core that doesn't have that constraint, and the export pin *aids*
deletion rather than blocking it (only the narrow DEC-039 read surface is actually promised); a
runtime object (B2) buys test/component isolation but *not* the per-request divergence it was
pitched as fixing, absent AsyncLocalStorage the review rules out; the provider axis (B3) is
speculative generality on one data point — the honest cheap fix would be a rename, deferred; and
benchmarks (C1) are hygiene for a hot-path use adorn de-emphasizes, not a feature. As a
README-only review it surfaced no load-bearing concern. Parked; not tracked as work.
