# adorn — `@Sensitive` and the sensitive-flow detector

*Shipped 2026-07-21. Implements the design ratified in `sensitive-flow-spike.md` §15 (recommendation), governed by DEC-025 (trust boundary), DEC-026 / DEC-027 (the one-pass intraprocedural detector), DEC-028 (the shipped marker + detector), DEC-030 (safe-by-default redaction), and DEC-PII-1/2/5 (the marker). This document is the user-facing surface for both pieces.*

---

## Read this first — what adorn does and does not protect

**adorn secures its _own_ emissions. It does not, and cannot, stop you leaking a sensitive value yourself.**

In the user's words, which set the boundary this whole feature is built to (DEC-025):

> *"we're not protecting against bad developers, we're protecting our own output — so as long as they stay within the framework and aren't malicious with logging they should be fine."*

Concretely:

- Marking `User.ssn` as `@Sensitive` makes adorn's own emitters — `@Log` and contract-violation messages today (DEC-030), telemetry later — keep it redacted **even when raw-value disclosure is switched on** (`setValueDisclosure('all')`). Those emitters already redact every value by default; the marking is the veto that survives an explicit opt-in.
- A raw ``console.log(`${user.ssn}`)``, a hand-rolled logger, a third-party library that logs its own copy, `JSON.stringify(user)` in your own code — **adorn was never in those call paths, and no library can intercept them.** They are yours.

This is the same boundary an OpenTelemetry instrumentation library draws: it secures the attributes _it_ emits, not your application's `printf`. **Do not let "adorn protects my PII" become the shorthand.** A developer who marks a field and stops thinking is worse off than one who never marked anything, because they have stopped looking (`pii-redaction-plan.md` §11.2).

---

## Part 1 — `@Sensitive`, the marker

`@Sensitive` is a **record-only** decorator: it _marks_, and it installs no accessor. It does **not** transform or hide the value itself — a `@Sensitive` field is still an ordinary readable, writable, enumerable, serialisable property. What reads the marking is the **redaction runtime**, which has since shipped (safe-by-default emission from `@Log` and violation messages — BUG-18/BUG-19, **DEC-030**). That runtime redacts every value adorn emits **by default, without consulting any marking**; a `@Sensitive` marking only ever adds *stronger* protection, by vetoing an explicit `setValueDisclosure('all')` opt-in on the marked site. So the marking is defence-in-depth — never the thing that makes an emission safe.

It applies to **fields, parameters, and classes**:

```ts
import {Sensitive} from 'adorn';

@Sensitive() // the whole class is sensitive — every field
class PaymentInstrument {
    pan = '';
}

class Customer {
    @Sensitive() ssn = ''; // a sensitive field — propagates through object-typed parameters
    name = '';
}

class AuditService {
    // A primitive parameter MUST be marked on the parameter — see "the primitive gap" below.
    record(actor: string, @Sensitive() ssn: string): void {}
}
```

### Inheritance-safety, for free

A `@Sensitive` field marking is **inheritance-safe in the DEC-021 sense: a subclass cannot _un-mark_ an inherited sensitive field.** This is not a new mechanism — it reuses the field band's own-scoped-storage + prototype-chain-union resolution exactly. A marking recorded on a parent is found by walking the chain; there is no write API that reaches an ancestor to remove it, so **weakening is unexpressible, not merely rejected.** A subclass that redeclares an inherited `@Sensitive` field without the marker is still sensitive; a subclass of a `@Sensitive` class is itself sensitive.

### The primitive-parameter gap (DEC-PII-5) — permanent, and stated in the same breath

`transfer(user: User)` where `User.ssn` is `@Sensitive` can be redacted from the field declaration. `transfer(ssn: string)` **cannot** — the value is a primitive and the connection to `User.ssn` was destroyed at the call site by JavaScript's value semantics. The information does not exist in the callee's frame. There is no automated fallback that does not manufacture false confidence (three independent spikes each failed to close this gap, by three different mechanisms).

So: **for a primitive parameter, mark the parameter.** `record(@Sensitive() ssn: string)`. The honest claim is _"mark a field once and object-typed parameters redact automatically"_ — never _"mark a field once and you are covered."_

### Forward-compatible shape

The marking is stored as a small object, `{level: 'sensitive'}`, not a bare boolean. The `pii-redaction-plan.md` proposes a three-valued lattice (`Safe` / `Unsafe` / `DoNotLog`, after Palantir `safe-logging`), where the strongest level would veto even an explicit opt-in. That _behaviour_ is not built here, but `@Sensitive({level})` and the stored shape have room for it: the later runtime widens the level set with **no data migration.** `SensitiveOptions` is exported for that forward shape.

---

## Part 2 — the sensitive-flow detector

`tools/sensitive-flow/` is **build-time tooling, not library code.** It is excluded from the library build, never reaches `dist/` or the runtime export surface, and is exercised by `npm test`. It reports where a `@Sensitive` value reaches one of adorn's **own** emitters.

### The closed sink set (derived from the codebase, not guessed — DEC-025)

Because adorn secures only its own emissions, the sink set is closed and enumerable:

| Sink   | What it is                                                    | Source                                        |
| ------ | ------------------------------------------------------------ | --------------------------------------------- |
| **S1** | a parameter of a method decorated `@Log()` (renders _every_ argument) | `src/MethodDecorators/Log.ts:92` (BUG-18)     |
| **S2** | a parameter carrying an adorn constraint decorator (the violation message interpolates the received value) | `src/Core/Descriptor.ts:314→323` (BUG-19)     |
| **S3** | a parameter carrying the proposed `@Telemetry.value()`       | _not implemented_ — a future sink, not invented |

**Deliberately _not_ sinks**, each exclusion load-bearing:

- **`@Time()` is not a sink.** It emits a label and a duration, never an argument value. Treating "adorn-decorated" as "emits" would re-inflate the false-positive rate the trust boundary exists to reduce.
- **Field violation messages** — a field is covered by `@Sensitive` on the field directly.
- **`console.log` and everything else in application code** — out of adorn's trust boundary.

### What it catches

A `@Sensitive` value reaching a sink parameter — directly, or through the **intraprocedural** shapes the local propagator follows within one function body: local `const` aliases (`const copy = s.ssn; sink(copy)`), **template-literal interpolation** (``sink(`${s.ssn}`)`` — the most common leak shape in JavaScript), literal-keyed element access (`s['ssn']`), and destructuring (`const {ssn} = s`). No cross-function reasoning: that is the deferred interprocedural version (IDEA-11, DEC-028).

### The permanent floor — a known, accepted limitation

**`s.ssn.slice(-4)` is caught by nothing, at any budget.** Runtime observation misses it, substring matching misses it, and an off-the-shelf static engine would declare it _clean_. Deciding whether `.slice(-4)` sanitises an SSN is a **regulatory judgement** (PCI-DSS 3.5.1.1 requires a keyed hash of the entire PAN; GDPR Recital 26 keeps truncated/pseudonymised data in scope), and that is not a decorator library's decision to make. This is the accepted limit. The tests pin it as **not caught**, so a future change cannot silently "improve" it into a sanitizer policy adorn must not ship.

### The scope report — the detector is never silently clean

A one-pass detector under a narrowed threat model partitions real leaks into _reported_ (into an adorn sink) and _permanently unreported_ (out through a raw `console.log` or a non-adorn function). A clean leak report that hid the second class would be the false-confidence failure worse than no design. So the detector **prints its own scope on every run** (DEC-026 point 4), via `formatScopeReport`. It always states:

1. **What it analysed** — every adorn emission position found (the denominator). A clean run says _"Analysed N positions"_, so "clean" and "never run" are distinguishable. A run over code with no emitters says so explicitly — _"a clean result here means nothing to analyse, NOT no sensitive data leaks."_
2. **The leaks** — the actionable findings.
3. **Out of scope** — every `@Sensitive` value it saw flowing to a receiver adorn does not own, **named**, so a clean `Leaks: none` is never mistaken for a clean bill of health. These are the developer's responsibility.

### Delivery: an ESLint rule over a shared analysis core (report-only, permanently)

- **The core** (`analysis.ts`, `analyzeProgram` / `findCallFindings`) takes an already-built `ts.Program` — exactly what a typescript-eslint rule holds via parser services, and what a CLI holds from `ts.createProgram`.
- **The ESLint rule** (`rule.ts`, `no-sensitive-to-adorn-sink`) is a thin adapter: it obtains parser services and forwards each call to the core. It is **report-only, permanently** — it declares no fixer and never will, because the fix target (the callee's parameter) is usually in a different file, which an ESLint fix cannot reach, and advertising a fixer it can deliver only sometimes would train exactly the over-trust this area exists to prevent.
- **A future CLI** (`adorn check`, IDEA-9) is a thin wrapper over the same core: build a program, call `analyzeProgram`, print `formatScopeReport`, exit non-zero on any leak.

### Legality is derived from compiled probes, not AST node kinds (SMELL-19)

Whether a method can host `@Log` — and therefore whether its parameters can be a sink — is decided by a **compiled probe table** (`legality.ts`), not by reading node kinds. This is the SMELL-19 correction: the spike's classifier wrongly called a class-_expression_ method decorator-legal where the compiler says TS1206. The shipped detector distinguishes a class _declaration_ method (a legal `@Log` host, hence a possible sink) from a class _expression_ method (illegal, hence never a sink), grounded in what the compiler actually accepts.
