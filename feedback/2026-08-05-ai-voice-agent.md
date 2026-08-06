# Feedback on `adorn` — from the AiVoiceAgent-node build

**Date:** 2026-08-05
**From:** the `AiVoiceAgent-node` project (a Twilio ConversationRelay re-architecture test bed)
**Round:** 3 — the first round after `Verify.check`, `@Dictionary`/`@Shape`, and the Wave-2 vocabulary

Round 2 said **do not adopt**, on two blockers. You closed both in one cycle. The verdict is still no,
but for different and much smaller reasons, and I want that framing up front rather than buried:
**this round is a near miss, not a rejection**, and §1 and §2 below are the two additive changes that
would flip it.

Two things are different this time, and both make the feedback worth more:

- Round 2 marked its central adoption analysis **UNVERIFIED**, because the endpoint it judged did not
  exist yet — it was reading a design doc. **That code now ships.** Everything below compares adorn
  against the real `parseAnswerBody` (`AiVoiceAgent-node/src/web/server.ts:322-362`), not a
  description of it.
- Round 2 could not evaluate the LLM tool-calling case at all, because there was no LLM work started
  and the inbound union was smaller. That has changed too — see §7, which is the most positive
  section in three rounds of these documents.

Every factual claim carries a `file:line` citation and a **Verify** line. Please check them; if any
of them is wrong the rest deserves less weight, and I would rather you found that out cheaply. Claims
I could not check are in [Unverified](#unverified).

The longer internal version — full side-by-side code, the probe sources, and the per-item history —
is at `AiVoiceAgent-node/docs/adorn-feedback.md`, which preserves rounds 1 and 2 unedited.

---

## The context that shapes all of this

Unchanged from round 2, and you should still weight the feedback accordingly:

1. **Zero runtime dependencies.** `package.json` has no `"dependencies"` key. A first one is a real
   threshold.
2. **Failures are returned typed values, never thrown** (its DEC-018). Non-negotiable.
3. **Its governing principle is to stay minimal** and delete anything not exercised.

A project with a normal dependency budget would weigh §5 differently. Nothing here argues adorn is too
heavy in general.

---

## Scoring round 2

| Round-2 item | Status | Evidence |
| --- | --- | --- |
| §2 `@Shape`/GAP-16 — object shapes inexpressible, the deciding blocker | **FIXED** | `src/Contracts/object.ts:87` (`Dictionary`), `:166` (`Shape`); GAP-16 FIXED at `docs/ISSUES.md:84`. Verified against hostile input, not read off the tracker — §6. |
| §3 Throwing failure mode / unexported `ViolationError` | **FIXED where it mattered** | `Verify.check` at `src/Validation/Verify.ts:136`, `CheckResult` at `:82-89`, re-exported at `index.ts:44`. `ViolationError` still unexported, and I no longer think that matters. |
| §4 Nothing narrows `unknown` | **NOT FIXED** | `src/Core/Descriptor.ts:72` unchanged; `check<T>(…, value: T): CheckResult<T>` infers `T` from the input. Compiler-verified — §2. |
| §5 `tslib ^1.10.0` two majors behind | **FIXED** | `package.json:46` → `^2.8.1`; GAP-18 at `docs/ISSUES.md:86`. |
| §1 Documentation does not ship | **NOT FIXED — and your pushback was right** | GAP-17 `OPEN (scheduled)` at `docs/ISSUES.md:85`. Numbers moved the wrong way: `index.ts` 162 → **188** `//` lines; `dist/index.d.ts` still **1**. |
| Round-1 carryover: `ConstraintDescriptor` unexported | **NOT FIXED** | 0 matches in `dist/index.d.ts` — and it is now the declared parameter type of `Dictionary` (`src/Contracts/object.ts:87`), your newest public API. |

**On GAP-17 specifically:** you rejected my proposed fix and were correct to. JSDoc on an
`export {X}` specifier documents the re-export, not `NumberContracts.Between` reached through a
namespace import — my suggestion would not have solved the trap I actually hit. Your diagnosis
(JSDoc on the source declarations) is the right one. Recorded because a reviewer being wrong should
be as legible as a library being wrong.

> **Verify (one block):**
> ```powershell
> (Get-Content index.ts | Select-String '^\s*//').Count            # 188
> (Get-Content dist\index.d.ts | Select-String '^\s*//').Count     # 1
> (Select-String dist\index.d.ts -Pattern '\bConstraintDescriptor\b').Count  # 0
> ```

---

## Ranked actions

### 1. Attach the failing key to a `CheckResult` — this is now the #1 blocker

`Verify.check` was the right thing to build and I use it happily on primitives. It does not survive
contact with a **compositional** descriptor, because a compositional descriptor collapses to one
boolean and one `describe()` string.

Observed, from a probe running `Verify.check(ObjectContracts.Dictionary(StringContracts.NotEmpty()), 'slotInput', …)`:

| Input | adorn's message |
| --- | --- |
| `{"when": 5}` | `slotInput expected an object mapping string keys to a non-empty string` |
| `"nope"` | *byte-identical to the row above* |
| `[]` | *byte-identical to the row above* |

The hand-written parser this would replace says `slotInput.when must be a string`
(`AiVoiceAgent-node/src/web/server.ts:356`). A caller who sent one bad value in a ten-key map is told
the map is wrong, not which entry — and this endpoint is on an unauthenticated public port whose
browser client shows that string to a human.

`@Shape` is worse because it covers more fields. Observed, over
`{seq, optionId, slotInput}` modelled as a `@Shape`:

```
  slotInput ABSENT     -> ERR Value Error: body expected an object with fields seq, optionId, slotInput
  slotInput null       -> ERR Value Error: body expected an object with fields seq, optionId, slotInput
  bad seq              -> ERR Value Error: body expected an object with fields seq, optionId, slotInput
```

**One message for three unrelated failures.** A `400` built from that tells the client nothing.

**The information exists and is thrown away.** `isDictionary` (`src/Contracts/object.ts:59`) and
`isShape` (`:120-122`) both use `Array.prototype.every`, which knows the failing key at the moment it
returns `false`; `Predicate`'s `boolean` return type discards it.

**Action:** a `path?: string` (or `path?: readonly string[]` for nesting) on the `ok: false` arm of
`CheckResult`. This is purely additive to a type you shipped three commits ago, and it is what makes
`Verify.check` usable for the job it was built for.

> **Verify:** `src/Contracts/object.ts:59` and `:120-122` — neither `every` callback can report which
> key failed; then `src/Contracts/object.ts:67-68` and `:145`, where `describe` takes only `params`.

---

### 2. Give the compositional descriptors a phantom output type — cheaper than IDEA-28 assumes

`docs/ISSUES.md:157` folds this into `@Shape` and calls it "explicitly **structural** … a significant
type change against the current `strict:false` tsconfig."

I tested that. **The incremental slice is type-only and needs no change to adorn's runtime at all.**

First, the current state, compiler-verified (`tsc --noEmit`, exit `2`, verbatim):

```
p2_narrow.ts(12,11): error TS2322: Type 'unknown' is not assignable to type 'string'.   // Verify.check
p2_narrow.ts(17,7):  error TS2322: Type 'unknown' is not assignable to type 'string'.   // Verify.that
p2_narrow.ts(23,11): error TS2322: Type 'unknown' is not assignable to type 'number'.   // .predicate() as a guard
p2_narrow.ts(30,11): error TS2322: Type 'unknown' is not assignable to type 'Readonly<Record<string, string>>'.  // Dictionary
```

Line 12 is the important one: `if (checked.ok) { const s: string = checked.value }`. `CheckResult<T>`
is *one type parameter away* from being right — `{ok: true; value: T}` is exactly the correct shape,
`T` is just bound to the input rather than to what the constraint proves.

Then the fix, implemented **entirely in consumer-land over the shipped package**:

```ts
type Typed<T> = ReturnType<typeof StringContracts.NotEmpty> & {readonly __out?: (arg: never) => T};

function checkTyped<T>(constraint: Typed<T>, keyName: string, value: unknown):
    {readonly ok: true; readonly value: T} | {readonly ok: false; readonly message: string} {
    const r = Verify.check(constraint, keyName, value);
    return r.ok ? {ok: true, value: r.value as T} : {ok: false, message: r.message};
}

const NonEmptyString = (): Typed<string> => StringContracts.NotEmpty() as Typed<string>;
const DictOf = <V,>(v: Typed<V>): Typed<Record<string, V>> =>
    ObjectContracts.Dictionary(v) as unknown as Typed<Record<string, V>>;
const ListOf = <V,>(v: Typed<V>): Typed<V[]> =>
    ArrayContracts.ArrayOf(v) as unknown as Typed<V[]>;
```

`tsc` exit **0** under `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, with
every `checkTyped(...)` narrowing `unknown` to `string`, `number`, `Record<string, string>` and
`readonly string[]`. Runtime unchanged — observed:

```
dict of strings, good  -> true
dict of strings, bad   -> false
list of strings, good  -> true
list of strings, bad   -> false
```

The single cast (`r.value as T`) sits immediately after the predicate returned `true`, which is
exactly where a validator's cast belongs. The compositional constructors propagate the phantom
naturally because they already take descriptors as arguments — `Dictionary`, `ArrayOf`, `Nullable`
and `Shape` are the four that matter, and they are the four you just built.

**Why this decides adoption.** Written against the current API, the adorn rewrite of our body parser
has **six** `as` casts; the hand-written one has **one**, discharged by the `typeof` gate directly
above it. A body validator whose adoption *increases* the count of unchecked assertions in the file
has inverted its own purpose. With this change the adorn version is six casts shorter than what we
have.

> **Verify:** compile the snippet above against `adorn` under `strict`. It is self-contained.

---

### 3. `@ArrayOf(X) @OneOf([…])` stacks into an unsatisfiable constraint, silently

The sharpest LLM-usability trap in the current surface, because **the wrong spelling is the more
obvious one** — `ArrayOf` and `OneOf` are both flat parameter decorators, so stacking them reads
naturally, while the correct form requires knowing the `EnumContracts` namespace.

Observed:

```
  wrong(["p-alice"])     -> THROW
  wrong([])              -> THROW
  right(["p-alice"])     -> PASS
  right(["p-zed"])       -> THROW
  wrong schema: {"type":"array","enum":["p-alice","p-bob"],"items":{"type":"string","minLength":1}}
  right schema: {"type":"array","items":{"enum":["p-alice","p-bob"]}}
```

where `wrong` is `@ArrayOf(StringContracts.NotEmpty()) @OneOf(ROSTER) subjects: string[]` and `right`
is `@ArrayOf(EnumContracts.OneOf(ROSTER)) subjects: string[]`.

Stacked constraints are a conjunction, so `wrong` requires the **array itself** to be a roster member.
Nothing satisfies it — `wrong([])` throws too. It compiles, it projects a plausible-looking schema,
and it rejects 100% of inputs with no diagnostic. The emitted
`{"type":"array","enum":[<strings>],"items":{…}}` is unsatisfiable as a schema as well.

This one is disqualifying for a tool layer specifically: a tool that rejects every argument a model
sends, with a schema that looks correct, fails in production rather than at decoration.

**Action:** detect it at decoration. `combineKeyword`/`CONFLICT` (`src/Projections/schema.ts:642`)
already reasons about keyword conflicts; an `enum` whose members are all of a type disjoint from a
sibling `type` keyword is the same class of check. A `ContractDiagnostics` warning would be enough.

> **Verify:** decorate one parameter with both and call it with anything, including `[]`.

---

### 4. Say in the README that half the library needs no decorators

This is the highest-value **documentation** change available and it is one paragraph.

Round 2's objection #6 was that adopting adorn means `experimentalDecorators` +
`emitDecoratorMetadata` repo-wide, which per your own DEC-004 forecloses esbuild, SWC, Vite and Bun.
**That is simply false for the `Verify.check` + `*Contracts` path.**

I compiled the full adorn rewrite of our body parser against **the consuming project's own
`tsconfig.json`, copied verbatim** — only `include` and `outDir` retargeted, no decorator flags added.
Observed:

```
tsc exit: 0
compiled and ran with NO experimentalDecorators
{"kind":"ok","seq":2,"optionId":"a","slotInput":{"when":"noon"}}
{"kind":"error","message":"Value Error: slotInput expected an object mapping string keys to a non-empty string but received [REDACTED] instead"}
```

Round 2 priced adoption at "a first runtime dependency **plus** repo-wide legacy decorators." Half of
that price does not exist, and there is no way for a reader to know: `README.md:3` opens with
"TypeScript decorators that treat a contract as **data**", and `README.md:40`'s `Verify.check`
pointer does not mention that it carries no toolchain constraint. For a library whose most-cited adoption objection is the decorator tax, this
is free ground.

> **Verify:** compile any `Verify.check` + `*Contracts` file with `experimentalDecorators` absent.

---

### 5. Add a descriptor-first tool-schema entry point

`toolSchemaForMethod` reads the decorator registry, which is fixed at module load. That makes a
**per-session** enum unexpressible in the projection — and per-session enums are the live case here.

Round 2 flagged this as a concept ("a runtime-supplied variant of `@OneOf`"). Round 3 can be concrete:
our roster is sent to the client once per call (`AiVoiceAgent-node/src/web/wire.ts:118-121`) because
the slot descriptor names a `subjects` field it never enumerates. The valid patient ids exist only at
session start.

**adorn already solves the hard half.** A descriptor is just a function call, so this works today:

```
{"name":"affirmFor","input_schema":{"type":"object","properties":{"subjects":
  {"type":"array","items":{"enum":["p-dave","p-erin"]}}},"required":["subjects"],"additionalProperties":false}}
  check ["p-dave"] -> true
  check ["p-zed"]  -> false
```

built from `ArrayContracts.ArrayOf(EnumContracts.OneOf([...roster]))`, reading `.schema()` for the
tool definition and passing the same descriptor to `Verify.check` for the model's reply. One
declaration, per session, both artifacts. That is your thesis working under genuinely dynamic data,
and it is a better demo than anything in the README.

What is missing is only the convenience: assembling `{type:'object', properties, required,
additionalProperties:false}` by hand around the fragments. A
`toolSchemaFrom({name, description, params: {subjects: descriptor}})` — descriptors in, tool schema
out, no class required — would close it and reuses `tightenObjects` unchanged.

**This is my highest-value feature request for the LLM direction, ahead of any new constraint kind.**

> **Verify:** `ArrayContracts.ArrayOf(EnumContracts.OneOf(['a','b'])).schema?.()`.

---

### 6. Reconcile a no-drift claim that does not hold

`src/Projections/schema.ts:587-590`:

> "A FIXED-key object … is closed with `additionalProperties:false` and `required` = **every**
> property it emits … and **this matches enforcement exactly (no drift**; the sound top-level rule
> applied one level down)."

The `required` half is true and I verified it. The `additionalProperties` half is not. Observed:

```
  predicate(exact fields        ) = true
  predicate(extra key           ) = true
  predicate(extra key __proto__ ) = true
  predicate(missing field       ) = false
  tool schema for this param says additionalProperties: false
```

and through the decorator path, `splitFor({affirmed: [], denied: [], evil: 'x'})` → **PASS**.

The drift is in the *safe* direction (the model is held tighter than adorn enforces), so this is not a
hole. But it is a stated no-drift guarantee that does not hold, in the library whose thesis is that
projections cannot drift from enforcement — which is exactly the kind of claim that should be exact.

**Action:** either `isShape` enumerates `value`'s own keys and rejects unknown ones, or `schema.ts:590`
says `additionalProperties` is prescriptive-only. I lean toward the second: closing the runtime would
break the "object with more fields than the DTO models" case, which is a reasonable thing to accept.

> **Verify:** `src/Contracts/object.ts:115-124` (the predicate never enumerates own keys) against
> `src/Projections/schema.ts:603-610` (the tightener unconditionally emits `additionalProperties: false`).

---

### 7. Minor: `Enforce.*` stopped at Wave 0, which is where `@Shape` needs it most

`src/FieldDecorators/Enforce.ts:54-112` has 13 statics, all number/string primitives. None of
`oneOf`, `const`, `arrayOf`, `dictionary`, `shape`, `nullable`, `uuid`, `dateTime`, `ipv4`, `format`.

This bites `@Shape` specifically: `@Shape(FieldClass)` reads `FieldClass`'s **field** contracts, and
`Enforce.*` is where a consumer looks for one. I hit it immediately — `@Enforce(...)` is
`TS2348: Value of type 'typeof Enforce' is not callable`, and the working form is
`@CreateFieldDecorator(ArrayContracts.ArrayOf(StringContracts.NotEmpty()))`: two namespace imports
and a lower-level primitive. Your headline feature's prerequisite is the least ergonomic path in the
library.

> **Verify:** `(Select-String src\FieldDecorators\Enforce.ts -Pattern '^\s+static (\w+)').Count` → 13.

---

## What is genuinely good, and improved since round 2

**You closed both deciding blockers in one cycle, and I checked them properly rather than reading the
tracker.** Every row round 2 recorded as "PASS — unvalidated" now rejects. Observed:

```
slotInput num value        -> ERR  Value Error: slotInput expected an object mapping string keys to a non-empty string…
slotInput is string        -> ERR  (same)
slotInput array            -> ERR  (same)
seq zero                   -> ERR  Value Error: seq expected a number greater than or equal to 1…
```

`slotInput` was the field that decided the last verdict, and adorn can now express and enforce it.

**Splitting into `@Dictionary` and `@Shape` was a better decision than the request that prompted it.**
Round 2 asked for "a nested-object descriptor." Two kinds whose JSON Schema closure is *opposite*
would have needed a flag on the thing that most needs to be unambiguous. The reasoning is stated where
it belongs, in `src/Contracts/object.ts:4-14`.

**`Verify.check` is better than what I asked for.** I asked for `{ok, value} | {ok, violation}`. You
shipped `constraint` and `kind` on the failure arm (`src/Validation/Verify.ts:82-89`) — two fields I
did not think to request and would use, because they let a handler map a violation to a status code
programmatically instead of matching on message text. And the message is composed from the
caller-supplied `keyName` rather than an internal signature, so **it is safe to put in a 400 body
as-is** — which fixes round 2 §2.4's complaint that I did not restate this round because it stopped
being true.

**The recursive tool-schema tightener is the best artifact in the library.** Given this project's real
hardest union member — `splitFor {affirmed: SubjectId[], denied: SubjectId[]}` — it produced:

```json
{
  "title": "InboundClassifier.splitFor",
  "type": "object",
  "properties": {
    "payload": {
      "type": "object",
      "properties": {
        "affirmed": {"type": "array", "items": {"type": "string", "minLength": 1}},
        "denied":   {"type": "array", "items": {"type": "string", "minLength": 1}}
      },
      "required": ["affirmed", "denied"],
      "additionalProperties": false
    }
  },
  "required": ["payload"],
  "additionalProperties": false
}
```

Correct, provider-ready, two levels deep, from one declaration. Nothing in rounds 1 or 2 could produce
it. `@Optional` also behaves correctly one level up — a method with two optional params emitted both
in `properties` with `required: []`.

**The README's numbers are exactly right again.** It claims 94 exports / 63 suites / 1130 tests
(`README.md:5`); I observed 94, 63 and 1130. Third round running that this checks out, which is rarer
than it should be.

**And `README.md:40` shipped round 2's coercion note**, in one paragraph, in the right place,
including the `Verify.check` pointer. That was a suggestion about how to frame a strength, and it
landed better than I wrote it.

---

## The adoption verdict, stated plainly

**Still not adopted for this endpoint — but the reason has changed completely, and the remaining list
is two items long.**

Round 2 said no because adorn *could not do the job*. That is no longer true. Written today, the adorn
version of `parseAnswerBody` is 40 lines against the hand-written 41, compiles clean under `strict` +
`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` with no decorator flags, and validates every
field correctly. What stops it:

1. **Six `as` casts against one** (§2). `Verify.check` proves the value satisfies the constraint and
   then hands back `unknown`.
2. **The 400 body gets worse** (§1). `slotInput.when must be a string` degrades to a sentence
   identical across three different failures.

Two secondary facts, neither decisive: adorn validates but never **rebuilds**, so the `__proto__`
own-key that `JSON.parse` places is passed through into the accepted value (observed:
`__proto__ own-key survives into accepted slotInput? true ["when","__proto__"]`) — the hand-written
loop that strips it therefore stays either way; and the dependency count goes 0 → 2. Neither would
decide it alone.

**This verdict flips on §1 and §2.** With a `path` on the failure and a phantom output type, the adorn
version would be six casts shorter than what we ship, would produce *better* messages than the
hand-written version, and I would recommend adopting it. Both are additive; neither needs a redesign;
one of them I have already compiled.

---

## Where adorn now has a real case here — the LLM layer

Worth more than another feature request, because it is the first time one of these documents has said
yes to anything.

This project's next architectural swap is an LLM presentation layer: a model classifying free speech
into a closed inbound union (`AiVoiceAgent-node/src/core/events.ts:23-61`) and slot-filling it. I
built the real classifier against adorn as a probe. Three findings:

- **`@Shape` handles the union's hardest member correctly** (the schema quoted above).
- **`@Matches` and `@OneOf` collapse duplication that already exists here.** `dtmf` projects
  `{"type":"string","pattern":"^[0-9*#]+$"}` and rejects `'abc'` at runtime — and that same regex is
  independently hand-written at `AiVoiceAgent-node/src/cli/menu.ts:206`. Two copies of one rule, which
  is the exact drift your thesis names.
- **`@OneOf` reopens an option this project closed for want of it.** `menu.ts:226-232` records that a
  free-text goal-id slot was *removed* because it "handed the classifier an open string for a union
  DEC-003 closes on purpose." `@OneOf` is the mechanism that makes it safe again.

Conditional on §3 (a tool that rejects 100% of a model's arguments is disqualifying for this layer)
and §5 (without a descriptor-first entry point the per-session roster — the strongest single argument,
constrained decoding over the actual patient ids — stays unrealised). And gated on timing by this
project's own minimalism principle: there is no LLM here yet.

**Recorded recommendation on our side:** when that layer is built, evaluate adorn *first* rather than
as an alternative, and evaluate the **descriptor** path before the decorator path.

---

## Still true from round 2: the coercion case

Re-checked, one line: nothing has changed. `Predicate` is still not guard-shaped
(`src/Core/Descriptor.ts:72`), our renderer's readers are still total coercers inside a function still
guaranteed never to throw, and `README.md:40` now says so itself. Nothing to do.

---

## Unverified

Stated so nothing here is mistaken for a checked fact:

1. **No provider consumed the generated tool schemas.** They are judged provider-ready by inspection
   against the Anthropic/OpenAI `parameters` shape. No round trip was performed.
2. **Minification degrading parameter names** — still not reproduced. Taken on your README's word,
   stated against interest.
3. **`@adorn/test`, `@adorn/otel`, the CLI (`adorn check`/`docs`/`schema`), and the sensitive-flow
   detector** — not evaluated, no opinion offered.
4. **`@Requires`, `@Const`, `@Nullable`, and the string-format constraints** — read, not exercised.
5. **Round 1's `strict: false` declaration leak** — still only partially re-checked. Probes compiled
   clean under `strict`, but `getContractedClasses()` was not exercised.
6. **§6's drift was tested for extra keys only.** I did not test a `@Shape` field whose value is a
   getter or a `Proxy`, nor `@Shape` over an inheritance chain — all probe classes were flat.
7. **The consuming project's own test suite was not run**, because its `src/**` is being edited in
   parallel. Every claim about that codebase comes from reading committed files.

All observations above came from six probes compiled against the shipped package through a
`node_modules` junction (so resolution went through your real `exports` map), under the consuming
project's compiler flags, plus one run of your own suite: `npm test` → `63 passed, 63 total` /
`1130 passed, 1130 total` / `9.34 s`. Nothing in this repository was modified.
