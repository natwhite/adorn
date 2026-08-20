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
| L7  | `@adorn/otel` is unreachable from a consumer          | ~~Yes~~ — **fixed 2026-08-19** |
| L8  | The observation stream has no non-decorator emitter   | ~~No~~ — **documented 2026-08-19** |
| L9  | No descriptor-first twin for the contract decorators  | No — but it caps adoption at 25% |
| L10 | `check` cannot tell malformed JSON from a wrong shape | No — costs a misleading refusal |
| L11 | A `CheckResult` cannot become a `violation` event     | No — two streams that should be one |
| L12 | `consoleObservationSink` writes to `console.log`      | No — unusable on a stdout-is-product CLI |

---

## Round 2 — 2026-08-19, adopting the observation layer

Same consumer, two days on and **materially different**: the campaign/goal architecture described
above was deleted on 2026-08-19 (~20,000 lines). It is now a voice agent where a model holds the
conversation and the code owns the writes. The adorn surface in use is unchanged and still
functional-only — `toolSchemaFrom`, `Verify.check`, `ObjectContracts.Fields`, and the contract
factories. Still **zero classes**, still zero module-scope mutable state.

The owner asked for OpenTelemetry instrumentation across the codebase, routed through adorn's
observation layer. Two things stopped a clean adoption; L7 is the blocker, and it is a packaging
problem rather than a design one.

**Credit where it is due first:** `createOtelSink` consuming *only* the public `ObservationSink`
interface is what makes L8 a workaround rather than a dead end. Because the sink is a pure mapping
over a frozen public API, a consumer that emits well-formed observations by any means gets the OTel
projection for free. That isolation contract is doing real work here, exactly as `addons/otel/index.ts`
claims — this feedback exists *because* the design is right, not in spite of it.

---

## adorn dispositions — Round 2 (2026-08-19, DEC-073)

Both reviewed under the standing gate; both needed an owner decision (L7 revisited the "Core adorn only" 0.1.0
scope; L8 was a document-vs-new-API call). Owner decided both, and they are now **done on `master`**
(unreleased). Rebuild your `file:../adorn` copy to pick up L7.

| #  | Verdict | What we did |
| -- | ------- | ----------- |
| L7 | **Done** | `@adorn/otel` (and `@adorn/test`) now ship as opt-in **subpath exports** — `import { createOtelSink } from 'adorn/otel'`. Built into `dist/addons/**`; `@opentelemetry/api` / `fast-check` are **optional peer deps**; `require('adorn')` stays `{tslib}`-only (isolation tests re-scoped to the core + a positive "is built" check, all passing). No separate package to publish — you get it on the next rebuild of the `file:` dep. Verified: 0 peer requires in `dist/index.js`+`dist/src`, the peer require present only in `dist/addons/otel`. |
| L8 | **Done (docs)** | Documented the non-decorator emit pattern — `getObservationSink().record?.({ kind:'completed', observation, callId, … })`, the observation analog of `Verify.check` — in the README's observability section (ships with the re-framed README). `record` is the point-event surface (`completed`/`violation`/`message`); `scope` is the around-wrapper for span nesting. No new API; a blessed emitter stays on the table if the pattern proves common. Your credit on the pure-`ObservationSink` mapping is exactly why this is a doc, not a redesign. |

**→ adorn (2026-08-19, same-day close):** Confirmed both from your end — thank you for independently verifying
the isolation (`require('adorn')` = 96 exports / 0 otel-shaped) and for the end-to-end OTLP run. We folded your
one correction into the observability doc: it now states plainly that `scope` **opens** the span while the
correlated `completed` event **ends** it (matched by `callId`, DEC-047) — so a manual driver doesn't end it in
`scope` and flatten every async span. That was the exact trap the doc exists to prevent; good catch.

---

## adorn dispositions — Round 3 (2026-08-20, DEC-074)

Detail received; owner decided all four via the standing gate — **build `contract()`**, plus all three smaller
items. All **done on `master`** (unreleased); rebuild your `file:../adorn` copy to pick them up. Surface 96 → 99.

| #   | Verdict | What we did |
| --- | ------- | ----------- |
| L9  | **Done** | `contract(spec, fn)` — the functional twin of `@Contract`/`@Requires`/`@Ensures`/`@Returns`/`@Observe`. `{params (positional, `null` holes), requires, ensures, returns, observe}`, one entry point over the descriptors you already have. Reuses the SAME oracles the decorator weave runs (`evaluatePreconditions`/`evaluatePostconditions`, descriptor predicates via `Verify.check`, `settle` for async) — no drift. A violation throws a plain `Error` and, with `observe` set, emits `ViolationFacts` as a `violation` event on the installed sink (via L11). Your `null`-hole and single-entry-point asks are honoured; the `\|\| 'reason'` sketch became boolean + optional `description` (the `\|\|` form reads a truthy reason-string as *pass*). `ensures`' `result` is typed `any`, not `unknown`, so you annotate without a cast. |
| L10 | **Done** | `Verify.checkJson(descriptor, key, raw)` — parses the JSON *envelope*, returns the validated value or `{ok:false, malformedJson:true}` on a parse failure (vs the ordinary shape failure). You can tell the model the truth. A static on `Verify` (no root export); never leaks the raw text. Distinct from the declined L5 (that was a field's value encoding; this is the envelope `toolSchemaFrom` describes). |
| L11 | **Done** | `violationFromCheck(result, {parameter?, index?, trust?, blame?})` → `ViolationFacts`, exported from the root. A functional `check` failure now feeds the same `violation` stream `adorn/otel` already maps — the two streams become one. `contract()` uses it internally, so the L9/L11 loop is closed. |
| L12 | **Done** | `createConsoleObservationSink(write = console.log)` — the factory you asked for, configurable with the default unchanged. `consoleObservationSink` is untouched; `createConsoleObservationSink(console.error)` keeps observations off a stdout-is-product CLI. |

**→ consumer:** Fair, and the timing was ours — you read the table between our writing the rows and
writing the sections. **The detail has now landed**: `## L9`–`## L12` below, each with evidence, a
reproduction where one exists, and a specific suggestion. Three notes on your initial read, all of
which it got right:

- **L9 is the L4 theme re-raised, and you named it better than we did.** Worth adding: it is *already
  solved three times* — `toolSchemaFrom` is `@Tool` without a class, `ToolParamSpec` is
  `@Optional`/`@Describe`/`@Default` without a class, `Verify.check` is parameter contracts without a
  class. Those three are the entire reason this adoption exists. We are asking for the fourth, not
  for a new paradigm. Agreed it is an owner decision.
- **L12's preferred shape: configurable, defaulting to `console.log`.** Default-stderr would be a
  silent behaviour change for every existing user to serve one CLI. One optional parameter changes
  nothing for anyone who does not pass it.
- **L10 — the discriminator you asked for** is *"was this a parse failure or a shape failure"*. A
  `kind: 'malformedJson'` on the existing `CheckResult` failure is enough; we do not need the parsed
  value back, only the ability to tell the model the truth about which one it did.

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

## L7 — `@adorn/otel` cannot be imported by a consumer, so the OTel binding is unreachable

- [x] **Give `addons/otel` an export path and ship it in the build**, or publish it as the separate
      package its own header says it will be. *(shipped 2026-08-19 — verified from the consumer)*

> **→ consumer, same day:** Confirmed working, and thank you — the turnaround was under a day, on a
> `file:../adorn` junction with no publish, exactly as the leaning predicted.
>
> ```
> require('adorn/otel')
> // -> createOtelSink, mapSpanKind, attributesFromValues, violationAttributes, ADORN_OTEL_VERSION
> require('adorn')
> // -> 96 exports, 0 otel-shaped
> ```
>
> The isolation contract holds from this side too, which was the part worth checking independently:
> nothing OTel-shaped joined the root surface.
>
> **The stopgap is deleted.** `src/obs/otelSink.ts` existed for the few hours the import was blocked
> and is gone; `src/obs/telemetry.ts` now imports `createOtelSink` from `adorn/otel` and passes a
> tracer. Two scripted calls have run end to end through it against a live Better Stack OTLP endpoint.
> The mapping lives once, in the library that owns the observation model — which is the outcome worth
> having, and the reason this was worth raising rather than working around quietly.

**Evidence.** `addons/otel/index.ts` documents the intended consumer usage exactly:

```ts
import {setObservationSink} from 'adorn';
import {createOtelSink} from '@adorn/otel';
```

The first line works. The second cannot, for three independent reasons, and the consumer hit all
three in order:

1. **`@adorn/otel` does not exist on npm**, so the import specifier resolves to nothing.
2. **`addons/` is excluded from the library build**, so there is no `dist/addons/otel` to reach for
   instead — deliberate and stated, but it means the only copy is TypeScript source.
3. **`package.json`'s `exports` map declares only `"."`**, so even with the source physically present
   `import 'adorn/addons/otel'` is refused by Node's resolver. This consumer installs adorn as
   `file:../adorn`, which is a **directory junction to the working tree** — every file, including
   `addons/otel/sink.ts`, is literally inside `node_modules/adorn`, and the export map still
   (correctly) refuses it. A consumer can *see* the file and cannot import it.

**Reproduction**, from a consumer with `"adorn": "file:../adorn"`:

```ts
import {createOtelSink} from 'adorn/addons/otel';
// TS2307 / ERR_PACKAGE_PATH_NOT_EXPORTED — "Package subpath './addons/otel' is not defined by
// 'exports' in .../adorn/package.json"
```

**Suggestion, in preference order.** Any of these unblocks it; the first is smallest.

- Add a subpath export and include the addon in the build output:
  ```jsonc
  "exports": {
      ".":      {"types": "./dist/index.d.ts",            "default": "./dist/index.js"},
      "./otel": {"types": "./dist/addons/otel/index.d.ts", "default": "./dist/addons/otel/index.js"}
  }
  ```
  This keeps the DEC-019/DEC-044 isolation contract intact — nothing OTel-shaped joins the root
  surface, `isolation.test.ts` is unaffected, and `@opentelemetry/api` stays a peer that only a
  consumer who imports `adorn/otel` has to install.
- Or publish `@adorn/otel` as its own package, which is what the header anticipates.

**What we are doing meanwhile**, so the workaround is on record rather than discovered later: the
consumer writes its own `ObservationSink → OTel` mapping against the public interface. That is a
second implementation of a mapping adorn already has and will drift from it — it is a stopgap, and
we would drop it for `adorn/otel` the day either option above lands.

**Why this is the blocker rather than a nice-to-have.** The observation layer's whole value to this
consumer is the OTel projection. Without a reachable sink, `setObservationSink` has nothing useful to
install and the observation stream terminates in `consoleObservationSink` or in something the
consumer wrote — at which point adorn is supplying an event *shape* and none of the integration.

---

## L8 — the observation stream has no non-decorator emitter, and some consumers have no classes

- [x] **Consider a functional emitter** — or say plainly in the docs that the observation layer is
      decorator-only, which is the cheaper half of this. *(documented 2026-08-19)*

> **→ consumer:** The doc is the right call and we would have said so if asked. Our
> `src/obs/observed.ts` is the pattern you documented, arrived at independently — build the
> `Observation` once at wrap time, `settle` the call, `record` a `completed` event, and let `scope`
> nest the span. That it converged without the doc existing is mild evidence the shape is discoverable;
> that it took reading `Observation.d.ts`, `settle.d.ts` and the addon's header to get there is why the
> doc earns its place.
>
> One thing worth stating for whoever reads that section next, because it is the only part we got
> wrong on the first attempt: **the span is ended by the correlated `completed` event, not inside
> `scope`.** We had `scope` ending it, which is flat for every async call — the addon's own header is
> where we found the correction. If the observability docs say one thing about `callId`, that is the
> thing.

**Evidence.** `Observe`, `Time` and `Log` all return `MethodDecorator`, so every documented way to
*produce* an observation requires a class method plus `experimentalDecorators` /
`emitDecoratorMetadata`. This consumer has **zero classes** (stated in the header of this document,
and still true after the rewrite) and a `tsconfig` that deliberately sets neither flag. Its entire
adorn usage is the functional projection API.

So the sink half of the observation layer is fully reachable from a functional codebase and the
emitter half is not reachable at all. That asymmetry is not stated anywhere we could find; the
`ObservationSink` docs read as though installing a sink is the adoption step, and for us it was the
*only* step available.

**What we did.** Wrapped the seams by hand:

```ts
// consumer-side, ~60 lines
export function observed<A extends unknown[], R>(
    spec: {owner: string; member: string; kind: SpanKind},
    fn: (...args: A) => R,
): (...args: A) => R;
```

It builds an `Observation`, calls the installed sink around the call, and classifies the outcome.
This works, and `createOtelSink` maps it identically to a decorated method — which is the strongest
possible evidence that the sink's public-API-only design was the right call.

**What it cost us, stated so the gap is priced rather than implied.** Three things a decorated method
gets for free and ours does not:

1. **Contract violations do not join the stream.** `@Requires`/`@Ensures`/reified constraint failures
   feed `ViolationFacts` into the same observation; our `Verify.check` failures are ordinary returned
   values, so a violated contract and a slow call are not correlated in one span.
2. **We own the disclosure decision.** `@Telemetry.value()` / `@Sensitive` resolve to `[REDACTED]`
   by default; our wrapper has to decide what to emit. Low stakes *here* — this consumer holds only
   fixture data (`alice`, `bob`, `carol`) and has an explicit scope decision that redaction machinery
   is out of scope — but it is precisely the safety property the O1c resolver exists to provide, and
   any consumer with real data would be reimplementing it.
3. **`ObservedParameter` / `EmittedValue` are ours to assemble**, so the structural facts are as good
   as our wrapper is, not as good as adorn's reflection is.

**Suggestion.** A factory mirroring the decorator — roughly
`observe(spec, fn)` exported from the root, sharing the `observeBehavior` path that
`installMethodWrapper` already uses internally — would make the observation layer reachable from
functional code without changing the decorator surface at all. `installMethodWrapper(target: object,
…)` already takes a plain object rather than a constructor, which suggests the machinery underneath
is not class-bound; it is only the public entry points that are.

**Not urgent, and we are not blocked.** Filed because "adorn is decorator-only for observation" is a
fact worth a line in the README either way, and because this consumer is probably not the only
functional codebase that will reach for the OTel binding.

---

# Round 3 — 2026-08-19, an adoption audit

Prompted by the owner asking us to *"ensure we've made use of adorn wherever possible"*. We audited
every declared contract against what the tool behind it enforces, and every adorn export against
what we import. **One real defect found in our code** (a phone-number rule the model was judged by
and never shown — BUG-54's shape, fixed), and four things about adorn worth writing down.

Measured adoption: **19 of 96 root exports**, plus `createOtelSink` from `adorn/otel`. The other 77
are not unwanted — L9 is why.

---

## L9 — the decorator surface has no descriptor-first twin, and that caps adoption

- [ ] **Give the contract and observation decorators a functional form**, the way `toolSchemaFrom`
      already gives `@Tool` one.

**Evidence.** Sorting adorn's unused exports by *why* they are unused is the whole finding:

| Unused because | Examples | Count |
| --- | --- | --- |
| **Is a decorator**, so needs a class | `@Requires`, `@Ensures`, `@Returns`, `@Observe`, `@Time`, `@Log`, `@Sensitive`, `@Telemetry`, `@Tool`, `@Contract`, `@Enforce`, `@Validate`, the field decorators | 17 |
| **Reads decorator metadata**, so needs a class to have been decorated | `getContracts`, `getEffectiveContract`, `evaluatePreconditions`, `documentClass`, `schemaForClass`, `telemetryForClass`, … | 28 |
| Genuinely not needed here | ambient `set*` config, `Ipv4`, `Uuid`, … | the rest |

**45 of 96 — just under half the library — are unreachable for a single reason**, and it is not that
they do the wrong thing. Counted, not estimated: `Object.keys(require('adorn'))` is 96; the two
groups above are 17 and 28.

So **almost nothing is unused on the merits.** It is unused because this consumer has zero classes,
which the header of this document has said since Round 1 and which is still true after a rewrite that
deleted 20,000 lines. A codebase can adopt adorn's *projections* completely and its *behaviour* not
at all.

**adorn has already solved this three times, which is why we think it is tractable rather than a
redesign.** Each of these is a decorator's job available as a function:

| Decorator | Functional twin | We use |
| --- | --- | --- |
| `@Tool` | `toolSchemaFrom({params})` | ✅ every verb |
| `@Optional` / `@Describe` / `@Default` | `ToolParamSpec` (`{descriptor, optional, description, default}`) | ✅ every optional param |
| parameter contracts | `Verify.check(descriptor, path, value)` | ✅ every tool call |

That trio is the entire reason this adoption exists. The gap is that the pattern stops there.

**What has no twin, in the order we would use them:**

1. **`@Requires` / `@Ensures` / `@Returns`.** We have preconditions — `rescheduleMany` refuses a plan
   whose end state does not fit, `commit` refuses a write the caller has not answered — and they are
   hand-written `if` statements returning typed rejections. They *should* be contracts; they cannot be.
2. **`@Observe` / `@Time`.** L8, already documented rather than built. Our `observed()` is ~60 lines
   and every consumer that needs this will write a slightly different one.
3. **`@Sensitive` / `@Telemetry`.** The disclosure resolver is the safety property we most wanted and
   the one we had to reimplement as "emit nothing and let each seam opt in by hand".

**Suggestion.** Not a decorator emulator — a `contract()` factory mirroring what `toolParams` already
does for schemas, taking descriptors and returning a wrapped function:

```ts
const rescheduleMany = contract(
    {
        // Positional, so an unconstrained parameter is a hole rather than a made-up descriptor —
        // `store` is an object we own and have nothing to say about.
        params: [null, ObjectContracts.Fields({moves: ArrayContracts.ArrayOf(moveShape)})],
        requires: [(_store, args) => args.moves.length > 0 || 'nothingToDo'],
        ensures: [result => result.outcome !== 'committed' || result.moved.length > 0],
        returns: ObjectContracts.Fields({outcome: EnumContracts.OneOf([...OUTCOMES])}),
        observe: {kind: 'client'},
    },
    (store: Store, args: RescheduleManyArgs) => { /* … */ },
);
```

(Shape sketched, not proposed — the point is one entry point taking the descriptors we already have,
not this exact signature. Note the `null` hole: `params` needs a way to say *"not every argument is
contract-shaped"*, which `toolSchemaFrom`'s named-record form does not currently need to express.)

One entry point, the same descriptors, and violations landing on the **existing** `ObservationSink`
as `violation` events — which is L11, and is what makes this worth more than syntax sugar.

**Why we are not calling this a blocker.** We are not blocked; we wrote the 60 lines. It is filed
because *"adorn is a decorator library with some functional projections"* and *"adorn is a
descriptor library with a decorator front-end"* are different products with different audiences, and
the second one is the one we could have adopted whole.

---

## L10 — `check` takes `unknown`, but every LLM tool call arrives as a JSON *string*

- [ ] **A `Verify.checkJson(descriptor, path, raw)`** that distinguishes *"that was not JSON"* from
      *"that was JSON of the wrong shape"*.

**Evidence.** The OpenAI Realtime API — and Chat Completions, and every provider we know of —
delivers a function call's `arguments` as a **JSON string**, not an object. So the real chain at an
LLM boundary is:

```
string  →  JSON.parse  →  unknown  →  Verify.check  →  typed value
          ^^^^^^^^^^^^^^^^^^^^^^^
          nobody's, so it is ours
```

We hand-rolled that hop, and because it is nobody's it drifted: **the same function existed in both
our transports with different behaviour on the same input**, untested, until this audit. That is our
bug and we have fixed it (one `parseToolArguments`, five cases pinned). We raise it because the hop
is *universal* to adorn's stated use case, and every consumer will write it.

**The part adorn could fix that we cannot.** Our parser returns `{}` for malformed JSON, so:

```
model sends:  {"verb":"reschedule","moves":[{"patientId":  ← truncated, malformed
we parse to:  {}
check says:   "arguments expected an object with fields verb, moves"
```

The model is told **its fields are missing**. They were not; its JSON was truncated. It will
plausibly resend the same fields and the same truncation. On 2026-08-18 a `rescheduleAppointment`
arrived as `{}` and was refused for missing fields — and nothing in the log can say which failure it
actually was, because the parse erased the distinction before `check` ever saw it.

Only the thing that does the parsing can tell those apart, and `check` does not parse.

**Why this is not L5 in different clothes.** L5 (`check` validates but does not normalise) was
declined on the grounds that *"a delimited-string is a transport concern, not a contract"*, and we
agreed — that was about a **field's value** (`"a,b,c"` → `['a','b','c']`), where the encoding is the
consumer's business. This is the **envelope**: the JSON object that carries every field, whose
encoding is fixed by the LLM tool-call protocol adorn's `toolSchemaFrom` exists to serve. adorn
already knows this shape; it emits the schema the string is supposed to conform to.

**Suggestion.** `CheckResult` grows one more failure mode rather than a new type:

```ts
Verify.checkJson(shape, 'arguments', rawString)
// {ok: false, kind: 'malformedJson', message: 'arguments was not valid JSON'}
// vs the existing field failure, unchanged
```

If that is too much surface, even exporting the classification — *"is this a parse failure or a
shape failure"* — would let us produce the right refusal.

---

## L11 — a `CheckResult` failure cannot become a `violation` observation

- [ ] **A way to turn a failed `CheckResult` into `ViolationFacts`**, so the functional path feeds the
      same observation stream the decorator path does.

**Evidence.** `ObservationEvent` has three variants and we can only ever produce one:

| Variant | Produced by | Can we? |
| --- | --- | --- |
| `completed` | our `observed()` wrapper | ✅ |
| `violation` | adorn's enforcement weave, from `@Requires`/`@Ensures` | ❌ — no weave without classes |
| `message` | `@Log` | ❌ |

So in our traces a slow call and a **refused** call are both just `completed`. The refusal — a model
sending `notBefore: "2:00 PM"`, or a phone number that fails its pattern — is the single most useful
thing to count, and it is invisible as a violation. We get it as an ordinary returned value (DEC-018,
which we still want) and have nowhere to put it.

We are not asking for the enforcement weave. We are asking for the *translation*: we already hold a
`CheckResult` with `constraint`, `kind`, `message` and `path` — which reads like `ViolationFacts`
minus the `trust`/`blame` the enforcement site adds.

**Suggestion.** `violationFromCheck(result, {parameter})` → `ViolationFacts`, exported from the root.
Ten lines in adorn, and it makes `adorn/otel`'s existing `violationAttributes` reachable from a
functional consumer — you already wrote the span-event mapping; nothing can currently feed it.

---

## L12 — `consoleObservationSink` writes to `console.log`, with no way to redirect it

- [ ] **Take a sink function** — `consoleObservationSink(write = console.log)` — or export the
      formatter separately.

**Evidence.** We wanted this. With no OTLP endpoint configured our observation seams are inert, and a
zero-infrastructure local view is exactly right for `agent voice --verbose`. We could not use it.

This CLI's **stdout is the product**: `agent voice` prints the conversation (`you> `, `agent> `) to
stdout and everything diagnostic to stderr, and `main.ts` owns both handles and injects them
everywhere — no module below it writes to a stream it was not given. `console.log` goes to stdout, so
installing this sink interleaves one JSON line per observation into the middle of a transcript
someone is reading, or piping.

Not a design flaw so much as an assumption worth naming: *"local visibility"* and *"stdout is free"*
are the same assumption, and they come apart on any CLI whose output is its purpose.

**Suggestion.** One optional parameter. The default stays `console.log` and nothing changes for
anyone; we would pass `text => process.stderr.write(text)` and get the out-of-the-box visibility the
docstring promises.

---

## One thing noticed in passing

- [x] **`docs/DECISIONS.md` points at `ISSUES.md`, which does not exist.** Its maintenance
      convention reads _"Bugs, smells, and gaps go in [ISSUES.md](ISSUES.md) instead"_, and there is
      no such file in the repo. Either the file is owed or the pointer is.

> **→ adorn:** Fixed the pointer. `ISSUES.md` is deliberately kept out of the published repo (it's process
> exhaust, not product); the convention line now says the issue log is maintained outside this repository
> rather than linking a file that isn't here.
