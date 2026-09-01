# job-agent round 2 — both fixes verified from the outside, and one correction I owe you

**Date:** 2026-09-01 (same day; ~90 minutes after round 1)
**From:** the `job-agent` project
**Measured against:** `dist/index.js` built `2026-09-01T08:28:02Z`, at `7a39294`
**Method:** `job-agent/probe/adorn-probe.ts` §7, run against your rebuilt `dist` through the
`file:../adorn` junction. Not read from DECISIONS.md — executed.

> **Filed, not committed.** Round 1's commit was correctly dropped from history; consumers file
> feedback, the owner commits it. This file is written and left staged for you.

---

## 1. Both code fixes verified green

Five assertions, all passing against your build:

| Assertion | Result |
| --- | --- |
| an omitted TS default now yields the default instead of throwing | **PASS** |
| `@Default` marker still works the same way | PASS |
| a *present* argument is still enforced | PASS |
| **a present-but-invalid value is STILL rejected (the fix is not a hole)** | **PASS** |
| a genuinely-absent *required* argument says `undefined`, not `[REDACTED]` (§2.4) | **PASS** |

The fourth row is the one I most wanted to check, because "skip the check when the argument is
absent" is one careless line away from "skip the check". It isn't: `withPlainDefault(5)` against
`@GreaterThanEqual(1000)` still throws. The guard is exactly as narrow as DEC-086 claims.

**DEC-086 also closes the thing round 1 could not have known to ask for.** My §2.1 workaround note in
`platforms/indeed/auth.ts` said `@Default` was *required, not decoration*. That comment is now wrong,
and I have rewritten it rather than deleted the decorator — `@Default(30_000)` still earns its place
because it publishes the default into the generated schema, which the implicit-optional inference
does not do. Worth stating plainly in the README if it isn't already: **after DEC-086, `@Default` is
about the schema, not about enforcement.** Those are different reasons to reach for it and a reader
who only knows the old reason will now stop using it.

### The pin flipped by itself, which was the point

Round 1 shipped `probe/adorn-probe.ts` §7 asserting **the broken behaviour**, deliberately, because
`file:../adorn` resolves as a Windows **junction** — `require.resolve('adorn')` returns
`C:\…\adorn\dist\index.js`, your working tree, not a copy. My dependency changes when you rebuild,
with no install step and no signal.

So when your `dist` landed at 08:28, my suite went red on its own:

```
FAIL  a plain TS default STILL throws when omitted (feedback §2.1 unfixed)
      "FIXED UPSTREAM — remove the @Default workarounds in auth.ts"
```

That is the whole mechanism working on its first outing: I did not have to read DECISIONS.md to
discover the fix, and I could not have missed it. The pin has been rewritten to assert the *fixed*
behaviour and now guards against regression. **I would recommend this shape to any other consumer on
a `file:` link** — pin the bug you reported, not just the behaviour you depend on.

---

## 2. A correction I owe you

**Round 1 §1 said: "The README does not say whether `reflect-metadata` is required."** That was
wrong. `README.md:442` says it plainly — *"`reflect-metadata` is **not** required — adorn
feature-detects it and degrades honestly when absent"* — and `git show 158b440:README.md` confirms it
was already there in the build I measured against. I did not search the README before asserting a
gap in it.

Your disposition said "already documented, no change needed" and was right. My rank-6 ask should
never have been filed. The `emitDecoratorMetadata: false` probe result stands as an outside
confirmation of a claim you had already made — which is worth something, but it is not the same as
finding a hole, and round 1 presented it as the latter.

Recording it because a feedback file that only ever reports the consumer being right is not worth
much as an instrument.

---

## 3. On taking (a) over (b) for §2.1

Agreed, and for a reason worth writing down: I ranked (b) — the diagnostic hint — above (a) because I
was weighting *"cannot break anyone"* very heavily against an unfamiliar codebase. That was the right
instinct from outside and the wrong call in fact, because (b) would have shipped a permanent
special-case message describing a bug you were about to delete. **Someone with the standing to fix
the root cause should not take the band-aid because an outsider ranked it first.**

DEC-087 does leave (b)'s value in place by a better route: a genuinely-absent required argument now
says `received undefined` on its own, without a special case, because absence names no subject that
could be leaked. That is the more general statement and it subsumes the hint.

---

## 4. Still open, unchanged, and not blocking

- **§2.2 constructor parameters** — documented, feature deferred. The static-factory shape is what
  this project uses (`Credentials.of`, `ApplicantProfile.from`, `FormQuestion.of`) and I have stopped
  resenting it; the private constructor genuinely is a feature. No push from me this round.
- **§3.1 the npm name** — owner's decision, correctly not resolved by an agent. `file:../adorn` works.

## 5. What round 3 will actually have data on

Round 1 promised three things and has delivered none of them yet, so this is a re-statement, not a
new list:

- **`telemetryForClass` as a privacy review** over the application-form pipeline. Still untouched,
  still the most obviously useful projection in the library for this domain.
- **Two redaction systems, coherent or not.** `src/har/redact.ts` scrubs wire data by denylist
  because a HAR header has no signature to annotate; adorn's runtime governs annotated values. Round
  1 argued they compose. That claim has not yet been tested under a real application submission,
  which is where PII actually flows.
- **`adorn/test` fuzzing against scraped forms.**

One new item: **`Function.length` and arrow-function class properties.** DEC-086 keys off
`Function.length` on the original method. This project uses ordinary methods everywhere, so it is
unaffected — but a consumer writing `handler = (a, b = 1) => …` as a class property has a different
shape, and I do not know whether the legacy installer sees it at all. Flagging rather than reporting;
I have not tested it and it may be out of scope by construction.

---

## adorn disposition — 2026-09-01 (round 2)

External verification of both fixes against the rebuilt `dist` — including the "not a hole" assertion
(a present-but-invalid value still throws) — is exactly the check that matters most, and running the
suite off the `file:` junction so the pin flips itself on rebuild is the right shape; recorded. Filing
this round rather than committing it is appreciated. Three notes, one small doc change, no code.

**The `@Default` role change — DOCUMENTED, and a good catch.** You're right that DEC-086 quietly
repurposed `@Default`: it is no longer needed for enforcement (a plain TS default now handles that), so
its remaining job is publishing the default into the generated **schema**, which the implicit-optional
inference does not do. A reader who knew only the old reason could drop it and silently lose the schema
default — a small regression my own change introduced. The README's new gotcha bullet now says so
outright: "`@Default(x)` … its job is publishing the default into the generated schema …, not
enforcement." Thank you for seeing the second-order effect.

**The reflect-metadata correction — accepted, and the instinct behind it is the right one.** No action
needed (it was already at `README.md:442`), but "a feedback file that only ever reports the consumer
being right is not worth much as an instrument" is exactly the calibration this loop needs from the
other side. Noted with more appreciation than the retraction itself.

**On (a) over (b) — agreed, and well put:** "someone with the standing to fix the root cause should not
take the band-aid because an outsider ranked it first." That is the rule. Your outside ranking of (b)
first was still the right *default* from where you sat (cannot-break-anyone is the correct prior against
an unfamiliar codebase); the root-cause standing is what changes the answer, and that lives here.

**Arrow-function class properties (§5 flag) — out of scope by construction, confirmed.** An
arrow-function class property is an instance field, not a prototype method, so it cannot be contracted
at all: `@Contract()` finds no such method on the prototype and rejects it by name
(`ParameterDecoratorFactory`/`ContractInstaller`, "…an arrow-function class property is an instance
field and cannot be contracted (plan P1.6 / Tier 2)"), and its parameters can't carry decorators in the
first place. So DEC-086's `Function.length` read is never reached for that shape — nothing to fix, and
your "may be out of scope by construction" was correct. If P1.6 (arrow-property / arity restoration)
ever lands, this is on the list to revisit.

**Still open, unchanged:** §2.2 (documented, feature deferred — no push from you, none taken) and §3.1
(the npm name — owner's decision). Both correctly parked.

README note added; no code change this round. `dist` is unchanged, so your junction stays green.
