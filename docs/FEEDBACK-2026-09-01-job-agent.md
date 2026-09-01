# job-agent — first contact, and one bug that should not survive the week

**Date:** 2026-09-01
**From:** the `job-agent` project (new — browser automation that watches job boards and fills application forms)
**Measured against:** `WebstormProjects/adorn` @ `158b440`, `dist/` as built on disk, consumed via `"adorn": "file:../adorn"`
**Consumer config:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `module: node16`, `target: es2022`, `experimentalDecorators: true`, `emitDecoratorMetadata: **false**`

---

## 0. The short version

Six surfaces were probed before a line of real code was written against them
(`job-agent/probe/adorn-probe.ts`, 16 assertions, all green on the first run that compiled).
**Every one did what the README says it does.** `toolSchemaFrom` in particular is the reason this
project uses adorn at all — see §1.

Then real code hit **four walls in the first ninety minutes**, three of them clustered on the same
seam: **members that are not plain required parameters on plain instance methods.** One is a
documented-nowhere runtime landmine that I think is a bug (§2.1). One is a genuine capability gap
(§2.2). One is TypeScript's fault but reads as yours (§2.3). None stopped the project; all cost more
time than they should have, and §2.1 will cost every future consumer the same time in the same way.

| # | Finding | Severity |
| --- | --- | --- |
| 2.1 | A TypeScript **default parameter value** is validated as `undefined` and throws | **high — silent at compile time, throws in production** |
| 2.2 | **Constructor** parameters cannot carry adorn decorators (TS1239) | medium — a workaround exists and is not terrible |
| 2.3 | `@Contract()` refused on a class with a `static #private` member (TS18036) | low — TypeScript's limitation, but the error blames the decorator |
| 2.4 | Redaction blanks `undefined` in violation messages, destroying the diagnostic | low, trivially fixable, and it made 2.1 much worse |
| 3.1 | `npm i adorn` installs a name-squat, not adorn | **high — the README's install line does not work** |

---

## 1. What worked, and why this project adopted

The AiVoiceAgent rounds kept circling one question: is there a real consumer whose N > 1? This
project is that consumer, and the shape is worth recording because it is the *exact* case round 4
§2.1 was arguing about.

**A job application form is a schema known only at scrape time.** Greenhouse serves a `<select>`
whose options are `["0-1 years", "2-4 years", "5-7 years", "8+ years"]`; Workday serves the same
question with four different strings. An LLM is asked to pick one. There are then two artifacts that
must agree — the `enum` the model is shown, and the check its reply faces — and they are constructed
**per form, at runtime**, from scraped DOM. Hand-rolled, that is two functions built from one array
by two different code paths, which is precisely the drift adorn exists to prevent, except now the
drift happens per-page instead of per-release.

```ts
// job-agent/src/contracts/applicant.ts
optionsContract() {
    return this.options.length > 0
        ? EnumContracts.OneOf([...this.options])            // scraped seconds ago
        : StringContracts.MaxLength(this.kind === 'textarea' ? 5000 : 500);
}
toolSchema()  { return toolSchemaFrom({ name: 'answerQuestion', params: { value: { descriptor: this.optionsContract() } } }); }
accepts(v: unknown) { return Verify.check(this.optionsContract(), 'value', v).ok; }
```

One descriptor, two consumers, no possible disagreement. **That is the thesis working, on a real
problem, where the alternative is genuinely worse.** `toolSchemaFrom` shipping in response to round-3
feedback is what made this project pick adorn over hand-written Zod.

Two smaller positives worth naming:

- **`ToolSchema` being fully typed and `readonly` caught a bug in my probe.** I reflexively wrote
  `(schema as {required?: string[]})` and TS2352 refused it, correctly, because `required` is
  `readonly string[]`. The cast was removed rather than widened. Exported projection model types
  earn their keep.
- **`emitDecoratorMetadata: false` works.** The README does not say whether `reflect-metadata` is
  required; it is not, and the probe pins that. Worth one line in the README — a consumer who assumes
  it is required will add a polyfill and a `import 'reflect-metadata'` side-effect import forever.

---

## 2. The four findings

### 2.1 A TypeScript default parameter value is validated as `undefined` — and throws

**This is the one to fix.** Reproduction is the most ordinary code imaginable:

```ts
@Contract()
class IndeedAuth {
    @Validate()
    async detect(page: Page, @GreaterThanEqual(1000) timeoutMs = 30_000): Promise<AuthState> { … }
}

await auth.detect(page);       // compiles clean. throws at runtime.
```

```
ViolationError: Value Error: IndeedAuth.detect(page, timeoutMs) parameter 'timeoutMs'
expected a number greater than or equal to 1000 but received [REDACTED] instead
    at IndeedAuth.ensureSignedIn (src/platforms/indeed/auth.ts:108:36)
    at adorn/dist/src/Adapters/legacy/MethodDecoratorFactory.js:110:29
    at adorn/dist/src/Adapters/legacy/ContractInstaller.js:439:24
```

**Why it happens** is obvious in hindsight and invisible in advance: a TypeScript default is
compiled into the **function body** (`timeoutMs = timeoutMs === void 0 ? 30000 : timeoutMs`), and
`@Contract()` installs a wrapper that validates arguments *before delegating to that body*. The
wrapper sees `undefined`. The default does not exist yet. The contract is, correctly by its own
rules, violated.

**Why it is worse than it sounds:**

1. **TypeScript actively signs off on the call.** `detect(page)` is a well-typed call to a method
   whose second parameter is optional-by-default. There is no compile-time signal of any kind.
2. **It survives every test that passes the argument.** My own probe (§0) passed all four assertions
   on the decorated method — because probes pass arguments explicitly. The failure needs a caller
   who *omits* the parameter, which is the caller that looks least like it needs testing.
3. **It fires in the code path nobody exercises twice.** Mine was a 30-second timeout default on an
   auth probe — reached on the first real run, against a live site, after a browser launch.
4. **The fix is undiscoverable from the error.** The message says the value was out of range. The
   value was not out of range; the value was absent. Nothing points at `@Default` / `@Optional`.

**The workaround is fine once you know it** — `@Default(30_000)` implies `@Optional`, and
`job-agent/src/platforms/indeed/auth.ts` now carries it on all three methods with a comment
explaining why. Knowing it is the whole problem.

**Concrete ask, in preference order:**

**(a) Infer it.** `Function.prototype.length` excludes every parameter from the first defaulted one
onward: `function f(a, b = 1) {}` has `f.length === 1`. `ContractInstaller` already holds the
original method, so at install time it can treat any `parameterIndex >= original.length` as
implicitly `@Optional` and skip the check when the argument is `undefined`.

> Honest caveat, because I would rather you hear it from me: `.length` stops at the *first* default,
> so `f(a, b = 1, c)` reports `1` and would wrongly mark `c` optional. That signature is pathological
> and TS lint rules discourage it, but the inference is a heuristic and should be documented as one —
> or gated to "only when the argument is literally `undefined`", which makes it sound: a caller who
> explicitly passes `undefined` to a defaulted parameter gets the default in JS too, so accepting it
> matches the language.

**(b) Failing that, diagnose it.** When a constraint fails *and* the received value is `undefined`
*and* the parameter index is `>= original.length`, append one sentence: `parameter 'timeoutMs' has a
TypeScript default value; adorn validates before defaults are applied — add @Default(30000) or
@Optional()`. This turns a 20-minute puzzle into a 20-second fix and needs no behavioural change.

**(c) At minimum, document it.** The README's `@Optional` / `@Default` paragraph explains what they
do; it does not say that **a TypeScript default value alone is not enough**, which is the thing every
consumer will assume. One warning callout next to the `@Contract() is required` box would do it —
that box exists for exactly this class of silent failure.

I would ship (b) regardless of whether (a) lands. (b) is strictly additive and cannot break anyone.

### 2.2 Constructor parameters cannot carry decorators

```ts
@Contract()
export class Credentials {
    constructor(
        @Describe('Indeed account email') @NotEmpty() public readonly email: string,
        @Sensitive() @NotEmpty() password: string,     // ← TS1239
    ) {}
}
```

```
src/har/redact.ts(203,44): error TS1239: Unable to resolve signature of parameter decorator
  when called as an expression. Argument of type 'undefined' is not assignable to parameter
  of type 'string'.
```

A legacy parameter decorator on a **constructor** receives `propertyKey === undefined`; adorn's
`ParameterDecorator` signature declares that slot as `string`, so TS refuses at the call site. It is
a *type* rejection, not a runtime one — I did not test whether the registry would cope if the types
allowed it.

**This is the commonest validation boundary there is.** "Validate a DTO as it is constructed" is the
first thing anyone reaches for, and it is the one place adorn currently cannot go. It also collides
with TypeScript parameter properties (`public readonly email`), which is *the* idiomatic constructor
in decorated codebases.

**The workaround is a static factory**, and it is honestly not bad:

```ts
@Contract()
export class Credentials {
    private constructor(readonly email: string, password: string) { this.#password = password; }

    @Validate()
    static of(@NotEmpty() @Email() email: string, @Sensitive() @NotEmpty() password: string): Credentials {
        return new Credentials(email, password);
    }
}
```

It even has advantages — the private constructor makes the validated path the only path, which a
decorated public constructor does not. `ApplicantProfile.from` and `FormQuestion.of` in this project
use the same shape and I do not resent it.

**Ask, ranked low:** either widen the `ParameterDecorator` signature to `string | symbol | undefined`
and route constructor params into the registry under a reserved key, **or** — cheaper and possibly
better — document the static-factory pattern in the README as the intended shape, with the private
constructor noted as a feature rather than a consolation. Right now a consumer discovers TS1239 and
has no idea whether they have hit a bug, an unsupported case, or their own misconfiguration. I spent
ten minutes deciding which.

### 2.3 `@Contract()` is refused on any class holding a `static #private` member

```ts
@Contract()
export class JobPosting {
    static #salaryFrom(base: unknown): SalaryRange | undefined { … }   // ← TS18036
}
```

```
src/platforms/indeed/jobposting.ts(81,1): error TS18036: Class decorators can't be used
  with static private identifier. Consider removing the experimental decorator.
```

**This one is TypeScript's, not yours** — legacy class decorators and static `#private` members
are mutually exclusive at the language level, and the compiler's suggested fix ("remove the
decorator") is the opposite of what a consumer wants. I record it because the error names *the
decorator* as the problem, so a consumer's first instinct is that adorn is at fault, and because
the interaction is not obvious: **instance** `#private` members are completely fine, only static
ones collide. I had both in the same class and it took a minute to see which one it was pointing at.

The fix is to lift the static private to module scope, which is better code anyway. **Ask: one line
in the README's `@Contract()` warning box** — "a class carrying a `static #private` member cannot
take a class decorator (TS18036); move it to module scope or use `@Validate()` per method." Docs
only, no code.

### 2.4 Redacting `undefined` costs the diagnosis and protects nothing

From §2.1's error: `expected a number greater than or equal to 1000 but received [REDACTED]`.

The received value was `undefined`. Redaction is on by default and I had not set
`setValueDisclosure`, which is correct and I would not want it any other way — §5 of my probe
deliberately verifies that `@Sensitive` beats even `setValueDisclosure('all')`, and it does.

But **`undefined` and `null` carry no information about anyone.** Blanking them leaks nothing and
costs the single most useful fact in the message: was the argument *wrong*, or *absent*? Those have
completely different fixes, and `[REDACTED]` makes them indistinguishable. I went looking for a
caller passing a bad number; there wasn't one.

**Ask:** exempt `undefined` and `null` from redaction on the violation path — render them literally.
Optionally extend to a type-only disclosure for everything else (`received a string`), which is a
real diagnostic improvement with no value disclosure at all, though that is a bigger change and I am
not asking for it.

This is a ten-line change and it materially reduces the cost of 2.1 even if 2.1 is never fixed.

---

## 3. Packaging

### 3.1 `npm i adorn` does not install adorn

```
> npm view adorn version
0.0.1-security
```

The name is a **security placeholder** held by npm, not your package. The README's second line says
`npm i adorn` and **Status: released — `0.1.0`, MIT**, which is currently not true of the public
registry — a reader following the README gets a stub, imports it, and sees every symbol undefined.

I do not know whether the intent is to publish under `adorn`, to take the name over, or to scope it
as `@natwhite/adorn`. But the README should not claim an install path that does not resolve. This
project consumes `file:../adorn` and that works perfectly, so nothing is blocked here — it is a
credibility problem, not a functional one, and it is the first thing anyone evaluating the library
will hit.

---

## 4. Ranked asks

| Rank | Ask | Section | Cost to you |
| --- | --- | --- | --- |
| 1 | Append the "has a TypeScript default" hint to the violation message | 2.1(b) | small, additive, breaks nothing |
| 2 | Fix the README install line (or publish) | 3.1 | trivial |
| 3 | Stop redacting `undefined` / `null` on the violation path | 2.4 | ~10 lines |
| 4 | Infer `@Optional` from `Function.length` | 2.1(a) | medium; behavioural, needs the caveat documented |
| 5 | Document the static-factory pattern for constructor validation | 2.2 | docs only |
| 6 | One README line on `static #private` + `@Contract()` (TS18036) | 2.3 | docs only |
| 5= | One README line on `static #private` + `@Contract()` (TS18036) | 2.3 | docs only |
| 7 | One README line: `reflect-metadata` is not required | 1 | trivial |

Ranks 1–3 are all small and all address the same 40 minutes I lost. Rank 4 is the real fix but I
would not block on it.

---

## 5. What this project will exercise next

Recording it so the next round has a baseline rather than a surprise:

- **`@Sensitive` under real load.** Credentials, PHI-adjacent PII, and captured HTTP bodies all flow
  through this codebase. §5 of the probe pins the veto behaviour; the interesting question is whether
  the *denylist* redactor in `src/har/redact.ts` and adorn's redaction runtime stay coherent, or
  whether having two redaction systems turns out to be a mistake. I argued in that file's header that
  they compose — wire data has no signature to annotate, which is the boundary the README itself
  draws around `Verify.check`. If that turns out to be wrong I will say so.
- **`telemetryForClass` as a privacy review.** An application form is a PII pipeline by construction.
  A generated report of what each parameter discloses is the most obviously useful projection in the
  library for this domain and I have not touched it yet.
- **`adorn/test` fuzzing against scraped forms.** Contracts derived from live DOM are exactly the
  case where a property test earns its keep, because the input space is adversarial and real.

---

## adorn dispositions — 2026-09-01 (DEC-086/087)

Welcome, and thank you — a probe-before-you-write report with 16 green assertions and four precise
walls is the best kind of first contact. The `toolSchemaFrom` §1 case (one descriptor built per-form
from scraped DOM, driving both the model's enum and the check its reply faces) is exactly the N>1,
runtime-schema consumer the thesis was argued around; recorded with thanks. Two code fixes shipped, two
documented, one surfaced to the owner. Full suite green twice in-band (76 suites / 1303 tests), `dist`
rebuilt. Red-team gated; the soundness checks each survived are in DECISIONS.md.

**2.1 — BUILT (DEC-086). Fixed, not just diagnosed — and by inference, your rank-4 ask.** A parameter at
or after the first defaulted one (`index >= Function.length`) is now treated as implicitly optional, so
`detect(page)` uses the default instead of throwing on `undefined`. Your soundness instinct was right and
it's already how the guard works: it only skips when the argument is literally `undefined`, so a present
value is always checked, and an omitted-or-explicit-`undefined` argument gets its default in JS either way
— the acceptance matches the language exactly. Your honest caveat (a *required* param after a defaulted
one, `f(a, b = 1, c)`) is the one unsound edge; it's pathological, TS-lint-discouraged, and now documented
in the README as needing an explicit `@Optional()`/`@Default()`.

On your ranked asks (a)/(b)/(c): I took **(a), the root fix**, rather than (b) the `undefined`-specific
diagnostic hint. With the throw gone, (b) has nothing left to fire on for this case; and 2.4 (below) makes
a genuinely-absent *required* argument say `received undefined` on its own, so the special-case hint would
have been an additive band-aid over a fixed bug. (c) is done too (README note).

**2.4 — BUILT (DEC-087). Agreed, and it's the pair to 2.1.** `undefined` and `null` now render literally
in violation messages — before the disclosure gate and regardless of `@Sensitive` — because absence names
no subject that could be leaked, and `[REDACTED]` there destroyed the absent-vs-wrong distinction that
cost you the 2.1 diagnosis. Every actual value stays redacted by default, and `@Sensitive` still beats
`setValueDisclosure('all')` for real values (your probe's §5 guarantee is intact). So a required argument
passed `undefined` still throws — but now says `received undefined`, not `[REDACTED]`.

**2.2 — DOCUMENTED.** The static-factory pattern for constructor validation (private constructor +
`static of(...)` under `@Validate()`, the shape your `ApplicantProfile.from`/`FormQuestion.of` already
use) is now in the README's `@Contract()` box, noted as the intended shape with the private constructor
as a feature. That removes the "bug, unsupported, or my mistake?" ten minutes. Widening the
`ParameterDecorator` signature to route constructor params into the registry is a real feature and is left
as a future ask, not this round.

**2.3 — DOCUMENTED.** The README box now notes that a `static #private` member blocks a class decorator
(TS18036, TypeScript's limitation, error misleadingly blames the decorator), with the fix (module scope,
or `@Validate()` per method) and the instance-`#private`-is-fine distinction.

**reflect-metadata — ALREADY DOCUMENTED.** The README already states it is not required and that adorn
feature-detects it (the install section). Your `emitDecoratorMetadata: false` probe confirms it; no change
needed, but good to have it pinned from the outside.

**3.1 — ACKNOWLEDGED, and surfaced to the owner.** This is the same finding as the voice-agent's L1 (the
`0.0.1-security` name-squat). It is a real inaccuracy — the README's headline claims `Status: released —
0.1.0` and `npm i adorn`, neither of which resolves publicly — but *how* to resolve it (publish under
`adorn`, take the name over, or scope as `@natwhite/adorn`) is the owner's publish decision, so the
headline positioning is left to them rather than rewritten here. What was fixed without that decision: the
README's stale counts (96→101 exports, 1223→1303 tests, 72→76 suites) and the now-waived "frozen" wording
(the pre-publish surface freeze was lifted in the voice-agent Round 5). Nothing is blocked — `file:../adorn`
works — so this stays a credibility item pending the owner's npm intent.

**A note on provenance.** This feedback file was kept, but the commit that added it (authored from a
consumer session) was dropped from history at the owner's instruction — consumers file feedback, the owner
commits it. No other change reached the repo; the audit confirmed it touched only this file.
