# Feedback — adopting adorn in `AiVoiceAgent-node`, 2026-08-17

**What this is.** A ledger from a real adoption, not a review. `AiVoiceAgent-node` is a
campaign/goal framework for LLM-driven phone calls; it adopted adorn descriptor-first at its
classifier boundary on 2026-08-17 and **stopped wherever adorn did not fit, rather than working
around it** — which is why each entry below has a live call site attached rather than a hypothetical.

**How to use it.** Each item is a checkbox with the evidence that produced it, a reproduction, and a
specific suggestion. Tick it off when the library changes. Items are independent; L3 is the one that
actually blocked an adoption and is the highest value.

Version under test: **`adorn@0.1.0`**, installed as `file:../adorn`. Consumer is TypeScript 6.0.3,
`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, readonly-everywhere, zero
classes, zero module-scope mutable state.

| #   | Item                                                   | Blocks adoption? |
| --- | ------------------------------------------------------ | ---------------- |
| L1  | `npm i adorn` installs a security-holding placeholder | Install          |
| L2  | `OneOf` projects without `type`                       | No               |
| L3  | `toolSchemaFrom` returns `JsonObject`                 | **Yes**          |
| L4  | Decorators cannot reach runtime-known constraints     | Docs             |
| L5  | `check` validates but does not normalise              | No               |
| L6  | Ambient configuration is process-global               | **Yes**, for half the library |

---

## adorn dispositions — 2026-08-16 (DEC-072 / DEC-071)

Triaged critically against a live consumer; thank you — the per-call-site evidence made every verdict easy to
ground. Landed on `master` (unreleased); the two code fixes are type-only and change no runtime behaviour.

| #   | Verdict | What we did |
| --- | ------- | ----------- |
| L1  | **Acting — at publish** | Owner asserts rights to the `adorn` name; publishing `0.1.0` replaces the placeholder. We'll `npm owner ls adorn` at publish and, if the security stub blocks the overwrite, contact npm support (not renaming/scoping). Until 0.1.0 is live, `file:../adorn` is correct. |
| L2  | **Done** | Homogeneous `OneOf` now emits `{type, enum}`; heterogeneous stays `{enum}`. Also fixes a latent strict-mode gap and a `Nullable(OneOf)` null-rejection bug we caught while doing it. |
| L3  | **Done** (highest value) | `ToolSchema` is now a structured, `readonly` interface — you can read/spread `.properties` and `.required` and extend a schema without casting. Declaration-only; runtime unchanged. |
| L4  | **Done (docs)** | Added a prominent README callout on runtime-known constraints pointing to `toolSchemaFrom` (ships when the re-framed README publishes). This is the item that most changes who adopts — see note below. |
| L5  | **Declined — by design** | adorn is a validator, not a coercer (stated scope). A delimited-string is a transport concern, not a contract; keep the split in your parser. Rationale below. |
| L6  | **Deferred — documented, not built** | The `set*` family is process-level *startup* config, safe when set once. The real gap (per-concurrent-context policy) is narrow, isn't your need here, and is a large redesign. Reframed below rather than built. |
| note | **Done** | The dead `DECISIONS.md → ISSUES.md` pointer is corrected. |

---

## What worked, first — because a friction list alone is misleading

- [x] **`Verify.check` returning `CheckResult` rather than throwing is what made the adoption
      possible at all.** The consumer's DEC-018 requires typed failures; a throw at this seam would
      be a crash on a live phone call for the most ordinary kind of model error. `path` and
      `expected` let a bad *element* of a list be named without the container-level message wrongly
      claiming the whole field should have been something else. This is the single most valuable
      thing in the library for this class of consumer.
- [x] **`ArrayContracts.ArrayOf(EnumContracts.OneOf([...]))` composes exactly as needed** for
      per-turn enums.
- [x] **One runtime dependency (`tslib`).** The consumer's own DEC-032 had recorded two; that figure
      was wrong and has been corrected on their side.

---

## L1 — `npm i adorn` installs npm's security-holding placeholder

- [ ] **Publish under an available name, or scope it, and correct the README.** *(acting — resolves at publish)*

> **→ adorn:** Correct and important — thank you for catching that `npm i adorn` silently installs the
> `0.0.1-security` placeholder. The owner has confirmed they hold rights to the `adorn` name, so the plan is to
> publish `0.1.0` over the placeholder (not to rename or scope), verifying with `npm owner ls adorn` at publish
> and escalating to npm support if the security stub blocks the overwrite. The README install line stays
> `npm i adorn`. Until 0.1.0 is live, `file:../adorn` remains the right consumer setup. This box ticks when
> 0.1.0 is on npm.

**Evidence.** The README's install line is `npm i adorn`. Running it installs:

```json
{ "name": "adorn", "version": "0.0.1-security",
  "description": "security holding package", "dependencies": {} }
```

No code. This is npm's placeholder for a reserved name. Removed it and installed `file:../adorn`
instead, which works.

**Why it matters more than it looks.** It is the first thing every reader does, it fails silently
(the install succeeds), and the failure mode is a package that appears to exist and export nothing.
A reasonable person concludes the project is abandoned or the README is stale.

**Suggestion.** `@natwhite/adorn`, or another free name, plus a README correction. Worth doing before
anything else here, because nothing else is reachable until it is.

---

## L2 — `OneOf` projects without `type`

- [x] **Emit `type` alongside `enum` when the members are homogeneous.** *(DEC-072)*

> **→ adorn:** Done. `OneOf(['a','b'])` now projects `{type:'string', enum:['a','b']}`; `OneOf([1,2])` →
> `{type:'number', enum:[1,2]}`. A heterogeneous enum (`['a', 1]`) has no single true `type`, so it still
> emits `{enum}` alone. You were right that the first strict-mode consumer would hit this — and it was us:
> under our own `providerStrict` (DEC-071) a bare `@OneOf` param had no `type`. Doing this also surfaced a
> genuine bug: `Nullable(OneOf([...]))` would have widened to `{type:['string','null'], enum:[...]}`, which
> **rejects null** (an `enum` binds across both type branches); fixed so it stays an exact `anyOf`.

**Evidence.**

```ts
toolSchemaFrom({params: {slotId: EnumContracts.OneOf(['slot-fri-1000', 'slot-thu-1400'])}})
// {"type":"object","properties":{"slotId":{"enum":["slot-fri-1000","slot-thu-1400"]}}, ...}
```

The hand-written projection it replaced emits `{"type":"string","enum":[...]}`.

**Not a blocker, and this was verified rather than assumed.** Both shapes were sent down the same
`response.create` path the consumer's classifier actually uses, against the **live OpenAI Realtime
API**, with the same utterance. **Both were accepted, and both produced the identical tool call** —
`{affirmed:["alice"], denied:["bob"]}`.

**Why still worth changing.** `type` is what the rest of the ecosystem emits, and OpenAI's **strict**
mode documents it as required per property. This consumer does not use strict mode; the first one
that does will hit it, and the symptom will be a schema rejection rather than anything pointing back
here. Purely additive — nothing that accepts the current output would reject the fuller form.

---

## L3 — `toolSchemaFrom` returns `JsonObject`, so a projected schema cannot be composed

- [x] **Give the projections a structured return type.** *(highest value — this stopped an adoption; DEC-072)*

> **→ adorn:** Done, essentially as you proposed:
>
> ```ts
> export interface ToolSchema {
>     readonly type: 'object';
>     readonly properties: Readonly<Record<string, JsonValue>>;
>     readonly required: readonly string[];
>     readonly additionalProperties: false;
>     readonly title?: string;
>     readonly description?: string;
> }
> ```
>
> Both call sites you hit now type-check without casting: you can spread `.properties`, iterate/extend
> `.required`, and a `readonly []` satisfies it. Declaration-only — the runtime already always emitted exactly
> this shape. Your framing was the deciding argument: a `JsonObject` alias for the library's *own* guaranteed
> shape reintroduced the very drift adorn exists to remove. `ClassSchema` stays `JsonObject` (it is genuinely
> arbitrary JSON; a tool schema is not).

**Evidence.** `export type ToolSchema = JsonObject`. A consumer can build a schema but cannot read
`.properties` or `.required` off it in a typed way, and cannot extend one without casting.

Two live call sites need exactly that, and both are ordinary things to want:

1. **Add one property to every tool uniformly.** The consumer splices a `callerTone` telemetry field
   into each tool's `properties` and appends it to `required`, so it biases no option over another:

    ```ts
    parameters: {
        ...tool.function.parameters,
        properties: {...tool.function.parameters.properties, [TONE_FIELD]: {...}},
        required: [...tool.function.parameters.required, TONE_FIELD],
    }
    ```

    Against `JsonObject`, `parameters.properties` is `JsonValue | undefined` — TS2698 _"Spread types
    may only be created from object types"_ — and `required` has no iterator (TS2488).

2. **Declare an argument-less tool as a `readonly` literal.** `JsonObject`'s mutable index signature
   rejects `readonly []` for `required` (TS2322).

**Consequence.** The consumer kept hand-building its `properties` and adopted only the validation
half. The schema and the check therefore still descend from the consumer's own type rather than from
one adorn declaration — which is the exact drift the library exists to remove, left in place by a
type annotation.

**Suggestion** — declaration only, no runtime change:

```ts
export interface ToolSchema {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, JsonValue>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
    readonly title?: string;
    readonly description?: string;
}
```

`readonly` throughout matters: the stated audience is `strict` TypeScript codebases, and those tend
to be readonly-first. A `JsonObject` alias is the right type for *arbitrary* JSON; a tool schema is
not arbitrary, and its shape is the library's own guarantee.

---

## L4 — decorators cannot reach constraints known only at runtime, and the README does not say so

- [x] **Add a README section on runtime-known constraints, leading with `toolSchemaFrom`.** *(ships with the re-framed README)*

> **→ adorn:** Agreed, and this is the item we weighed hardest — it pushes against a deliberate positioning
> choice (decorators are the paradigm; the descriptor surface is the escape hatch). Your evidence is the
> strongest argument on the other side: for LLM tool-calling with per-call values — a large share of real
> usage — the flagship decorator example *cannot be written at all*, so the "escape hatch" is the main road.
> We've resolved it without abandoning the paradigm: a prominent callout in the flagship section —
> *"Permitted values known only at runtime?"* — now points straight at `toolSchemaFrom` and the "Working with
> values directly" section, so the fit is obvious on first read. (The re-framed README isn't published yet;
> this lands with it.)

**Not a defect.** `toolSchemaFrom` exists precisely for this and its own doc comment describes the
case almost verbatim. This is a documentation gap, and it is the largest one.

**Evidence.** Every constraint in this consumer is per-call data: the permitted values for `subjects`
are *this household's* patient ids; for `slotId`, *this turn's* available slots. A decorator is fixed
when the module loads. So the flagship example — `@OneOf(['celsius','fahrenheit']) unit: string` —
**cannot be written at all** in this application, and the owner's explicit preference for decorators
over descriptors could not be honoured anywhere.

**Why it cost time.** The README leads with the static case and presents decorators as the paradigm;
`toolSchemaFrom` appears only in the export list. The evaluation therefore ran a long way toward
"adorn does not fit this shape of application" before finding the API that makes it fit. A short
section — *"when the permitted values are known only at runtime"* — would have made the fit obvious
on first read. Consider it the second-most-valuable item here after L3, because it changes who
adopts rather than what they can build.

---

## L5 — `check` validates but does not normalise, and transports usually have two encodings

- [ ] **Add a coercion hook**, e.g. `ArrayOf(item, {fromDelimited: ','})` or a `Verify.coerce`. *(declined — by design)*

> **→ adorn:** Declining this one, on principle rather than effort. adorn is deliberately *a validator, not a
> coercion library* — it rejects an invalid value, never transforms one (it's a stated scope boundary, and the
> README leads with it). A comma-vs-array encoding is a **transport** concern, not a **contract**: which
> encodings a wire tolerates is your parser's knowledge, and `{fromDelimited:','}` would push transport
> decoding into the constraint model, blurring exactly the line that keeps a constraint a pure
> predicate-plus-schema. Your drift point is fair — but the honest fix is to decode *once* in your parser and
> hand the array to `check`, so the split rule lives in one place (the parser), not two. If a first-class
> "decode then validate" story is ever warranted it belongs in a separate seam (a `coerce` that is visibly not
> `check`), never as a silent option on a constraint — and we're not persuaded it's needed yet.

**Evidence.** Multi-valued fields arrive here two ways: as an array (what the schema declares) or as
a comma-separated string (deliberately tolerated, with tests pinning it). `Verify.check` validates
what it is handed, so the consumer must split before checking:

```ts
const value = multi.includes(field) && typeof supplied === 'string'
    ? supplied.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : supplied;
```

That duplicates the splitting rule its own parser uses.

**Minor** — four lines. Recorded because "one declaration, no drift" is the library's whole argument,
and a splitting rule that now exists in two places is a small instance of the thing it is against.
This one was caught by a test failure, not by review: the first version of the check rejected the
string form, which is a supported answer.

---

## L6 — ambient configuration is process-global mutable state

- [ ] **Offer per-instance configuration** — a context object, or a configured `Verify` factory. *(deferred — documented, not built)*

> **→ adorn:** A real observation, and we're glad this adoption steers clear of the whole family. Two things,
> though. First, a reframing: the `set*` functions are **process-level startup configuration** (enforcement
> mode, violation policy, the OTel sink, disclosure) — meant to be set once at boot, not mutated per request.
> Set that way, concurrent calls don't interfere; the "one call changes another mid-call" hazard only arises
> if you *mutate* them at request time, which isn't the intended use. The part of adorn you actually adopted —
> `Verify.check` and the `*Contracts` namespaces — is pure and has no ambient state at all, which is why it fit
> your zero-mutable-state rule cleanly. Second, the genuine gap that remains: **divergent policy per concurrent
> context** (call A wants `throw`, call B wants `warn`) is not expressible, and that is real. But it's a narrow
> need, not yours here, and closing it is a substantial redesign of the configuration model. So: we'll
> **document** the process-level-startup intent and name the per-context limitation explicitly, rather than
> build a per-instance config surface now. A configured `Verify`/context factory stays on the table for when a
> consumer actually needs divergent per-context policy.

**Evidence.** `setViolationPolicy`, `setEnforcementMode`, `setObservationSink`, `setDefaultTrust`,
`setValueDisclosure` and friends are module-global and mutable. This consumer handles **concurrent
phone calls in one process** and has audited itself to have **no module-scope mutable state at all**
— zero `let`/`var`, seven frozen lookup tables — precisely so two calls cannot affect each other.

One call changing enforcement policy would change how another call's contracts behave, mid-call.

**This adoption uses none of that family** — only `Verify.check` and the `*Contracts` namespaces,
which are pure — and the consumer has a standing rule that nothing a reducer can reach may touch it.

**Why it is worth raising as more than a preference.** As it stands, roughly half the library's
surface is unavailable to *any* concurrent server application, which is a larger constraint than its
absence from the documentation suggests. A reader evaluating adorn for a server will not discover
this until they are deep enough to have committed.

---

## One thing noticed in passing

- [x] **`docs/DECISIONS.md` points at `ISSUES.md`, which does not exist.** Its maintenance
      convention reads _"Bugs, smells, and gaps go in [ISSUES.md](ISSUES.md) instead"_, and there is
      no such file in the repo. Either the file is owed or the pointer is.

> **→ adorn:** Fixed the pointer. `ISSUES.md` is deliberately kept out of the published repo (it's process
> exhaust, not product); the convention line now says the issue log is maintained outside this repository
> rather than linking a file that isn't here.
