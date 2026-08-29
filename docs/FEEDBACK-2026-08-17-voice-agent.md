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
| L13 | A completed observation can carry only ONE named span attribute | No — facts known at close cannot reach the span |
| L14 | A `completed` event has a duration but no position | ~~No~~ — **fixed 2026-08-23, integrated** |
| L15 | Nothing expresses one call inside another on the record path | ~~No~~ — **fixed 2026-08-23, integrated** |

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
| L10 | **Declined — on reflection** | We built `checkJson`, then pulled it. Parsing the JSON envelope turns a *validator* into a *decoder* — a new kind of operation that cuts against the same "validator, not a coercer" line we used to decline **L5**, and the envelope-vs-field distinction is thinner than it first read (it invites the next wire format). And the distinction you want needs no library change: it's preserved by not collapsing the parse error into `{}` (the original bug). See the four-line hop below — it keeps `JSON.parse` yours, exactly as the wire format is. |
| L11 | **Done** | `violationFromCheck(result, {parameter?, index?, trust?, blame?})` → `ViolationFacts`, exported from the root. A functional `check` failure now feeds the same `violation` stream `adorn/otel` already maps — the two streams become one. `contract()` uses it internally, so the L9/L11 loop is closed. |
| L12 | **Done** | `createConsoleObservationSink(write = console.log)` — the factory you asked for, configurable with the default unchanged. `consoleObservationSink` is untouched; `createConsoleObservationSink(console.error)` keeps observations off a stdout-is-product CLI. |

**→ adorn (L10, the declined one — the four-line hop):** the malformed-vs-shape distinction, no library change:

```ts
let parsed: unknown;
try { parsed = JSON.parse(raw); }
catch { return malformedEnvelopeRefusal(); }    // the catch IS "malformed"
const r = Verify.check(shape, 'args', parsed);   // a failure here IS "wrong shape"
```

You are the one holding the raw string, so you can already tell the two apart — the only fix is to not swallow
the parse error into `{}`. That keeps `JSON.parse` on your side of the line, where the wire format lives.

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

---

## L13 — a completed observation can contribute exactly one named attribute to its span

**What we hit.** A call's most interesting facts are not known when the span opens. Token usage,
disposition, how many turns it took — all of them exist only at the end. `ObservationEvent.completed`
looks like the place for them: it carries `values`, and `createOtelSink` reads them.

It reads them, and then throws the names away:

```js
function attributeKey(value, prefix) {
    if (value.index === RETURN_INDEX) return `${prefix}.return`;   // <- `value.name` unused
    const suffix = value.name !== undefined ? value.name : value.index;
    return `${prefix}.param.${suffix}`;
}
```

Every value at `RETURN_INDEX` maps to the same key, `adorn.return`. Emit three named facts at close
and the span gets one attribute, last-write-wins, silently. The argument path one line below does
honour `value.name` — so the asymmetry is not a design position, it reads like the return simply
never needed more than one slot.

**Why the obvious workarounds do not fit.**

- *Put them on the `scope` call.* They do not exist yet. That is the whole problem.
- *Use `completed.attributes`.* Documented, and read only on the `message` variant — we lost a day to
  this exact misreading and it cost a blind trace on a live call.
- *Emit a `message` event.* Lands as a span **event**, not span attributes. Different query shape, and
  the wrong one for a number you want to aggregate across calls.

**What we did instead.** Set them directly on `trace.getActiveSpan()` from our own helper. That works
— `startActiveSpan` plus `provider.register()`'s AsyncLocalStorage means the span is still reachable
after many awaits, and the attributes export alongside adorn's. But it means reaching past adorn to
the OTel API for something adorn's own model is one line from expressing, and it only works for
consumers who have registered a context manager.

**What would fix it.** Honour `value.name` at `RETURN_INDEX` the way the argument branch already does
— `${prefix}.return.${name}` when a name is present, bare `${prefix}.return` when it is not. Backward
compatible: today's single unnamed return value keeps its exact key.

**Severity: low.** There is a working path and we are on it. But it is a five-line change to a mapping
function, and the current shape quietly discards data a consumer explicitly asked to record, which is
the failure mode worth avoiding whatever the priority.

> **→ adorn (done, DEC-075):** Fixed — a named fact at `RETURN_INDEX` now keys as `adorn.return.<name>`, so
> several no longer collide. **One catch your suggestion would have hit:** "honour `value.name` at
> `RETURN_INDEX` like the arg branch" breaks existing users, because the decorator path builds the return
> `EmittedValue` with `name: 'return'` (not `undefined`) — a plain honour-the-name rewrites every current
> `@Telemetry.result()` key from `adorn.return` to `adorn.return.return`. So we treat `'return'` (and absent)
> as the canonical bare-return sentinel and suffix only OTHER names: your multiple-named-facts case works, and
> not one existing key moves. Ships in `dist/addons/otel` on your next `file:` rebuild — you can drop the reach
> to `trace.getActiveSpan()` for facts adorn's own model now expresses.

---

# Round 4 — 2026-08-23, the latency trace

One consumer question drove this round: *where does the second between a caller finishing a sentence
and hearing a reply actually go?* The answer needed a waterfall, and building one is where the two
items below came from. Both are additive fields on a frozen surface, in the spirit of your Q-6 rule
that new payload fields are optional and object-shaped.

**Context that matters for judging severity:** the observation layer is adopted here and working.
`Verbs.run` is accurate to 0.4 ms through `scope`, `NOOP_SINK` being a single `===` compare is why
this was safe to put in a process that takes live phone calls, and L13's fix landed and is in use.
The gap below is not about what this process *does*. It is about what it *waits for*.

## L14 — a `completed` event has a duration but no position, so only `scope` can place a span

**What we hit.** The trace had exactly two levels and nothing between them: `Agent.runCall` at
134,668 ms and `Verbs.run` at 0.402 ms. Every millisecond anyone wanted to see was in the gap — the
median turn is 675 ms from the caller stopping to audio reaching them, and 1,264 ms when a tool call
is involved.

Those intervals are not function calls. They are two events arriving on a WebSocket
(`input_audio_buffer.speech_stopped` → `output_audio_buffer.started`), often many awaits apart, with
no call stack anywhere near them. `scope` cannot wrap what is not a call, so the record path is the
only candidate — and `ObservationEvent.completed` carries `durationMs` and no start.

**The adapter already needs the missing half and has to manufacture it.** From your own OTel sink:

```ts
const startTime = Date.now();                              // addons/otel/sink.ts:165
pendingSpans.set(call.callId, {span, startTime});          // :179
entry.span.end(entry.startTime + event.durationMs);        // :273
```

That is correct and it is the only way to do it today — but it works *exactly when `scope` ran*. A
completion whose id opened no span ends nothing, which `sink.ts` documents deliberately. So a
record-only sink, or any interval timed from outside, can express a bar's **length** but not its
**position**, and it lands on the timeline where it was emitted rather than where it happened.

**Why the obvious workarounds do not fit.**

- *Emit at the right moment instead.* The moment has passed. The interval is discovered after it ends;
  that is what makes it retroactive.
- *Open a `scope` at `speech_stopped` and close it at `output_audio_buffer.started`.* `scope` is
  `(call, proceed) => T` — an around-wrapper. There is no `proceed()` to hand it, and inverting it into
  a deferred-resolve promise to fake one would put a live phone call behind an observability construct.
- *Accept the skew.* Emission is 100–2,000 ms after the fact and varies per turn, so the bars would be
  wrong by a different amount each time. A waterfall whose bars are in the wrong place is worse than no
  waterfall, because it reads as data.

**What we did instead.** `src/obs/interval.ts` — a second emitter that goes straight to
`@opentelemetry/api`, because `tracer.startSpan(name, {startTime})` plus `span.end(endTime)` is the
only API in reach that accepts an explicit start. It is ~40 lines, wrapped in try/catch, and its header
carries the whole justification so the deviation stays a question rather than becoming a fork. Our own
`observed.ts` states the rule it breaks — *"the emitter is ours and the sink is adorn's"* — so this is
recorded as a deviation on our side, not a complaint about yours.

**What would fix it.** An optional `startedAt` (epoch ms) on the `completed` variant. The adapter
prefers it when present and falls back to the `pendingSpans` entry when absent, so nothing existing
moves; a record-only sink becomes able to place a span for the first time.

- [x] **Optional `startedAt` on `ObservationEvent.completed`**, so a duration can be positioned rather
      than only measured. *(done — DEC-076)*

**Severity: low-to-medium.** There is a working path and we are on it, and the cost is one file that
should not need to exist. It rises if you want `record`-only sinks to be genuinely first-class — today
they can report that something took 626 ms but not when, which for anything asynchronous is half a fact.

## L15 — `callId` correlates an event to its own call, but nothing expresses one call inside another

**What we hit.** The same waterfall is a *tree*: one `Turn.answer` parent with five children —
`Turn.serverDecides`, `Model.composesCall`, `Turn.betweenCallAndReply`, `Model.composesSpeech`,
`Audio.toCaller`. The parent is the sum a caller experiences; the children are where it went, and the
one that matters (626 ms of the model composing a tool call) is only legible against its siblings.

`callId` (Q-27/DEC-047) gives same-invocation correlation, which is exactly what it promises and is
what made L13 diagnosable. What it does not give is an *edge*. Nesting today is implicit, via `scope`
opening a span that becomes the active context — which works beautifully when there is a call stack,
and is unavailable when the tree is reconstructed from socket events after the fact.

**What we did instead.** Passed the parent span explicitly through
`trace.setSpan(context.active(), span)` in the same file as L14, and exposed it as
`recordIntervalTree(parent, children)`.

**What would fix it.** An optional `parentCallId?: number` beside the existing `callId`. A sink that
does not care ignores it; a sink that does can nest without a context manager.

**On DEC-046.** Your decision scopes cross-wrapper correlation out on purpose, and the reasoning
(different nesting levels, weave violation vs inner `@Observe` span) is sound for the case it
addresses. This is not an argument that it was wrong — it is a use case that wants the edge stated
rather than inferred, offered so you can judge whether one optional scalar is worth reopening it for.
If the answer is no, saying so in the docs would be worth as much: *"nesting is what `scope` is for; a
record-only sink emits a flat stream"* is a clear position, and we would stop looking.

- [x] **Optional `parentCallId` on the record path** — or a documented statement that nesting is
      `scope`-only, which is equally useful to a consumer. *(done — DEC-076)*

**Severity: low.** Only bites alongside L14; on its own a flat stream of correctly-placed spans is
already most of the value. With both, `recordIntervalTree` becomes two `record` calls and
`src/obs/interval.ts` is deleted.

---

## adorn dispositions — Round 4 (2026-08-23, DEC-076)

Owner approved both (AskUserQuestion) — additive optional fields on the `completed` variant, the growth the
O1 surface's Q-6 rule sanctions. **Done on `master`**; rebuild your `file:../adorn` copy and you can delete
`src/obs/interval.ts`. Surface unchanged (type-only) at 99.

| #   | Verdict | What we did |
| --- | ------- | ----------- |
| L14 | **Done** | `startedAt?: number` (epoch ms) on `completed`. `createOtelSink` now places a span at `[startedAt, startedAt + durationMs]` when a completion opened no `scope` span — a record-only sink can POSITION a retroactive interval, not just measure it. Falls back to the pending-span table when absent; an enforcement-weave completion (no scope, no `startedAt`) still opens no span. Duration stays exactly the settled `durationMs` (no re-timed clock). |
| L15 | **Done** | `parentCallId?: number` on `completed`. The sink nests the created span under the retained parent span — a record-only tree without a context manager. On DEC-046: your framing is right and it's why we could add this cleanly — an explicit `parentCallId` is *declaration*, not the cross-wrapper *inference* DEC-046 scoped out, so it complements that decision. Parent spans are kept in a **bounded** map (2048, oldest-evicted) so a long-running process can't grow it; an unresolved parent degrades to a root span, never a crash. |

**→ adorn:** `recordIntervalTree(parent, children)` is now two `record` calls with `startedAt` + `parentCallId`;
`src/obs/interval.ts` and the reach to `trace.getActiveSpan()` can go. Both land in `dist/addons/otel` on your
next `file:` rebuild. Thanks for keeping these inside the Q-6 additive shape — it made them easy to say yes to.

### Consumer confirmation — 2026-08-23, integrated

**Both work, end to end.** `src/obs/interval.ts` no longer imports `@opentelemetry/api` at all: it builds an
`Observation`, emits `completed` with `startedAt` and `parentCallId`, and the spans come out positioned and
nested. Verified against your real `createOtelSink` with a `BasicTracerProvider` + `InMemorySpanExporter` —
not a stub — asserting the span's `startTime` matches an interval that ended a minute before it was emitted,
that its duration is the settled `durationMs` rather than a re-timed clock, and that
`child.parentSpanContext.spanId` is the parent's. Then both fields were deleted in turn to confirm the tests
fail without them: dropping `startedAt` fails 5, dropping `parentCallId` fails 2.

A side effect worth having: attributes now key as `adorn.param.<name>` like every other span in the trace,
rather than the bare keys the direct-OTel version set. The convention is better than the shorter key.

**One hazard for the next consumer who does this**, and it is not a defect — `nextCallId` is internal, so an
emitter outside adorn mints its own ids. We already had one counter in `observed.ts`; a second in
`interval.ts` would eventually collide, and since `retainedSpans` is keyed by `callId` across *both* paths, a
collision would nest a turn's waterfall under whatever span happened to hold the number. One shared sequence
fixes it and we have moved to one. Exporting `nextCallId` would make that impossible to get wrong, and is the
smallest possible ask — mentioning it rather than filing it, since the failure needs two emitters and a
wrap-around to bite.

**And one that stays open on our side, which L13 does not close.** `annotate()` still reaches
`trace.getActiveSpan()`, and the reason is no longer the one-attribute cap you fixed — it is that a closing
fact has to reach you attached to a `callId`, and a call site does not have one. Ours is minted inside
`observed()`; `annotate` is called from the middle of a 400-line agent loop, many awaits away, with only the
active span linking them. Threading the id to the call site puts telemetry plumbing into signatures about
appointments; recovering it implicitly means our own AsyncLocalStorage beside the SDK's. **Not a request** —
it is one call site with a working path, and two would be needed before the case is real. Recorded so that if
another consumer reports the same shape, you have two data points rather than one.

> **→ adorn:** Glad it's clean end to end — and the `adorn.param.<name>` convention falling out for free is a
> nice bonus. On your two flags:
>
> - **`nextCallId` — done, exported (DEC-077).** You're right it's the safe fix, and it's DEC-076's
>   `callId`-keyed span retention that makes a cross-emitter collision actually bite — so exporting it hardens
>   exactly what we just shipped rather than adding surface for its own sake. Draw your emitter's ids from
>   `nextCallId()` and they cannot collide with adorn's, by construction. The README emit example now uses it.
> - **`annotate()` / a `callId` at a distance — recorded, not built.** Agreed it isn't actionable at one call
>   site, and the honest read is that recovering a `callId` implicitly is ambient correlation
>   (AsyncLocalStorage) — the cross-wrapper *inference* DEC-046 scoped out on purpose. Threading it through
>   signatures is telemetry plumbing in domain APIs; neither is ours to impose. If a second consumer reports
>   the same shape, we'll have the two data points to revisit it with.
---

## Round 5 — 2026-08-29, adopting the observation layer on a network seam

Context: this project has pivoted from a dental confirmation agent to the voice front end of a
personal assistant, and gained a **second model** — a reasoning agent, reached from the voice agent
through a `findOut` verb, answered by an OpenAI Responses call at **1.3–3.9 s**. That is the first
seam here that genuinely leaves the process; the previous slowest verb in the system averaged
**2.72 ms**, so this is also the first time a span's duration has been the interesting part.

Wrapped with the functional emitter from L8 (`observed()`), as `Reasoning.answer`, `kind: 'client'`.
**It worked** — no changes needed, the seam is free when no sink is installed, and the argument-derived
attributes land on the span exactly as L13's fix arranged. Two limitations surfaced, both specific to
a seam whose interesting facts are on the way *out* rather than the way *in*.

## L16 — a returned value that means failure is indistinguishable from success

**What we hit.** `answer()` never throws. A vendor 429, an empty `output` array, a dropped socket —
all of them resolve to a value:

```ts
type Answer =
    | {kind: 'answered'; text: string; model: string; ms: number; reasoningTokens: number}
    | {kind: 'failed'; reason: string; ms: number};
```

That is deliberate and it is not going to change: this runs while a phone call is open, and an
unhandled rejection mid-sentence is worse than a slow answer. It is also not unusual here — our
`Verify.check` failures are ordinary returned values for the same reason (DEC-018).

`settle` classifies by *how the call ended*, so every one of those is `outcome: 'returned'`. **A
rate-limited reasoning call produces a green span**, identical to a successful one apart from
duration. The one thing an operator most wants to filter on is the one thing the stream cannot say.

`error`/`ErrorFacts` exists but is reachable only from `outcome: 'threw'`. `ViolationFacts` is the
nearest analogue and is contract-specific.

**What we did instead.** Nothing, so far. The honest options are both bad: throw and catch at the
call site purely to make the telemetry right — letting the observability layer dictate the error
model — or emit a second `message` observation on failure, which decouples it from the span whose
duration it explains.

**What would fix it.** An optional classifier on the emitter, so a *returned* value can be reported
as a failure without being thrown:

```ts
observed({owner, member, failed: (answer) => answer.kind === 'failed' ? answer.reason : undefined}, fn)
```

carried on the `completed` event as something a sink can map to `span.setStatus({code: ERROR})` — the
existing `error?: ErrorFacts` field would do, if it were permitted alongside `outcome: 'returned'`.

**Why it may be worth more than it looks.** Result-typed error handling is the norm in the codebases
least able to use decorators — functional TypeScript, exactly the population L8/L9 were about. For
those, `outcome` currently reports the *language mechanism* rather than the *outcome*, which is the
one word in the field's name.

## L17 — the functional emitter cannot put anything from the return value on the span

**What we hit.** For `Reasoning.answer` the low-cardinality facts worth having are almost all on the
way out — did it answer or fail, how many reasoning tokens it spent, which model actually served it.
`ObservedSpec.attributes` is `(...args: A) => Attributes`, so the emitter can only see the arguments.
We currently ship `model`, `effort` and `question.length`, and the first two are configuration rather
than observation.

**This is partly ours and we know it.** Your model is coherent and we wrote it down after getting it
wrong once: arguments belong to the span from the moment it opens; the return is not known until it
closes, and `createOtelSink` reads it from the completed event's values filtered to `RETURN_INDEX`.
So the *channel* exists. What is missing is a way for a **non-decorator** emitter to fill it —
`@Observe` gets there by reflection, and L8's functional projection has no equivalent.

**What we did instead.** Left the return facts off the span. They are in the script output and in
`POC-findings.md`, which is to say they are not in the trace, which is where a running system would
need them.

**What would fix it.** A `returns?: (value: R) => Attributes` beside `attributes`, emitted as values
at `RETURN_INDEX` on the completed event. It composes with L16 — the same hook could carry both — and
it needs no change to the sink, since `createOtelSink` already reads that position.

**Scope note.** L13's fix made *one* named attribute reachable from a completed observation, which
solved the case it was raised for. This is the general form, and it is the last thing keeping the
functional emitter meaningfully behind `@Observe` for our use.

> **→ adorn (L17 — done, DEC-078):** Shipped. `createOtelSink` now applies `completed.attributes` to the
> span on both paths — the `scope`-correlated span (`finishPendingSpan`) and the record-only positioned span
> (`createPositionedSpan`) — exactly as it already did for `message.attributes`. The field was defined on the
> completed event but silently dropped there; that was the whole gap. So your emitter can now land
> semconv-correct keys (`gen_ai.usage.output_tokens`, `gen_ai.response.model`) directly via `attributes` on
> the completion, not only the `adorn.return.<name>` form. One clarification on the framing: your literal
> proposal — "`returns?: (value) => Attributes` emitted as values at `RETURN_INDEX`" — already worked with
> zero adorn change, because a *named* `EmittedValue` at `RETURN_INDEX` keys as `adorn.return.<name>`
> (DEC-075). Both channels now exist and coexist, and they mean different things: use `values` at
> `RETURN_INDEX` for the disclosure-gated return *rendering* under `adorn.return.*` (subject to
> `@Telemetry`/`@Sensitive` semantics if you ever route through them), and `completed.attributes` for
> arbitrary low-cardinality/semconv keys. `ObservedSpec` is your type — add the return-hook there; adorn ships
> no `observed()`. Verified green-twice: +3 tests (positioned path, scope path, coexistence with
> `adorn.return.<name>`); 75 suites / 1262. `dist` rebuilt.

> **→ adorn (L16 — under owner review, NOT built):** The gap is real and we agree there's no clean workaround
> today. But every fix touches the frozen core event model's documented invariant (`completed.error` is
> "present iff `outcome === 'threw'`"), and — the deeper issue — it asks the *observation* layer to carry a
> failure *verdict* that no contract expressed, which runs against this project's premise that a contract is
> the single source of truth (DEC-006). So the owner is weighing it directly rather than us shipping it under
> the red-team gate. The shape of the question: is "a returned value that means failure" (a) a raw telemetry
> flag the emitter sets by hand — off-thesis, a judgment living in plumbing, the validator-with-extras smell —
> or (b) a **postcondition evaluated in observe-only / non-throwing mode**: a *declared* predicate whose
> failure is reported through the existing `violation` channel (which the sink already maps to
> `recordException` + ERROR status), enforced-or-observed by trust level, exactly as DEC-008/DEC-018 already
> split enforce-and-throw from check-and-return. (b) is on-thesis and reuses machinery that already exists,
> but it is a larger design than a field, and it is the owner's call whether adorn takes a position on
> result-typed failure at all. We'll record the decision here once made. In the meantime neither `error?`
> under `outcome:'returned'` nor a standalone `failure?` fact is shipped — your emitter can, as a stopgap,
> emit a `message` event at `level:'error'` (it lands a span event today but does not set span status), or
> carry an `attributes` flag on the completion via the L17 channel above.

> **→ adorn (L16 update — Position 1 accepted for now, red-team gated):** Owner's call: green is correct. A
> call that RETURNS a well-formed `Answer` — `{kind:'failed'}` included — succeeded: it returned what its
> type promises, in 1.3 s. The *reasoning* failed, which is a payload fact, not a span error. That matches
> OpenTelemetry's own convention: a successful operation carrying a business-negative result is `Ok`/`Unset`,
> not `ERROR`; `ERROR` is for when the operation ITSELF fails — a throw, which your design deliberately avoids.
> So keep the span green and emit the domain outcome as a low-cardinality attribute on the completion —
> e.g. `reasoning.outcome = "failed"`, `reasoning.failure.reason = "rate_limited"` — through the
> `completed.attributes` channel L17 just opened. Your backend filters and alerts on those attributes; the
> only thing an ERROR status would add is the red colour, which for a business-negative is miscategorisation.
> **One guardrail from the red-team pass:** `completed.attributes` is the low-cardinality, developer-authored
> channel and it BYPASSES the disclosure resolver (unlike `values`/`EmittedValue`, which redact by default).
> Keep `failure.reason` a bounded CATEGORY — never raw vendor error text or prompt content — both for privacy
> (it is not redacted on this path) and for attribute cardinality. **Position 2 (an observe-only / non-throwing
> postcondition) stays open** as a possible future direction, but it is NOT a consistency fix and will not be
> built as one; it depends on a separate, pending decision about whether adorn's non-throwing surface is a
> general convention at all (under investigation now — the honest answer looks like "`Verify.check` is a
> deliberately scoped boundary tool, DEC-053", not a throughout-convention).
