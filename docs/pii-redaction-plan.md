# adorn — PII and Secret Redaction

*Research and design for declaring, propagating and enforcing sensitive-data redaction in adorn. Produced 2026-07-19.*

> **Status: proposal.** Nothing here is implemented and nothing here is ratified. The decision entries in §13 are written in `DECISIONS.md` style but live in this file deliberately — they are proposals, and `DECISIONS.md` is being edited concurrently.
>
> **How to read the claims.** §3 is *research*: everything is labelled **VERIFIED** (I read the primary source and it is linked) or **INFERRED** (it follows from something verified, but no source states it in those words). §4 is *measurement* — experiments I ran in this repo's environment, reproducible from the scripts described. §5 onward is *recommendation*. §12 lists what I could not confirm.
>
> **This document builds on `docs/observability-plan.md` §5.3 and does not restate it.** That document already establishes values-off-by-default, cites OpenTelemetry's Opt-In requirement level, and proposes `@Telemetry.value()` / `@Telemetry.redact()`. This document answers the question it left open: *where does the declaration of sensitivity live, and can it propagate?*

---

## 1. The question, and the short answer

The user's proposal, in their words:

> *"it would be even better if we could decorate the base PII field with `@Sensitive` so that any attempts to `@Log` a function that took it as a parameter would redact automatically, and we could potentially even alert on conditions where those fields are exposed."*

This is declare-once-at-the-source propagation — adorn's central thesis (DEC-006, `vision.md`'s "locality of intent") applied to privacy. **It is achievable, and it is worth building. It is also achievable for exactly one of the two shapes a parameter can take, and the boundary is not a matter of implementation effort — it is a property of JavaScript's value semantics.**

| Method signature | Can adorn redact `ssn` automatically from a `@Sensitive` field declaration? |
|---|---|
| `transfer(user: User)` where `User.ssn` is `@Sensitive` | **Yes.** And more reliably than the user's framing assumes — see §5.3. |
| `transfer(ssn: string)` | **No. Not now, not later, not with more cleverness.** §5.4. |

The primitive case is not a gap to be closed in a later phase. It is the load-bearing limitation of the whole approach, and §11 states what happens to a developer who does not know that.

**The central recommendation, stated once here and argued in §6:**

> **`@Sensitive` must never be load-bearing on any path.** Every path that can emit a value — telemetry attributes, log records, and violation messages — defaults to a safe rendering *without* consulting any annotation. `@Sensitive` then adds three things a safe default cannot: stronger redaction, propagation into object graphs, and an enumerable declaration that a report and a runtime alert can read.

The reason is simple and is the whole argument: forgetting an annotation is the normal case, not the exceptional one. A design in which forgetting `@Sensitive` causes a leak has made the annotation into a control, and controls that depend on universal developer diligence do not hold. A design in which forgetting it costs you only a *better* redaction and a line in a report is one that degrades safely.

---

## 2. The two live problems

### 2.1 BUG-18 — `@Log()` emits every argument value

`src/MethodDecorators/Log.ts` builds `context.args.map(arg => safeStringify(arg)).join(',')` and writes it to `console.log`, then does the same for the return value. `safeStringify` was hardened for *totality* by BUG-13 — it cannot throw and cannot destroy the value it renders — but nothing has ever limited *what* it renders. A method taking a password, an access token, a full user record or a payment instrument logs it in the clear. The only opt-out is not using the decorator.

This is a present exposure, not a design question.

### 2.2 BUG-19 — violation messages embed the received value

`src/Core/Descriptor.ts`:

```ts
function formatMessage(kind: ConstraintKind, expectation: string, context: ViolationContext): string {
    const subject = context.signature || context.paramName || 'value';
    return (
        `Value Error: ${subject} expected ${expectation} but received ` +
        `${formatReceived(kind, context.value)} instead`
    );
}
```

The offending argument is interpolated into the `Error` message itself. Two call sites reach it — `descriptorCheck` in `src/Core/ParameterDecoratorFactory.ts` and `assertFieldValue` in `src/Core/FieldDecoratorFactory.ts` — and both hand it the raw runtime value.

**Why this makes any `@Log`-only design incomplete.** `src/Core/Configuration.ts` exposes `setViolationPolicy('throw' | 'warn' | handler)` and `applyViolationPolicy(violation: unknown, site: ViolationSite)`. A handler receives the violation and is documented as the way to "route to telemetry." By the time anything routes it, the value is already inside an opaque string. Per-parameter redaction applied at `@Log` does nothing about it. A violation message travels wherever errors travel — an error tracker, a log aggregator, a crash report — which is normally *further* than `console.log`.

So the redaction surface has to cover the violation path, and it has to reach a module (`Descriptor.ts`) that is deliberately decorator-agnostic (DEC-012). §7 is about exactly that.

### 2.3 The tension this creates with a stated project value

`docs/vision.md` lists among its guiding principles:

> *"**Great failure is a feature.** When a contract is violated, the message should name the object, the method, the parameter, and the expectation in plain language."*

Redacting the received value cuts against this. That tension is real and this document does not pretend otherwise — §6.3 argues that for most built-in constraints the cost is much smaller than it looks, and §11 records the residue where it is not.

---

## 3. Research findings

### 3.1 The Node/TypeScript ecosystem

**`pino`'s `redact` — the mature denylist, and its failure mode.**

VERIFIED ([docs/redaction.md](https://github.com/pinojs/pino/blob/main/docs/redaction.md)). `redact` takes an array of path strings or `{paths, censor, remove}`. Default censor is `'[Redacted]'`; `remove: true` drops the key entirely. Path syntax, quoted:

> The syntax for paths supplied to the `redact` option conform to the syntax in path lookups in standard ECMAScript, with two additions:
> * paths may start with bracket notation
> * paths may contain the asterisk `*` to denote a wildcard
> * paths are **case sensitive**

VERIFIED — and worth flagging because pino's own documentation is stale about it: the docs say redaction is "built on top of `fast-redact`", but pino 10.3.1's [`package.json`](https://raw.githubusercontent.com/pinojs/pino/main/package.json) depends on **`@pinojs/redact`**, and [`lib/redaction.js`](https://raw.githubusercontent.com/pinojs/pino/main/lib/redaction.js) reads `const Redact = require('@pinojs/redact')`. Per [pinojs/redact](https://github.com/pinojs/redact) it is a re-implementation with the same API that uses "selective cloning instead of mutating the original."

VERIFIED performance figures from pino's doc: *"adds about 2% overhead to `JSON.stringify` when using paths without wildcards"*, and *"wildcard redaction does carry a non-trivial cost relative to explicitly declaring the keys (50% in a case where four keys are redacted across two objects)."*

INFERRED, and this is the important part: **a path that does not match is a silent no-op.** The only validation in `lib/redaction.js` is `if (Array.isArray(paths) === false) throw Error(...)`. [fast-redact's readme](https://raw.githubusercontent.com/davidmarkclements/fast-redact/master/readme.md) says of static paths only that it *"simply checks that the path exists and then overwrites with the censor."* No source states "unmatched paths are ignored" explicitly, but nothing validates them and nothing warns. **Rename `user.ssn` to `user.socialSecurityNumber` and the redaction stops working, with no error, no warning, and no test failure unless someone wrote a test asserting the redaction specifically.**

VERIFIED scope limits: pino never scans literal message strings — a source comment in `lib/redaction.js` explains the `redactFmtSym` key *"provides top level redaction for instances where an object is interpolated into the msg string"*, so `logger.info('token is abc123')` is emitted verbatim. And [pino#847](https://github.com/pinojs/pino/issues/847) documents that objects bound at child-logger instantiation bypass redaction entirely — *"the `req` object is never passed to log redaction, because it is not passed to the logger functions, but during child logger instantiation"* — which is why `pino-http` can leak `req.headers.authorization` despite a redact config.

**What pino gets right:** enforcement. If a path matches, the value does not escape, and it costs ~2%. **What it gets wrong for adorn's purposes:** the marking is a string path declared at logger construction, structurally decoupled from the type it describes. There is no link between `'user.ssn'` and the `User` class. It is a denylist maintained in a different file from the data.

**`winston` — abstains.** VERIFIED: [logform](https://github.com/winstonjs/logform), winston's official format package, ships Align, CLI, Colorize, Combine, Errors, JSON, Label, Logstash, Metadata, PadLevels, PrettyPrint, Printf, Simple, Splat, Timestamp, Uncolorize — **no redaction format of any kind**. [winston#1079 "redacting secrets"](https://github.com/winstonjs/winston/issues/1079) (2017) asked whether there was appetite for a PR and was closed and labelled *"use a custom format."* In practice every team hand-rolls a recursive walker, and hand-rolled walkers routinely miss getters, symbol keys, `Error` properties and cycles.

**`bunyan` serializers — the closest thing to declare-once, and an accidental allowlist.** VERIFIED ([README](https://github.com/trentm/node-bunyan)): serializers are functions "to produce a JSON-able object from a JavaScript object", registered per top-level field name. The interesting property is that a serializer *names the fields it emits*, so anything unnamed is dropped — an allowlist by construction, which is structurally safer than pino's denylist. Two things spoil it. It is keyed by **log field name, not by type**: `serializers.req` fires only when you log a field literally called `req`, so logging the same object as `request` dumps it raw. And the shipped default violates its own virtue — [`lib/bunyan.js`](https://raw.githubusercontent.com/trentm/node-bunyan/master/lib/bunyan.js) has `headers: req.headers` unfiltered, so `Authorization` and `Cookie` land in logs by default. [pino-std-serializers](https://raw.githubusercontent.com/pinojs/pino-std-serializers/master/lib/req.js) does the same. VERIFIED: the README's only data-volume note concerns request *bodies* being "prohibitively large" — a size rationale, not a privacy one. There is no statement about sensitive data anywhere in it.

**`class-transformer`'s `@Exclude()` — the right locus, no teeth. This is the most important case study in the survey.**

VERIFIED ([README](https://github.com/typestack/class-transformer)). `@Exclude()` on a property omits it from the transformed result; `@Exclude()` on the *class* inverts the default so only `@Expose()`-marked properties survive; `toPlainOnly` / `toClassOnly` scope the direction; `excludeExtraneousValues: true` drops unknown incoming properties.

VERIFIED, and it is the whole point: **the decorators are inert metadata.** They take effect only when you call `instanceToPlain()` / `plainToInstance()`. `JSON.stringify(user)`, `console.log(user)`, `logger.info({user})` and `res.json(user)` all ignore them and emit the password.

The false-confidence failure is documented in the wild, repeatedly:

- [class-transformer#146](https://github.com/typestack/class-transformer/issues/146) — *"It's working great except for when I create a new User… for some reason when I create a new user with an http `POST`, the response includes my hashed password."* Same decorator, same class, leaked on one route and not another.
- [class-transformer#246](https://github.com/typestack/class-transformer/issues/246) — `@Exclude()` not excluding password on GET or POST.
- [class-transformer#1539](https://github.com/typestack/class-transformer/issues/1539) — `@Exclude()` silently failing on TypeORM entities under NestJS; **closed as not planned**.

NestJS is how most people get enforcement, and [its own docs](https://raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/techniques/serialization.md) concede the gap: `ClassSerializerInterceptor` must be wired up explicitly, and *"we must return an instance of the class. If you return a plain JavaScript object… the object won't be properly serialized."* So returning `{user: new UserEntity()}` leaks. [nestjs/nest#10086](https://github.com/nestjs/nest/issues/10086) requested plain-object support and was closed; the reporter cited *"lack of compile-time type safety — developers can return incorrect objects without receiving errors."*

**This is the single most instructive result in the survey, and adorn should treat it as a warning rather than a template.** class-transformer gets the *locus* exactly right — the marking is on the field, travels with the type, survives renames because it is attached to the property and not to a string path. It gets *enforcement* catastrophically wrong: a visible `@Exclude()` next to `password` creates confident belief in protection that exists on no code path the developer did not explicitly route through `instanceToPlain`. The issue tracker is direct evidence that real developers hold that belief and are wrong.

**Other Node approaches, briefly.** [`redact-pii`](https://github.com/solvvy/redact-pii) works on a different axis — content regexes for credentials, cards, emails, SSNs — and is the only surveyed approach that can catch a secret embedded in free text, which is precisely pino's blind spot; its own README limits it to *"mostly… (US-)english PII"*, so false negatives are guaranteed and unquantified. [`pino-noir`](https://github.com/pinojs/pino-noir) is superseded by pino's built-in `redact` and is of historical interest only.

**OpenTelemetry JS has no in-process scrubbing hook, and I had assumed otherwise.** VERIFIED from the [trace SDK spec](https://opentelemetry.io/docs/specs/otel/trace/sdk/): a `Sampler`'s `ShouldSample` may return attributes that *"will also be added to the `Span`"* and the returned object *"must be immutable"* — samplers add, never remove. `SpanProcessor.OnEnd` is explicitly closed too: *"Even if the passed Span may be technically writable, since it's already ended at this point, modifying it is not allowed."* The officially blessed answer is out-of-process: the [redaction processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor) in the Collector, which is notably **allowlist-first** — *"Only span/log/datapoint attributes included on the list of allowed keys list are retained"* — with `blocked_values` regexes as a second layer. Good design; runs after the data has left the process, so it cannot help a local file sink or a crash dump.

### 3.2 Other ecosystems

**Lombok `@ToString.Exclude` (Java) — propagation that genuinely works, and exactly why.**

VERIFIED ([feature page](https://projectlombok.org/features/ToString), [javadoc](https://projectlombok.org/api/lombok/ToString/Exclude.html)). `@ToString` generates a `toString()` rendering all non-static fields; `@ToString.Exclude` means *"If present, do not include this field in the generated `toString`."* The inversion exists: `@ToString(onlyExplicitlyIncluded = true)` includes nothing unless marked `@ToString.Include`.

VERIFIED and load-bearing: **the annotation has `@Target(FIELD)` and `RetentionPolicy.SOURCE`.** It is discarded by the compiler and does not exist at runtime. It is a codegen directive.

That single fact settles the propagation boundary precisely:

| Call site | Protected? | Why |
|---|---|---|
| `log.info("{}", user)` | **Yes** | SLF4J substitution calls `User.toString()`, whose generated body does not mention `ssn`. Holds from any calling class, and for `"" + user`, `String.format`, and any containing object whose own generated `toString()` calls it. |
| `log.info("{}", user.getSsn())` | **No** | Nothing is involved. |
| Jackson/Gson/JPA serializing `User` | **No** | The annotation does not survive compilation, so no runtime consumer can observe it. `@JsonIgnore` is a separate marking. |

So Lombok's guarantee is: *declaration-site, propagating to every call site that goes through the generated method, because the redaction is compiled into that method's body — and worth nothing on any other path.* It is a codegen guarantee over one method, not a type-level guarantee over a value. **That is the same shape adorn can achieve, and it is worth being precise that this respected, widely-deployed mechanism is also partial.**

**Palantir `safe-logging` (Java) — the closest existing analogue to `@Sensitive`, and it is three-valued.**

I missed this on the first pass and it is the most directly relevant prior art in the survey.

VERIFIED ([palantir/safe-logging](https://github.com/palantir/safe-logging)). It is not a boolean marking but a **three-valued lattice**: `@Safe`, `@Unsafe`, and `@DoNotLog` — the last documented as *"Marks elements that should never be logged."* All are `@Retention(RUNTIME) @Inherited` with `TYPE_USE` targets, and they are enforced at compile time by an Error Prone check, `IllegalSafeLoggingArgument`, whose `@BugPattern` summary is *"safe-logging annotations must agree between args and method parameters."*

VERIFIED, and it is a remarkable endorsement — the official Log4j2 manual recommends it *over* runtime scrubbing ([delegating appender docs](https://logging.apache.org/log4j/2.x/manual/appenders/delegating.html)):

> *"Although this appender can be used to mask sensitive information contained in log events, we strongly discourage such practice… A better approach to sensitive data is not to log them at all. Third-party frameworks like Palantir `safe-logging` can ensure that objects marked as sensitive are not passed as parameters to log statements."*

**Two things adorn should take from this.** First, **the marking should probably not be boolean.** `@Safe` / `@Unsafe` / `@DoNotLog` distinguishes "known fine to emit" from "unknown, treat carefully" from "never, under any configuration" — and that third level is genuinely different from the second, because it should override even an explicit opt-in. This maps onto §6.2's veto and is a better vocabulary than a single `@Sensitive` flag; §6.1 revisits it. Second, the honest caveat from its own javadoc: it validates annotation *compatibility at AST nodes*, not full dataflow, and lists transitive field-to-container propagation as future work — **which is precisely the propagation adorn can do at runtime and Palantir cannot do at compile time.** That is a real, defensible statement of what adorn adds.

**Serilog (.NET) — automatic once registered, with a one-character bypass.**

VERIFIED ([`IDestructuringPolicy`](https://github.com/serilog/serilog/blob/dev/src/Serilog/Core/IDestructuringPolicy.cs), [config API](https://github.com/serilog/serilog/blob/dev/src/Serilog/Configuration/LoggerDestructuringConfiguration.cs), [Structured Data wiki](https://github.com/serilog/serilog/wiki/Structured-Data)). Policies are registered on the `LoggerConfiguration` via `Destructure.With<T>()`, `Destructure.ByTransforming<T>(...)`, `AsScalar`, and friends.

VERIFIED, and this is the crux: message-template operators differ. Plain `{Property}` converts unrecognised objects **via `ToString()`**; `{@Property}` destructures; `{$Property}` forces stringification *"before any other processing takes place, regardless of its type or implemented interfaces."*

INFERRED (a direct consequence of the above plus the interface's own "when destructuring" wording, though no single Serilog sentence states it): **destructuring policies apply automatically once registered, but only on the destructuring path.** Writing `{User}` instead of `{@User}` bypasses them entirely. Note this is the *inverse* of Lombok: Lombok protects `ToString()` and nothing else; Serilog policies protect everything *except* `ToString()`.

VERIFIED — my brief had the attribute name wrong. [Destructurama.Attributed](https://github.com/destructurama/attributed) has **no `[SensitiveData]`**. The set is `[NotLogged]`, `[NotLoggedIfNull]`, `[NotLoggedIfDefault]`, `[LogMasked]`, `[LogReplaced]`, `[LogWithName]`, `[LogAsScalar]`, and `[AllowDestructuringOnlyExplicitlyMarkedPropertiesAttribute]` — that last being the opt-in inversion analogous to Lombok's. Enabled with `.Destructure.UsingAttributes()`. The README states plainly: *"When the object is passed using `{@...}` syntax the attributes will be consulted."* So the annotation flavour inherits the same bypass.

[Serilog.Enrichers.Sensitive](https://github.com/serilog-contrib/Serilog.Enrichers.Sensitive) is a categorically different mechanism — an enricher matching by *value shape* (`EmailAddressMaskingOperator`, `CreditCardMaskingOperator`, `IbanMaskingOperator`) plus name lists, replacing matches with `***MASKED***` in **both the rendered message and structured properties**. It catches the `{User}` path the policies miss, but only for values whose shape it recognises. Its README states it complements rather than replaces responsible logging practices.

**Rust `secrecy` — the type-level answer, and the strongest guarantee in the survey.**

VERIFIED ([docs.rs](https://docs.rs/secrecy/latest/secrecy/), [source](https://raw.githubusercontent.com/iqlusioninc/crates/main/secrecy/src/lib.rs), [changelog](https://github.com/iqlusioninc/crates/blob/main/secrecy/CHANGELOG.md)). Correction to my own brief: **`Secret<T>` no longer exists** — 0.10.0 removed it, *"instead use `SecretBox<T>` which stores secrets on the heap instead of the stack."* `SecretString = SecretBox<str>`.

VERIFIED crate goals, quoted:

> - Make secret access explicit and easy-to-audit via the `ExposeSecret` and `ExposeSecretMut` traits.
> - Prevent accidental leakage of secrets via channels like debug logging
> - Ensure secrets are wiped from memory on drop securely (using the `zeroize` crate)

VERIFIED — the `Debug` impl and its literal placeholder:

```rust
impl<S: Zeroize + ?Sized> Debug for SecretBox<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBox<{}>([REDACTED])", any::type_name::<S>())
    }
}
```

VERIFIED, and **stronger than "Display is redacted"**: there is *no `Display` impl at all*. `println!("{}", secret)` and `.to_string()` **do not compile**. The protection is not "the formatter prints a placeholder" but "the type does not participate in the formatting trait, so the accidental call is a compile error."

VERIFIED — the same principle applied to serde: `SecretBox<T>` gets `Deserialize` so secrets can be loaded, but *"To prevent exfiltration of secret values via `serde`, by default `SecretBox<T>` does **not** receive a corresponding `Serialize` impl."* Opting in requires the `SerializableSecret` marker trait.

VERIFIED limitations, quoted:

> Presently this crate favors a simple, `no_std`-friendly, safe i.e. `forbid(unsafe_code)`-based implementation and does not provide more advanced memory protection mechanisms e.g. ones based on `mlock(2)`/`mprotect(2)`.

INFERRED but immediate: once `expose_secret()` returns `&S`, the borrow is an ordinary `&str` with no protection. The value of the design is not that leakage is impossible — it is that **every leak must pass through a single, uniquely-named, greppable call.** That is a design property adorn can copy without copying the type system, and §7.3 does.

**Python `structlog` — pipeline processors, and an honest admission.**

VERIFIED ([processors](https://www.structlog.org/en/stable/processors.html)). A processor is a callable taking `(logger, method_name, event_dict)`; chains are ordered; a processor may raise `DropEvent`. The canonical censoring example is user-written, not shipped:

```python
def censor_password(_, __, event_dict):
    pw = event_dict.get("password")
    if pw:
        event_dict["password"] = "*CENSORED*"
    return event_dict
```

No built-in redaction processor was found (flagged as a strong negative rather than a proof — see §12).

VERIFIED and directly useful, from the [recipes page](https://www.structlog.org/en/stable/recipes.html) on redacting traceback frame-locals: *"values may appear elsewhere in the dict traceback, for example in an exception string."* **That is a primary-source admission that key-name-based redaction is incomplete — a secret that reached an exception message is not caught by redacting locals.** It is the same failure as BUG-19, acknowledged upstream in another ecosystem.

Both structlog processors and stdlib `logging.Filter` are pipeline-level and *key-name-matching* over an already-assembled record. Protection is a property of the pipeline configuration, not of the value — the exact inverse of the `secrecy` model.

### 3.3 Type-level approaches in TypeScript — does branding beat annotation?

**No. Branded types provide zero runtime protection, and the reason is structural.**

VERIFIED, [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/2/basic-types.html):

> "Most TypeScript-specific code gets erased away, and likewise, here our type annotations were completely erased."

and

> "Remember: Type annotations never change the runtime behavior of your program."

So for `type Secret<T> = T & {__brand: 'secret'}`, `__brand` is a phantom that never exists at runtime and the emitted JavaScript is byte-identical to the unbranded version. `console.log(secret)`, `` `${secret}` `` and `JSON.stringify(secret)` all print the underlying string.

**The asymmetry with Rust, stated precisely:** Rust's `Debug`/`Display` are *runtime trait implementations dispatched by the formatting machinery*, so `secrecy` intervenes in the actual printing operation. TypeScript brands are erased before any printing operation exists. There is nothing for a brand to intervene in. This is not a maturity gap that better tooling closes; it is what "erased" means.

The one thing a brand does buy, in fairness: it prevents a `Secret<string>` being passed to a function typed to take a plain `string` — including your own logger, if you own the signature. Real, but narrow, and it collapses the moment the value is interpolated, spread, or handed to any API typed `unknown`.

**Runtime wrapper classes get materially closer, and my initial assumption about their limits was wrong.** Prior art exists on npm: [`@transcend-io/secret-value`](https://github.com/transcend-io/secret-value) (redacts to `[redacted]`; intercepts `toString`, `valueOf`, `toLocaleString`, `toJSON`; extraction via `.release()`) and [`@pallad/secret`](https://github.com/pallad-ts/secret) (placeholder `**SECRET**`; overrides `toString`, `toJSON` **and `util.inspect.custom`**; extraction via `getValue()`).

The correction: **the `Object.values` / spread / `structuredClone` escapes are not inherent to the wrapper approach — they are consequences of storing the payload in a public own-property.** With the payload in a `#private` field, all of those channels return empty, because private fields are not own properties and are unreachable by `Object.*`, spread, `Reflect.ownKeys` and the structured-clone algorithm. This was verified empirically on Node v22.11.0 by the research pass and is consistent with my own measurements in §4.1.

What still escapes a well-built wrapper: `util.inspect(s, {customInspect: false})`, which some log libraries set; non-Node runtimes, since `util.inspect.custom` is a Node convention browsers do not consult; the extraction call itself (`.release()`, greppable, same as Rust); and the pre-wrap value.

**The honest comparison, and why adorn should not build a wrapper type.** A `#private`-field wrapper is a genuinely strong mechanism — stronger than anything else available in JS. But two gaps remain. Rust's is a *compile-time* guarantee (`println!("{}", secret)` does not compile) while TypeScript's is a *runtime convention* every leak path can opt out of. And Rust's coverage is exhaustive by construction — formatting goes through `Debug`/`Display` and nothing else — whereas JavaScript has an open-ended and growing set of ways to render an object (`toString`, `valueOf`, `toJSON`, `Symbol.toPrimitive`, `util.inspect.custom`, devtools formatters, structured clone, and whatever ships next), so a wrapper plays whack-a-mole against an unbounded surface and can only claim "covers the known channels."

More decisively for adorn: **a wrapper type changes the developer's data.** `user.ssn` stops being a string. Every consumer must unwrap. That is a reasonable trade for a credential — which is why these packages exist and are the right answer for API keys — and an unreasonable one for a domain field that the application legitimately reads, renders and stores. adorn's `@Sensitive` is for the second case. §11 records that adorn should *point at* wrapper types for the first case rather than compete with them.

### 3.4 Static taint analysis — and the finding that matters most for adorn

**CodeQL's clear-text-logging query exists, is mature, and identifies sensitive data by guessing at names.**

VERIFIED. The query is [`js/clear-text-logging`](https://codeql.github.com/codeql-query-help/javascript/js-clear-text-logging/), "Clear-text logging of sensitive information", mapped to **CWE-312, CWE-359 and CWE-532**, with equivalents across languages ([Ruby](https://codeql.github.com/codeql-query-help/ruby/rb-clear-text-logging-sensitive-data/), Python, Java). Its stated risk: *"If sensitive data is written to a log entry it could be exposed to an attacker who gains access to the logs."*

VERIFIED, and this is the sentence to quote — the header of [`SensitiveActions.qll`](https://raw.githubusercontent.com/github/codeql/main/javascript/ql/lib/semmle/javascript/security/SensitiveActions.qll):

> *"'Sensitive' data in general is anything that should not be sent around in unencrypted form. This library tries to **guess** where sensitive data may either be stored in a variable or produced by a method."*

The mechanism is exactly that. The classifier in [`shared/concepts/codeql/concepts/internal/SensitiveDataHeuristics.qll`](https://github.com/github/codeql/blob/main/shared/concepts/codeql/concepts/internal/SensitiveDataHeuristics.qll) — the shared pack every language imports — is literally a regex match on an identifier:

```
predicate nameIndicatesSensitiveData(string name, SensitiveDataClassification classification) {
  name.regexpMatch(maybeSensitiveRegexp(classification)) and
  not name.regexpMatch(notSensitiveRegexp())
}
```

`maybePrivate()` is a hand-maintained list of PII nouns — `social.?security`, `passport.?(num|no)`, `([_-]|\b)ssn([_-]|\b)`, `(credit|debit|bank|visa).?(card|num|no|acc(ou)?nt)`, `([_-]|\b)(ccn|cvv|iban)([_-]|\b)`, `birth.?da(te|y)`, `gender`, `medical`, `blood.?(type|alcohol|glucose|pressure)`, `menstrua|pregnan|insulin|inhaler`, and more — **with email commented out and annotated `// this seems too noisy`.** VERIFIED from the [CodeQL 2.17.4 changelog](https://codeql.github.com/docs/codeql-overview/codeql-changelog/codeql-cli-2.17.4/), maintaining it means periodically extending the list: *"The regular expressions in `SensitiveDataHeuristics.qll` have been extended to find more instances of sensitive data such as secrets used in authentication, finance and health information, and device data."*

**Three details sharpen this well past "it uses regexes".**

**(a) CodeQL says so in its own source.** [`CleartextLoggingQuery.qll`](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/CleartextLoggingQuery.qll) carries a barrier that exists solely to contain the blast radius of its own guessing:

```
predicate isBarrierIn(DataFlow::Node node) {
  // We rely on heuristic sources, which tends to cause sources to overlap
  isSource(node)
}
```

**(b) Hashing is modelled as a sanitizer — matched by name — and that collides head-on with GDPR.** `notSensitiveRegexp()` matches `redact|censor|obfuscate|hash|md5|sha|random|crypt|encode`, and [`CleartextLoggingCustomizations.qll`](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/CleartextLoggingCustomizations.qll) fires an `ObfuscatorCall` barrier when `this.getCalleeName().regexpMatch(notSensitiveRegexp())`. So *a function whose name looks like hashing* ends the taint flow. Java goes further, treating `substring`/`take`/`takeLast` of **≤ 7 characters** as sanitizing — a PCI-shaped truncation rule hardcoded into the analyser. **Against §3.5's Recital 26, this is simply wrong as a privacy conclusion**: a hash is pseudonymisation, the data stays in scope, and PCI itself requires a *keyed* hash for exactly this reason. Two respected authorities disagree, and adorn's design should follow the regulation rather than the analyser.

**(c) The Java query is off by default.** VERIFIED: `java/sensitive-log` is `precision: medium`, and the default `code-scanning` suite admits only `high`/`very-high` ([`code-scanning-selectors.yml`](https://github.com/github/codeql/blob/main/misc/suite-helpers/code-scanning-selectors.yml)). It runs only under `security-extended`. For the ecosystem most likely to have an enterprise logging path, GitHub's sensitive-data-in-logs query does not run unless someone opts in.

**This is the most important research finding in the document, and it should be read as encouragement rather than as competition.** The best-resourced static analyser in the industry, working on this exact problem, falls back to guessing at variable names. It does that **not because its authors could not think of something better, but because in the languages it analyses there is no declaration to read.** Nobody wrote down that `User.ssn` is sensitive in a form a tool can consume.

**The obvious objection, pre-empted:** CodeQL *does* support declarative extension — models-as-data YAML with `sourceModel` / `sinkModel` / `summaryModel`, and now `barrierModel` ([Java guide](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-java-and-kotlin/), [changelog](https://github.blog/changelog/2026-04-21-codeql-now-supports-sanitizers-and-validators-in-models-as-data/)). But it declares sources by **API signature in an out-of-band YAML file**, keyed by namespace, type, name and signature. The declaration still is not in the code, and it still drifts from the code independently — which is DEC-006's founding complaint in a different file format.

adorn's registry is a declaration that lives on the field. That is the genuine opening, and §8.4 proposes the bridge.

**Semgrep** ([taint mode docs](https://docs.semgrep.dev/writing-rules/data-flow/taint-mode)). VERIFIED: `mode: taint` with required `pattern-sources` and `pattern-sinks`, optional `pattern-sanitizers`, and Pro-only `pattern-propagators`. Interprocedural analysis is tiered — `--pro-intrafile` for cross-function within a file, `--pro` with `interfile: true` for cross-file. VERIFIED limitation, quoted: *"Taint propagators only work intraprocedurally, that is, within a function or method. You cannot use taint propagators to propagate taint across different functions/methods."* And `pattern-sources` is **required**, i.e. the rule author must enumerate what counts as sensitive — the same missing-declaration problem, pushed onto the rule author instead of onto a regex.

**The registry evidence is more damning than the docs.** VERIFIED by enumerating the whole [semgrep-rules](https://github.com/semgrep/semgrep-rules) tree (2,151 YAML rule files, untruncated): **exactly two** rules address sensitive data reaching an application log, and **neither uses taint mode.** [`logger-credential-leak.yaml`](https://github.com/semgrep/semgrep-rules/blob/develop/python/lang/security/audit/logging/logger-credential-leak.yaml) is pure syntactic matching whose sensitivity test is a regex on the *format string* — `regex: (?i).*(api.key|secret|credential|token|password).*\%s.*` — at `confidence: MEDIUM`. [`avoid-logging-everything.yaml`](https://github.com/semgrep/semgrep-rules/blob/develop/ruby/rails/security/audit/avoid-logging-everything.yaml) matches `Rails.logger.$METHOD(params)` literally, at `confidence: LOW`. The most popular open rule registry in the industry ships a name regex on a format string.

Also worth noting because it shows how deep the pattern runs: the Rails rule exists because logging `params` bypasses `config.filter_parameters` — and [Rails' own mechanism](https://github.com/rails/rails/blob/main/railties/lib/rails/generators/rails/app/templates/config/initializers/filter_parameter_logging.rb.tt) is name-matching too, defaulting to `[:passw, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc]`. Framework-level redaction is name-based as well.

**Declaration-driven tools do exist, and they are the proof the approach works.**

- **Checker Framework's Tainting Checker** ([manual §12](https://checkerframework.org/manual/#tainting-checker)) is a real compile-time type system — `@Tainted` (the default) and `@Untainted`, with `@Tainted` a supertype. It lists adorn's exact use case as an intended purpose: *"Prevent information leakage: `@Tainted` is secret data, `@Untainted` may be displayed to a user."* And it ships nothing that implements it: *"the Tainting Checker is not useful unless you annotate the appropriate sources, sinks, and untainting/sanitization routines."* The cost is the known blocker — the ECOOP 2025 paper [*Practical Type-Based Taint Checking and Inference*](https://arxiv.org/abs/2504.18529) reports that such approaches *"have not been widely adopted in practice, due to challenges with false positives and annotating existing codebases."* **Note the polarity trap:** defaulting everything to `@Tainted` is right for injection and inverted for sensitive-data-in-logs, where you want a small marked set against a large unmarked majority.
- **Pysa removed the capability adorn is proposing.** VERIFIED, [pysa-model-dsl](https://pyre-check.org/docs/pysa-model-dsl/): *"it is not possible to match on the `typing.Annotated[]` type anymore (unlike in previous versions of Pysa), since that information is lost by the type checker."* Meta shipped annotation-carried taint kinds and backed them out. This must be addressed head-on rather than discovered later — and note it is the *same erasure argument* §3.3 makes against branded types, biting a different tool.
- **Mariana Trench does it successfully, in production.** VERIFIED ([models docs](https://mariana-tren.ch/docs/models/)): a `has_annotation` constraint, with optional regex on the annotation's value, plus `parameter_has_annotation` — used in Meta's default production config to mark every parameter of an `@JavascriptInterface`-annotated method as a taint source. **A declaration is the taint marker; no name heuristics.** This is direct evidence the §8.4 bridge is sound, and it means the idea is not novel in the absolute — see §8.4's revised claim.

**The general shape.** Every static taint tool needs three inputs: sources, sinks, and sanitizers. Sinks are easy (`console.log`, `logger.*`) and sanitizers are tractable. **Sources are the hard one, and they are hard for exactly one reason: nothing in the source language says which data is sensitive.** Where a declaration does exist — Mariana Trench's annotations — tools use it in preference to guessing. That is the gap a declaration closes.

### 3.5 What the standards actually require

**GDPR — hashing does not discharge the obligation.** VERIFIED, [Recital 26](https://gdpr-info.eu/recitals/no-26/):

> *"Personal data which have undergone pseudonymisation, which could be attributed to a natural person by the use of additional information should be considered to be information on an identifiable natural person."*

So a stable hash of an email is still personal data under GDPR, because it remains linkable given additional information. The observability plan already says this; Recital 26 is the citation. The relevant obligations that pull toward emitting less are Art. 5(1)(c) data minimisation, Art. 5(1)(f) integrity and confidentiality, Art. 25 data protection **by design and by default**, and Art. 32 security of processing. Art. 25's "by default" is the closest legal analogue to DEC-PII-1's principle: the safe configuration must be the one you get without doing anything.

**PCI-DSS v4.0.1 (June 2024) — masking is prescribed with a specific shape, and logs are explicitly in scope.**

VERIFIED against the standard's text, subject to the sourcing caveat in §12:

- **3.3.1** — *"SAD is not stored after authorization, even if encrypted. All sensitive authentication data received is rendered unrecoverable upon completion of the authorization process."*
- **3.4.1** — *"PAN is masked when displayed (the BIN and last four digits are the maximum number of digits to be displayed), such that only personnel with a legitimate business need can see more than the BIN and last four digits of the PAN."*
- **3.5.1** — PAN rendered unreadable anywhere it is stored.

**Correction to a common formulation, including my own earlier draft:** v4.x says **BIN and last four**, not "first six and last four." The BIN is six *or eight* digits under the newer eight-digit scheme; "first six" is the superseded v3.2.1 phrasing. A built-in strategy that hardcodes six would be wrong for eight-digit BINs.

**Logs are named explicitly — this is the quote that makes PCI directly relevant here.** The Applicability Note to 3.5.1:

> *"This requirement applies to PANs stored in primary storage (databases, or flat files such as text files spreadsheets) as well as **non-primary storage (backup, audit logs, exception, or troubleshooting logs)**."*

Testing procedure 3.5.1.b directs assessors to examine *"audit logs, including payment application logs, to verify the PAN is rendered unreadable."* A log is not a lesser storage class under PCI; it is storage.

**And PCI independently reaches this document's conclusion about hashing.** Requirement **3.5.1.1**:

> *"Hashes used to render PAN unreadable (per the first bullet of Requirement 3.5.1) are **keyed cryptographic hashes of the entire PAN**, with associated key-management processes and procedures in accordance with Requirements 3.6 and 3.7."*

An *unkeyed* hash is explicitly insufficient, because a PAN's search space is small enough to brute-force. 3.5.1.c further requires verifying that hashed and truncated versions of the same PAN *"cannot be correlated to reconstruct the original PAN"* — a direct warning about the correlation property that makes `redact('hash')` useful in the first place. **Two independent regimes therefore agree that a plain hash does not discharge the obligation**, which is a much stronger footing for §6.3 than GDPR alone.

**Design consequences, concrete:** `redact('first(n)')` / `redact('last(n)')` belong in the built-in strategy set, a `pan` strategy should encode BIN-plus-last-four rather than a fixed six, and `redact('hash')` must be **salted or keyed** and documented as neither anonymising nor PCI-sufficient on its own.

**OWASP — an explicit exclusion list.** VERIFIED, [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), data that should usually not be recorded directly: application source code; session identification values; access tokens; *"Sensitive personal data and some forms of personally identifiable information (PII) e.g. health, government identifiers, vulnerable people"*; authentication passwords; database connection strings; encryption keys and other primary secrets; bank account or payment card holder data; data of a higher security classification than the logging system may store; commercially-sensitive information; information illegal to collect in the relevant jurisdiction; and information a user has opted out of or not consented to.

A second list needs *special handling* rather than exclusion: file paths, database connection strings, internal network names and addresses, and non-sensitive personal data such as names, phone numbers and email addresses. Recommended techniques: deletion, scrambling, pseudonymisation, masking, sanitisation, hashing, encryption.

Note the same tension as CodeQL's: OWASP offers hashing as an acceptable treatment, which Recital 26 does not accept as removing data from scope.

**OWASP ASVS 4.0.3 §V7 is the crispest *testable* form of the requirement**, and is the better thing to cite when a design needs a checkable assertion ([source](https://github.com/OWASP/ASVS/blob/v4.0.3/4.0/en/0x15-V7-Error-Logging.md)):

- **7.1.1** (L1/L2/L3, CWE-532) — *"Verify that the application does not log credentials or payment details. Session tokens should only be stored in logs in an irreversible, hashed form."*
- **7.1.2** (L1/L2/L3, CWE-532) — *"Verify that the application does not log other sensitive data as defined under local privacy laws or relevant security policy."*

And its control objective, which is the argument for deny-by-default stated by a standards body:

> *"Logging sensitive information is dangerous - the logs become classified themselves, which means they need to be encrypted, become subject to retention policies, and must be disclosed in security audits."*

**7.1.2 is worth dwelling on**: the standard defines the sensitive set as *"data as defined under local privacy laws or relevant security policy"* — that is, by reference to facts outside the code that only the developer knows. It is a standards-body admission that no tool can determine this on its own, which is the same conclusion §3.4 reaches from the analyser side.

The CWE anchors, for completeness: [CWE-532](https://cwe.mitre.org/data/definitions/532.html) *Insertion of Sensitive Information into Log File* (*"Do not write secrets into the log files"*), [CWE-312](https://cwe.mitre.org/data/definitions/312.html) *Cleartext Storage of Sensitive Information*, [CWE-359](https://cwe.mitre.org/data/definitions/359.html) *Exposure of Private Personal Information to an Unauthorized Actor*.

**NIST SP 800-92 is deliberately not cited.** It is about log-management *infrastructure* — generation, transmission, storage, disposal — not about restricting what may be written into a log, and its abstract does not mention sensitive data or PII. Rev. 1 remains an Initial Public Draft. Anyone tempted to cite it here for authority should use ASVS 7.1.1/7.1.2 and PCI 3.5.1 instead.

**Read against a name heuristic, this list is damning.** "Vulnerable people", "commercially-sensitive information", "information a user has opted out of" and "data of a higher security classification than the logging system is allowed to store" are not properties any regex over an identifier name can detect. They are **facts about the domain that only the developer knows** — which is the argument for a declaration, made by the standard rather than by this document.

---

## 4. What I measured

Three experiments, run in this repo's environment on **Node v22.11.0**. These are measurements, not citations.

### 4.1 Which egress paths can a class-level hook actually intercept?

A class with a real, readable `ssn` field plus both `toJSON()` and `[util.inspect.custom]()` overrides:

| Path | Result |
|---|---|
| `JSON.stringify(u)` | **covered** |
| `JSON.stringify({u})` (nested) | **covered** |
| `util.inspect(u)` | **covered** |
| `util.inspect({u})` (nested) | **covered** |
| `String(u)` / template literal | **covered** (`[object Object]`) |
| `{...u}` (spread) | **LEAK** |
| `Object.values(u)` | **LEAK** |
| `Object.entries(u)` | **LEAK** |
| `Object.assign({}, u)` | **LEAK** |
| `structuredClone(u)` | **LEAK** |
| `u.ssn` (direct read) | **LEAK** |

**Reading this correctly matters.** The two most common accidental-exposure paths — a JSON serializer (pino, winston, bunyan, any structured logger) and `console.log` via `util.inspect` — are *both* covered by hooks adorn could install. Every remaining leak is a case where the developer deliberately copied the data out of the object. That is a much more visible act than `logger.info({user})`, and it is not nothing, but it is a different category.

**Why the `#private`-field trick from §3.3 does not rescue this.** A wrapper can hide its payload because nothing else needs to read it. adorn is marking a field on a *domain class* whose whole purpose is that `user.ssn` works normally. `src/Core/FieldDecoratorFactory.ts` makes this explicit — the installed accessor is deliberately `enumerable: true`, with the comment *"this is what keeps JSON.stringify, Object.keys, spread and Object.assign behaving exactly as they do for an undecorated field."* That was the resolution of BUG-1 and reversing it would be a worse bug than the one it fixed. **Airtightness and transparency are in direct tension, and `@Sensitive`-on-a-field deliberately chooses transparency. That choice caps the guarantee, permanently.**

### 4.2 Error serialization — the BUG-19 blast radius, and how far it can be narrowed

Two `ContractViolation` shapes compared:

- **A (naive):** raw value interpolated into `message`, and also attached as an ordinary own property `err.value`.
- **B (proposed):** message renders a projection (`"received a string of length 11"`), raw value attached via `Object.defineProperty(..., {enumerable: false})`.

| Path | A | B |
|---|---|---|
| `err.message` | **LEAK** | covered |
| `String(err)` | **LEAK** | covered |
| `JSON.stringify(err)` | **LEAK** | covered |
| `util.inspect(err)` | **LEAK** | covered |
| `{...err}` (spread) | **LEAK** | covered |
| `Object.keys(err)` | covered | covered |
| explicit `err.value` | — | **LEAK (by design)** |

**Shape B reduces five accidental leak paths to one deliberate one.** That deliberate one is precisely `secrecy`'s `expose_secret()` property achieved in JavaScript: the value remains available for local debugging, is unreachable by accident, and every access is a greppable call site. This is the strongest single result in this document and §7 is built on it.

Incidental but useful: `JSON.stringify` on an `Error` does not include `message` or `stack`, because they are non-enumerable own properties. Enumerability is the whole game.

### 4.3 Cost of a deep redaction walk

An `Order` → `Customer` → `Address` graph plus 10 line items (~50 nodes, depth 4), walked with per-constructor sensitive-key lookup, cycle detection and a depth bound:

| Operation | ns/op |
|---|---|
| No-sink fast path (one reference comparison) | **11** |
| Redaction walk | **900** |
| `JSON.stringify` of the same object (baseline) | **1,870** |
| Redact, then `JSON.stringify` | **2,993** |

**The framing this supports:** deep redaction costs roughly half what serialising the same object already costs. If you were going to log the object at all, redaction adds ~48% to an operation you were already paying for. It is *not* expensive relative to logging; it is expensive relative to *not* logging — which is an argument for off-by-default, not an argument against redaction.

Two honest caveats. **900 ns is a floor, not adorn's number.** My probe used a flat `Map` lookup per object; adorn's real lookup is `getEffectiveFieldContract`, which walks the prototype chain per key and is deliberately not memoised (SMELL-18, DEC-021). And this is a single-shape microbenchmark on one machine. §11 develops the caching hazard, which is sharper here than elsewhere: on the enforcement path a stale plan enforces the wrong contract; on the emit path a stale plan **under-redacts**, which is a security failure rather than a correctness one.

### 4.4 Minification — verified, and it cuts one way decisively

`esbuild --minify` (0.28.1) on a class with a `socialSecurityNumber` field and a `transfer(sourceAccount, socialSecurityNumber, transferAmount)` method:

```js
class n{constructor(){this.accountId="A1",this.socialSecurityNumber="123-45-6789"}transfer(t,c,e){return[t,c,e]}}
```

| Thing | Survives minification? |
|---|---|
| **Property names** (`socialSecurityNumber`) | **Yes** — unchanged |
| **Parameter names** (`socialSecurityNumber` → `c`) | **No** — destroyed, exactly as SMELL-1 records |
| **Class binding name** (`Account` → `n`) | **No** (the export alias preserves the export, not `Ctor.name`) |

§9 works through what this means. The headline: **a name-based sensitivity heuristic is not merely imprecise, it is inoperative in the production build**, because the names it would match on no longer exist.

---

## 5. Verdict on declare-once propagation

### 5.1 The mechanism, and why it is sound

`@Sensitive` on a field records a marking against `(prototype, key)` in the field band of `ContractRegistry` — the same band `@Enforce.*` already writes to, read back through `getEffectiveFieldContract` / `getFieldContractsForClass`. Nothing new is needed structurally; GAP-9 built the band and DEC-021 defined its inheritance semantics.

When a value is about to be emitted, adorn walks it and consults that registry per property. For `transfer(user: User)` with `@Sensitive User.ssn`, `user.ssn` is redacted without the call site saying anything. **That is the user's proposal, and it works.**

### 5.2 It inherits two properties for free, and both are load-bearing

**Inheritance comes from DEC-021 unchanged.** Field constraints resolve as the *union* of every declaration on the prototype chain, own-scoped storage, no write API reaching an ancestor. A `@Sensitive` marking on `Person.email` therefore applies to `Employee` and `Contractor` automatically, and a subclass cannot un-mark it — weakening is *unexpressible*, exactly as DEC-021 arranged for constraints. **A privacy marking that a subclass could silently remove would be worthless; adorn's field band already forbids that, for reasons that had nothing to do with privacy.** This is an unforced synergy and it is the strongest structural argument for putting `@Sensitive` in the field band rather than inventing a parallel store.

**It survives minification**, per §4.4. Property names are not mangled; the registry is keyed by property key. So field-marked propagation works in the production build — which is more than can be said for anything keyed on parameter names.

### 5.3 It is *more* reliable than the user's framing assumes — use the runtime constructor, not `design:paramtypes`

The brief frames the tractable case as "walk the value against the registry entry for its constructor" via `design:paramtypes`. That works, but it is the weaker of two available routes, and it inherits every `design:paramtypes` limitation the observability plan already records (risk 4): erases to `Object` for interfaces, unions and generics; absent entirely under esbuild/Babel (DEC-004).

**The stronger route ignores the declared type entirely and reads the runtime value's own constructor.** At emit time adorn holds the actual object. `Object.getPrototypeOf(value)` is the exact prototype, so:

- No erasure. An interface-typed parameter whose runtime value is a `User` resolves to `User`'s markings; `design:paramtypes` would have said `Object`.
- Unions resolve to whichever member actually arrived.
- Subclasses resolve correctly *and* pick up DEC-021's inherited union.
- **It works with no `emitDecoratorMetadata` at all**, so the propagation feature does not inherit DEC-004's toolchain constraint.

`design:paramtypes` remains useful for the *static* artifact — a build-time report (§8) has no runtime value to inspect and must use the declared type, with the usual honest-absence rule. But runtime redaction should not depend on it. **This is a genuine improvement on the proposal as stated and it removes the design's largest apparent fragility.**

### 5.4 Where it cannot work, stated flatly

```ts
transfer(@Sensitive() ssn: string) {}   // the annotation is mandatory here
```

For `transfer(ssn: string)`, `design:paramtypes` yields `String`. There is no marking, because there is nothing for a marking to attach to: **the value is a primitive, and the connection to `User.ssn` was destroyed at the call site by JavaScript's value semantics.** `transfer(user.ssn)` copies a string. The copy carries no history. No amount of registry cleverness recovers it, because the information is not merely hidden — it does not exist in the callee's frame.

This is the hard part of the brief and the answer is that adorn cannot do it. **The developer must annotate the parameter.** There is no fallback that does not manufacture false confidence, and §5.5 explains why the two tempting fallbacks are worse than the gap.

### 5.5 Value-level tainting — evaluated, and it is a trap

adorn owns the field accessors (`FieldDecoratorFactory` installs per-instance `adornFieldGet`/`adornFieldSet` over a closure slot, branded with a symbol). It is reasonable to ask whether that enables tainting the value on read. It does not. Two mechanisms, both rejected on measured grounds.

**Mechanism 1 — attach a taint marking to the value.** Measured (§4, `redaction-probe.js`):

- Assigning a property to a primitive string silently no-ops. Reading it back yields `undefined`. In strict mode it throws. Primitives cannot carry markings — this is not an implementation limit, it is the language.
- Boxing with `new String(...)` makes `typeof` return `'object'` and makes `boxed === original` **false**. Any user code doing `typeof x === 'string'` or `x === y` breaks. adorn would be corrupting the program to observe it.
- `JSON.stringify({v: boxed})` unwraps back to the raw string, so the taint does not even survive the serialization it was meant to guard.

**Mechanism 2 — record reads into an ambient (ALS-scoped) taint set, then match emitted values against it.** Rejected for three independent reasons, any one of which is sufficient:

1. Matching requires **retaining the sensitive values** to compare against. The taint set is itself a PII store, in memory, with a lifetime nobody reasoned about. The mechanism creates the exposure it exists to prevent.
2. Value equality over-taints catastrophically. If `user.ssn` is `"0"`, every `"0"` in the process becomes sensitive.
3. It is unsound in the other direction the moment the value is transformed. `ssn.slice(-4)` is not in the set, and the last four digits of an SSN are exactly the thing PCI-style rules care about.

**The accessor ownership does enable something real, and it is not tainting — it is observation.** The getter runs on every read, including reads performed by `JSON.stringify` and `util.inspect`. adorn can therefore *count* reads of a `@Sensitive` field, and — sampled, because stack capture is expensive — attribute them to a call site via `Error.captureStackTrace`. That is a genuine capability a normal library lacks, and it is the achievable form of the user's "alert on exposure" (§8.2). It observes; it does not follow the value.

### 5.6 Verdict

| Claim | Verdict |
|---|---|
| Mark a PII field once, have object-typed parameters redact automatically | **Achievable.** Stronger than proposed, via the runtime constructor (§5.3). |
| Inheritance and subclass-safety of the marking | **Free**, from DEC-021. |
| Survives production minification | **Yes** for field markings (§4.4). |
| Same for primitive-typed parameters | **Not achievable.** Manual annotation required, permanently. |
| Value-level tainting to close that gap | **Rejected**, on measured grounds (§5.5). |
| "Alert on exposure" | **Partly a projection, partly not.** §8. |

---

## 6. Design: where `@Sensitive` attaches, and what defaults it does *not* carry

### 6.1 Four attachment points, three of them necessary

| Attaches to | Necessary? | Why |
|---|---|---|
| **Field** | **Yes — this is the whole idea** | The propagating one. Registry field band, DEC-021 inheritance, minification-safe. `@Sensitive() ssn: string` on `User`. |
| **Parameter** | **Yes — mandatory, not a convenience** | The only available answer for primitives (§5.4). Index-keyed, so minification-safe. `transfer(@Sensitive() ssn: string)`. |
| **Class** | **Yes** | `@Sensitive() class PaymentInstrument {}` marks every field. Whole types are sometimes uniformly sensitive, and enumerating their fields individually is the kind of per-field diligence that rots. Also the natural place for "this type must never be emitted at all." |
| **Method return** | **Yes, but as `@Telemetry.result()`'s inverse** | `getUser()` returns more PII than most parameters. The observability plan already reserves this; `@Sensitive` on a method marks its *return*. |
| **Type** | **No — not expressible** | TypeScript types are erased (§3.3). There is nothing to attach to. A branded type buys compile-time assignment checking and no runtime behaviour. |

**The marking should probably not be boolean, and Palantir's lattice is the reason (§3.2).** `safe-logging` distinguishes `@Safe`, `@Unsafe` and `@DoNotLog`, and the third level does real work that the second cannot: it says *never, under any configuration, including an explicit opt-in*. Mapped onto adorn:

| Level | Meaning | Effect |
|---|---|---|
| *(unmarked)* | Unknown. The default for everything. | Not emitted (no allowlist entry). Message shows a projection. |
| `@Sensitive()` | Known sensitive. | Redacted in messages and object walks; **vetoes** an `@Telemetry.value()` opt-in on the same site; appears in the exposure report. |
| `@Sensitive({never: true})` | Must never leave the process in any form. | As above, and **an explicit opt-in on this site is a decoration-time error rather than a silent override.** |

The third level is worth the extra concept precisely because §6.2 makes `@Sensitive` a veto: a veto that silently wins is confusing, whereas a declaration that makes the conflicting opt-in *unwriteable* is the DEC-021 move — make the wrong thing unexpressible rather than detected. It also gives a security reviewer a grep target with no false positives.

### 6.2 Fail-open or fail-closed? — the question is malformed, and answering it properly is the design

The brief asks whether `@Sensitive` is defence-in-depth or a load-bearing control, noting that this changes how bad a false negative is. **It should be defence-in-depth on every path, and achieving that is a design constraint rather than an observation.**

The argument:

- If `@Sensitive` is load-bearing anywhere, then *forgetting it leaks* on that path. Forgetting is the normal case. Every piece of evidence in §3 points the same way — pino's paths silently rot on rename; class-transformer's `@Exclude` is believed-in and ineffective; bunyan's own default serializer dumps `Authorization`. **The failure mode of annotation-based privacy is not that the annotation is wrong; it is that it is absent.**
- Therefore every path must be safe *without consulting any annotation*, and `@Sensitive` must only ever make things safer, never be the thing that makes them safe.

Applied to adorn's three emitting paths:

| Path | Default without any annotation | What `@Sensitive` adds |
|---|---|---|
| **Telemetry attributes / structured log records** | **Nothing emitted.** Deny-by-default, per DEC-OBS-2. | A **veto** over an explicit `@Telemetry.value()` opt-in, plus propagation into opted-in object graphs. |
| **Inside an opted-in object value** | **Allowlist, not denylist** — see below. | Marks a field as never-emittable even if the class is otherwise opted in. |
| **Violation messages** (BUG-19) | **A projection of the value, not the value** — see §6.3. | Escalates the projection to its least-informative form; marks the site for the report. |

**The one place this needs a ruling rather than a restatement: what happens inside an opted-in object.** `@Telemetry.value() user: User` opts the whole object in. Do unmarked fields of `User` get emitted?

**No. Object values are opt-in per field, not opt-out per field.** Otherwise adding a field to `User` silently starts emitting it — the denylist-rot failure that pino has and class-transformer's non-inverted mode has. This is exactly the inversion the observability plan already argues for parameters, applied one level down, and it means:

> **There is no denylist anywhere in the value-emission path.** `@Sensitive` is not what stops data escaping; the absence of an allowlist entry is. `@Sensitive` is a second, independent layer that also stops it, and — more importantly — is the *enumerable declaration* that the report in §8.1 and the alert in §8.2 read.

This resolves an ambiguity the brief did not flag but which would have bitten: the user's proposal is denylist-shaped ("declare what is sensitive"), the observability plan is allowlist-shaped ("declare what may be emitted"), and shipping both without saying which governs would leave developers unable to reason about their coverage. The answer is that the allowlist governs emission and `@Sensitive` governs *everything else* — messages, propagation, reporting, alerting — plus a veto.

### 6.3 Redaction form — and why the violation message costs less than it looks

Five candidate forms, with what each trades:

| Form | Debuggability | Privacy | Verdict |
|---|---|---|---|
| **Drop the field entirely** | Poor — absence is ambiguous. Was there no value, or was it redacted? | Best | **Rejected as a default.** DEC-016's honest-absence principle: an artifact that silently omits is worse than one that says it omitted. |
| **Fixed placeholder** (`[redacted]`) | Low but honest | Very good | **The floor.** What `@Sensitive` escalates to. |
| **Type-preserving stub** (`a string of length 11`) | **Good for most constraints** | Good — leaks length only | **Recommended default for violation messages.** See below. |
| **Length-preserving mask** (`***********`) | Same as stating the length | Same as stating the length, but *looks* like a password field | **Rejected.** Strictly worse than saying "length 11" — identical information, dressed up to imply more protection than it provides. |
| **Stable hash** | Enables correlation across records | Pseudonymisation, not anonymisation | **Opt-in only**, per the observability plan. Must be salted per-deployment. Still personal data. |

**The observation that makes the violation-message default affordable.** For most built-in constraints, the received value is largely *redundant with the constraint's own dimension*. A `minLength(10)` violation is diagnosed by the length; `"received a string of length 3"` is at least as useful as `"received 'abc'"` and carries no payload. A range violation is diagnosed by the number.

This is not universal, and pretending otherwise would be the overclaim this project keeps warning itself about. A `pattern` violation genuinely wants the string; a `oneOf` violation genuinely wants the value. So the mechanism is a per-`ConstraintDefinition` hook, `describeReceived(value)`, **derived** like everything else per DEC-010 — a definition may return a bounded description (`"a string that is not one of the 3 permitted values"`) but **never the raw value**, because a definition able to return the raw value is precisely the escape hatch Q-4 warns reopens drift, with a security blast radius instead of a documentation one.

The raw value stays reachable for local debugging through two doors, both deliberate:

- `setViolationValueDisclosure('projected' | 'full' | 'none')`, defaulting to `'projected'`. `'full'` restores today's behaviour for a developer's own machine.
- The non-enumerable `value` property on the violation (§4.2, shape B) — greppable, auditable, never accidental.

### 6.4 The coverage table — the antidote to false confidence

Every mechanism surveyed in §3 is partial. adorn's will be too. The design's answer to that is not to claim more, but to **make the gaps enumerable and printed**, in the generated report of §8.1 and in the public documentation:

| Egress path | Covered by adorn's redaction? |
|---|---|
| `@Log` / observation sink records | **Yes** (allowlist, §6.2) |
| Contract violation `Error.message` | **Yes** (§7) |
| Violation routed via `setViolationPolicy` handler | **Yes** — structured, no message, no raw value |
| `JSON.stringify(user)` by the app's own logger | **Only if** the optional class-level `toJSON` hook is enabled (§7.3) |
| `console.log(user)` | **Only if** the optional `util.inspect.custom` hook is enabled (§7.3) |
| `{...user}`, `Object.values(user)`, `structuredClone(user)` | **No** (§4.1) |
| `logger.info(user.ssn)` — direct read | **No.** Nothing can cover this. |
| A third-party library logging its own copy | **No** |
| `user.ssn` in an exception message thrown by user code | **No** — the same gap structlog documents (§3.2) |

**A developer who believes the first two rows imply the last four is worse off than one who never annotated anything, because they have stopped looking.** That sentence belongs in the README, not in a footnote.

---

## 7. BUG-19: getting the marking to `formatMessage` without breaking DEC-012

### 7.1 The constraint

`src/Core/Descriptor.ts` is decorator-agnostic and must stay so. Its own docstring on `ViolationContext` already states the pattern to follow:

> *"Deliberately plain strings: an adapter composes `signature` from its own target/propertyKey knowledge, and this layer never sees those."*

So the module already receives *pre-resolved, plain* facts from the enforcement layer rather than reaching for adapter knowledge. Redaction should arrive the same way. There is an exact in-repo precedent: GAP-9 records that when the registry gained a field band, *"the registry learned about **fields**, not decorators."* `Descriptor.ts` should likewise learn about **redaction**, which is core data, not about `@Sensitive`, which is an adapter's spelling of it.

### 7.2 The mechanism

Three changes, none of which teach `Descriptor.ts` anything about decorators:

**1. Split the structured violation from its rendered string** — which BUG-19's own entry says is the fix, and which P3.1's `ContractViolation` is already scheduled to do. The structured form carries `constraint`, `params`, `describe()`, the site, and the trust level. **It does not carry the value**, except as a non-enumerable property (§4.2, shape B). Rendering is a separate function taking a disclosure policy.

**2. Extend `ViolationContext` with a resolved redaction, not a marking.**

```ts
export interface ViolationContext {
    readonly value: unknown;
    readonly signature?: string;
    readonly paramName?: string;
    /** Pre-resolved by the enforcement layer. Plain data — this layer never sees a decorator. */
    readonly disclosure?: 'projected' | 'none' | 'full';
}
```

The two enforcement call sites resolve it **at install time**, where they already resolve everything else:

- `descriptorCheck` in `ParameterDecoratorFactory.ts` — already closes over `index`, `signatureFor` and `paramNames` per parameter. It gains the parameter's sensitivity, read from `ParameterContract`. Nothing per-call.
- `assertFieldValue` in `FieldDecoratorFactory.ts` — already resolves the effective constraint list per assignment. It reads the field's sensitivity from the same `FieldContract` it is already holding.

**3. `formatMessage` consults `disclosure` and otherwise defaults to `'projected'`.** Note the default lives in `Descriptor.ts` and applies when the field is absent — so a *new* enforcement path that forgets to pass it gets the safe rendering, not the unsafe one. That is the §6.2 principle applied to adorn's own internals: the annotation is not load-bearing, and neither is remembering to forward it.

### 7.3 The optional class-level hooks — real value, and the exact reason to keep them opt-in

§4.1 measured that `toJSON` and `[util.inspect.custom]` on the class cover the JSON-serializer and `console.log` paths — the two biggest accidental-exposure routes, and both entirely outside adorn's decorators. adorn *can* install these, because it already owns installation on the class.

`util.inspect.custom` should be offered and is comparatively safe: it changes only how Node renders the object for humans, and the failure mode of getting it wrong is a less useful debug print.

**`toJSON` is a different matter and must be opt-in.** Installing it changes the application's serialization semantics — including its HTTP responses, its database writes, and its message payloads. A developer who marks `User.ssn` as `@Sensitive` and discovers their API has stopped returning it has been handed a production incident by a privacy feature. So: `@Sensitive({redactInJSON: true})`, off by default, documented as a hardening option and never as coverage.

Both hooks belong in the §6.4 coverage table with their gaps stated, because both are partial (§4.1: spread, `Object.values` and `structuredClone` escape either way).

---

## 8. "Alert on exposure" — one genuine projection, two things that only resemble one

The brief asks whether this is a projection in the sense `docs.ts` is. **Partly. It decomposes into four things and only the first is a projection; conflating them would overclaim in exactly the way `vision.md`'s fuzzing retraction (Q-3) already cost this project once.**

### 8.1 The intersection report — a genuine projection

Enumerate every `@Sensitive` field and every `@Telemetry.value()` parameter, and report where they meet. **Both sides are registry data. The computation is a pure read. It is build-time. It has the same two-step extract/render shape `docs.ts` established** — a `sensitivityReport()` returning plain data, and a renderer — and it satisfies DEC-012 identically, since it touches `Core/` and `Contracts/` only.

It is a genuine sixth projection, and it produces a privacy-review artifact no logging library can produce, for the reason the observability plan already gives: no logging library knows what the parameters are.

Two caveats it inherits and must print rather than bury:

- **DEC-007's limitation.** The registry only sees what has been imported. A privacy-review artifact that silently omits an unimported module is the "looks complete, is not" failure DEC-016 rejects — and it is worse here than for documentation, because the reader's question is "am I leaking anywhere?" and a short answer reads as a clean bill of health. The report must state its own enumeration basis.
- **Class names degrade under minification** (§4.4), so a report generated from a minified build has correct structure and degraded labels.

### 8.2 The runtime alert — not a projection, and the most useful of the four

Because adorn owns the field accessors, it can observe a `@Sensitive` field being *read on an emit path* — the redaction walk encountering and redacting it — and route that to a sink: `Accounts.transfer redacted User.ssn 4,201 times today`.

This is not a projection. It reports **actual traffic, not declarations**, and it answers a question the report cannot: *is this field actually reaching a log boundary?* A field marked sensitive and never redacted at runtime is either well-contained or never exercised; a field being redacted 4,000 times a day is one annotation away from a breach and is worth a human looking at the call path.

Cost discipline, treated as a requirement: the counter increments only when a sink is installed and a redaction actually occurs; call-site attribution via `Error.captureStackTrace` is expensive and must be sampled and off by default.

### 8.3 The test-time assertion — not a projection, and the one that catches regressions

A test helper that captures sink output and asserts no `@Sensitive` field's value appears in it. This is what actually prevents the class-transformer failure mode (§3.1), because it fails a build rather than producing a document nobody reads. It is cheap and it should ship with the redaction surface, not after it.

### 8.4 Static taint analysis over non-adorn code — out of reach, with one genuinely novel bridge

The broadest reading of "alert on exposure" — catching `logger.info(user.ssn)` in code adorn does not own — is taint analysis, and adorn cannot do it at runtime. That is the primitive-parameter gap (§5.4) restated at codebase scale: once the value has been read out of the field, adorn has no further visibility.

**But §3.4 identified a genuine and, as far as I can tell, unexploited bridge.** Every taint tool needs sources, sinks and sanitizers. Sinks and sanitizers are tractable. **Sources are hard, and CodeQL's own answer is to guess** — *"This library tries to guess where sensitive data may either be stored in a variable or produced by a method"* — because in the languages it analyses, nobody wrote down what is sensitive in a machine-readable form.

adorn's registry *is* that form. So adorn can **export its `@Sensitive` declarations as taint sources** — emitting a generated CodeQL model pack or a Semgrep rule whose `pattern-sources` are the actual declared sensitive fields, `User.ssn` and not `/ssn|password/i`.

The claimed benefit is precise and should not be inflated: it does not make taint analysis work where it did not, and it does not remove the need for CodeQL or Semgrep. **It replaces a heuristic input with a declared one**, which converts a class of false negatives (a sensitive field whose name no regex matches — `dob`, `motherMaidenName`, `answer`, `notes`) into true positives, and a class of false positives (a variable called `userToken` that holds a request ID) into non-findings.

**It is not novel in the absolute, and that is reassuring rather than disappointing.** Meta's [Mariana Trench](https://mariana-tren.ch/docs/models/) already does exactly this for Android: a `has_annotation` model constraint makes a Java annotation the taint marker, and Meta's default production configuration uses it to treat every parameter of an `@JavascriptInterface` method as a source. So the mechanism is proven in production at scale — **what appears to be absent is anyone doing it for JavaScript/TypeScript, and anyone driving it from a runtime decorator registry rather than a compile-time annotation.**

Two caveats that must travel with the proposal:

- **Pysa removed the closest analogue.** Inline `typing.Annotated[str, TaintSource[...]]` was supported and was withdrawn because *"that information is lost by the type checker"* (§3.4). adorn does not have that problem — its registry is a runtime structure, not type metadata — but the failure is close enough that it should be cited when the idea is pitched, not discovered by a reviewer.
- **CodeQL's models-as-data already offers a declarative path** (§3.4), so the pitch is not "declarations are impossible today." It is that adorn's declaration lives *on the field, in the code, next to what it describes*, rather than in a YAML file keyed by API signature that drifts independently — which is DEC-006's argument, not a new one.

Scheduled last (§10, Phase R3) and gated on the declaration surface having real use, because generating rules from a vocabulary nobody has adopted is effort spent on a hypothesis.

---

## 9. SMELL-1: what keys on names, and what breaks in production

Measured in §4.4. Working through every mechanism this document proposes:

| Mechanism | Keys on | Survives minification? |
|---|---|---|
| `@Sensitive` on a **field** | Property key (a real runtime string) | **Yes.** Property names are not mangled by default. |
| `@Sensitive` on a **parameter** | Parameter **index** in `ParameterContract` | **Yes** for the redaction itself. Only the *label* degrades (`ssn` → `c`), exactly as DEC-OBS-4 anticipates. |
| The object-graph walk | Runtime prototype identity + property keys | **Yes.** §5.3's constructor route needs no names at all. |
| The intersection report (§8.1) | Registry identity | **Structure yes, labels no** — class binding names degrade (§4.4). |
| A **name-based heuristic** (`/password\|ssn\|secret/i` over parameter names) | Recovered parameter names | **No. Completely inoperative.** |

**That last row is worth stating as a finding rather than a footnote.** The observability plan already rejects name heuristics as a primary mechanism on the grounds that they manufacture confidence — catching `password` while missing `dob`, `ssnLast4`, `motherMaidenName`, `answer`, `note`, `body`, `payload`. §4.4 adds a second, independent, and arguably more damning argument: under adorn's own SMELL-1, a heuristic over parameter names sees `t`, `c`, `e` in the production build. **It would work perfectly in development and silently stop working in production** — failing in exactly the build where the data is real. Any residual temptation to ship a heuristic as a safety net should die here.

By contrast, pino's string paths (`'user.ssn'`) *do* survive minification, because they key on property names. Fair to note: pino's approach is not broken by minification, only by renames.

---

## 10. Phased plan

**The sequencing constraint from `docs/observability-plan.md` §6 governs and is sharpened here.** The redaction surface must land **before** any logging feature emits values, because otherwise the fix is simultaneously a breaking change and a security advisory for every version in between. adorn is `1.0.0` but is an unreleased prototype with no consumers, which is the cheapest this will ever be — the identical argument DEC-020 used to justify removing the named-boundary constraints outright rather than deprecating them.

### Phase R0 — close the two live bugs *(first; blocked on nothing)*

The ordering *within* this phase matters, and it is the reverse of what the bug numbers suggest.

1. **BUG-19 first.** `ContractViolation` (P3.1): structured violation split from rendered string; raw value non-enumerable; `formatMessage` defaults to `'projected'`; `setViolationValueDisclosure`. **Before BUG-18**, because a `@Log` that routes violations would otherwise be built on top of a leak, and because the `ViolationContext.disclosure` seam is what the rest of the design hangs from.
2. **BUG-18 second.** `@Log` stops emitting argument and return values. This is DEC-OBS-3's break, taken now.

Both are breaking changes to observable behaviour. Both should be announced as such rather than slipped in, and both change test expectations across the suite.

**Deliverable: adorn no longer emits argument values anywhere, by default, on any path.** Note this phase ships **no `@Sensitive` at all** — which is the point. The safe default does not depend on the annotation.

### Phase R1 — the declaration surface

- `@Sensitive` on field, parameter, class, and method-return, recorded into the existing registry bands.
- Redaction strategies as `defineConstraint`-style descriptors (identity + params, transform **derived**), per DEC-010 — so a strategy that documents itself as hashing cannot truncate.
- The `describeReceived(value)` hook on `ConstraintDefinition`, with the type-preserving default.
- The object-graph walk: runtime-constructor keyed (§5.3), depth-bounded, cycle-safe. **Not** reusing `safeStringify`'s cycle logic by copy — sharing it, since BUG-13 records that the naive version mislabels sibling references.
- The test-time assertion helper (§8.3), shipped *with* the surface rather than after it.

### Phase R2 — the projection and the alert

- `sensitivityReport()` + renderer (§8.1), following `docs.ts`'s extract/render seam.
- The runtime redaction counter (§8.2), off by default.
- The optional `util.inspect.custom` hook; `toJSON` behind an explicit per-marking opt-in (§7.3).

### Phase R3 — static-analysis export *(far horizon; gated on adoption, not on technology)*

Emit `@Sensitive` declarations as taint-analysis **sources** — a generated CodeQL model pack or Semgrep rule (§8.4). This is the only item here that addresses exposure through code adorn does not own, and it does so by supplying the one input those tools cannot derive.

**Gated deliberately.** The technical work is small; the risk is that it is effort spent on a vocabulary nobody has adopted. It should wait until the declaration surface has real use, for the same reason Phase O2 waits in the observability plan: the moment an external tool binds to adorn's declarations, they become a public API surface and inherit Q-6's semver problem.

### Deliberately not scheduled

- **A `Secret<T>` wrapper type.** §3.3 — the ecosystem has good ones, they solve a different problem (credentials, not domain fields), and adorn competing with them would be a worse version of something the user already has, which is precisely what `Time.ts` refuses to do.
- **Name-based heuristics**, in any role. §9.
- **Value-level tainting.** §5.5.
- **Content-regex scanning** of rendered strings. It is the only thing that catches a secret in free text (§3.1, `redact-pii`), and it is probabilistic, English-biased, and expensive. If it is ever wanted, it belongs in a sink or a collector, not in adorn's core.

---

## 11. Limitations, stated rather than buried

**1. The primitive-parameter gap is permanent and is the design's defining limit.** `transfer(ssn: string)` cannot be redacted from a field declaration. §5.4. Every piece of documentation that describes propagation must state this in the same breath, because a developer who marks `User.ssn` and assumes coverage of `transfer(user.ssn)` has exactly the false belief the class-transformer issue tracker is full of.

**2. Partial coverage creating false confidence is the primary risk of this entire design, and it is not fully mitigable.** §6.4's table is the mitigation, and a table is a weak mitigation against a developer who reads a decorator name and stops thinking. The evidence that this happens is not speculative — it is [class-transformer#146](https://github.com/typestack/class-transformer/issues/146), [#246](https://github.com/typestack/class-transformer/issues/246) and [#1539](https://github.com/typestack/class-transformer/issues/1539), the last closed as *not planned*. **A design that lets a developer believe they are covered when they are not is worse than no design at all.** The reason this document nonetheless recommends building it is §6.2's principle: because the safe behaviour does not depend on the annotation, a developer who over-trusts `@Sensitive` is still protected by the allowlist underneath it. **If that principle is ever weakened — if any path is made to depend on `@Sensitive` for its safety — this risk becomes disqualifying and the feature should not ship.**

**3. Deep redaction has a real cost and the mitigations are requirements.** §4.3: ~900 ns for a ~50-node graph, against 1,870 ns for `JSON.stringify` of the same object. Acceptable *given* it is only paid when a sink exists and a value was explicitly opted in. The caching hazard is sharper than elsewhere: memoising a per-constructor redaction plan would make a later `Object.setPrototypeOf` **under-redact**, which is a security failure rather than the wrong-contract failure SMELL-18 and DEC-021 already reason about. Recommend no cache initially, a depth bound, and a benchmark before any cache lands.

**4. Airtightness and transparency cannot both be had.** §4.1. `@Sensitive` marks a field that must remain ordinarily readable, so spread, `Object.values` and `structuredClone` will always escape. The `#private`-field wrapper technique that closes those (§3.3) is unavailable precisely because it changes the data. This is a permanent architectural ceiling, not a backlog item.

**5. Violation messages get worse, and that cuts against a stated project value.** `vision.md`'s "great failure is a feature" (§2.3). §6.3 argues the cost is small for length and range constraints and real for `pattern` and `oneOf`. `setViolationValueDisclosure('full')` exists for local development, and its existence is itself a risk — someone will set it in production.

**6. Hashing is pseudonymisation, not anonymisation — and two regimes say so independently.** GDPR Recital 26 keeps pseudonymised data in scope; PCI 3.5.1.1 requires a **keyed** hash and 3.5.1.c warns about correlating hashed and truncated forms of the same value (§3.5). So `redact('hash')` must be salted or keyed, must be documented as reducing exposure rather than discharging obligation, and must not be presented as a compliance control. Note the trap in the other direction: GDPR Art. 32 lists pseudonymisation as an appropriate *security measure*, so it is genuinely worth doing — it is simply not an exit from scope. Both things are true and the documentation must say both. Worth flagging that CodeQL and OWASP are both looser than this (§3.4, §3.5): adorn should follow the regulation, not the tooling.

**7. `@Sensitive` on a class is coarse and will be over-applied.** It is the ergonomic option, so it will be reached for, and a class-wide marking makes the intersection report less informative (everything is sensitive, so nothing stands out). No mechanism is proposed; it is a documentation matter.

**8. The registry only sees what has been imported.** DEC-007, restated for a report whose reader will over-trust it. §8.1.

**9. Nothing here protects against adorn itself being misconfigured.** `setViolationPolicy(handler)` hands a handler the structured violation; a handler that calls `JSON.stringify` on it and logs the result is fine under shape B (§4.2), but a handler that reaches for the non-enumerable `value` and logs it is not. That is the `expose_secret()` trade: a single greppable call site, deliberately reachable.

---

## 12. What I could not verify

- **Whether pino silently ignores non-matching redact paths.** Inferred from the absence of validation in `lib/redaction.js` and from fast-redact's "checks that the path exists" prose. No documentation states it. It is the single most consequential claim in §3.1 and it is an inference.
- **Whether pino scans literal message strings.** Inferred from the `redactFmtSym` source comment, not from a doc statement.
- **Whether `structlog` ships any built-in redaction processor.** Strong negative across the processors, examples and recipes pages; the full API reference was not enumerated.
- **The exact rendered `Debug` output for `SecretString`.** Derived from the format string plus the type alias; not executed.
- **Whether pre-0.10 `secrecy::Secret<T>` had a `Display` impl.**
- **Serilog's "policies apply automatically but only on the destructuring path."** Follows directly from the verified operator semantics, but no single Serilog sentence states it in those words.
- **`@latehours/secret`'s implementation** — npm summary only.
- **PCI-DSS quotations were not fetched from the PCI SSC.** The direct PDF URL returns **403** to anonymous requests — the SSC library requires accepting terms. The §3.5 quotes were verified against an extracted text copy of the v4.0.1 PDF, whose version header and copyright line were confirmed, but nobody in this session downloaded it from source. **Re-download and spot-check requirements 3.3.1, 3.4.1, 3.5.1 and 3.5.1.1 before this document is relied on externally.** The requirement numbers are corroborated across independent secondary sources; the exact wording is one step removed.
- **GDPR text is from an unofficial reproduction.** [gdpr-info.eu](https://gdpr-info.eu) matches the well-known official wording, but EUR-Lex returned empty bodies on three separate attempts (it blocks non-browser clients), so the primary source was never reached. If this goes to a legal reviewer, confirm Recital 26 at [EUR-Lex CELEX:32016R0679](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679) in a browser.
- **SonarQube's coverage** was not resolved. `javasecurity:S5145` is log *forging* (CWE-117) — the inverse of this document's concern — and a newer `javasecurity:S7610` may or may not cover general server-side PII; `rules.sonarsource.com` was DNS-unreachable. Sonar is therefore absent from §3.4 rather than assessed.
- **Mariana Trench's annotation retention requirement** is inferred (`CLASS`/`RUNTIME`, since it analyses DEX), not documented.
- **No tainting-annotated JDK** exists for the Checker Framework as far as could be determined — inferred absent, well-supported by the ECOOP paper's "too many false positives to be usable" finding, but not directly stated anywhere.
- **§4's measurements are single-machine, single-shape microbenchmarks** on Node v22.11.0, not a benchmark of adorn. §4.3's 900 ns is explicitly a floor.
- **The `esbuild` minification result (§4.4) is one tool at one version** (0.28.1) with default settings. Terser's `mangle.properties` is off by default and I did not test it; a consumer who enables property mangling would break field-keyed markings, and I have not verified how loudly.

---

## 13. Proposed decision entries

> **Proposals only.** Written in `DECISIONS.md` format for easy transfer. **The `DEC-PII-n` identifiers are placeholders** — `DECISIONS.md` is being edited concurrently, and DEC-021's own numbering note records what happens when two agents claim the same number. Renumber into the main sequence on adoption.

### DEC-PII-1 — `@Sensitive` is never load-bearing on any path
**Status:** PROPOSED · **the principle the rest of this design is derived from**

**Context.** Every annotation-based privacy mechanism surveyed fails the same way: not because the annotation is *wrong*, but because it is *absent*. pino's string paths silently stop matching on a rename; class-transformer's `@Exclude()` is inert unless the developer routes through `instanceToPlain`, and its issue tracker documents real developers believing otherwise; bunyan's own default serializer passes `Authorization` through untouched.

**Decision.** Every path that can emit a value defaults to a safe rendering **without consulting any annotation**. Telemetry and log records emit nothing absent an explicit `@Telemetry.value()` allowlist entry (DEC-OBS-2). Violation messages render a derived projection, not the value (DEC-PII-4). `@Sensitive` then adds only: a stronger redaction, propagation into object graphs, a veto over an explicit opt-in, and an enumerable declaration for the report and the runtime alert.

**Rationale.** Forgetting an annotation is the normal case. A design in which forgetting `@Sensitive` causes a leak has made a control out of universal developer diligence, which does not hold. A design in which forgetting it costs only a *better* redaction and a line in a report degrades safely. This also bounds the false-confidence risk: a developer who over-trusts `@Sensitive` is still protected by the allowlist beneath it.

**Consequences.** `@Sensitive` is defence-in-depth everywhere and load-bearing nowhere, so a false negative is cheap by construction. The corollary is a standing constraint on future work: **if any path is ever made to depend on `@Sensitive` for its safety, the false-confidence risk becomes disqualifying and the feature should not ship in that form.** Cost: the annotation looks weaker than developers will expect, and the documentation must explain why that is the point.

### DEC-PII-2 — sensitivity attaches to fields, parameters, classes and returns — never to types
**Status:** PROPOSED

**Context.** The natural TypeScript instinct is a branded or opaque type (`Secret<string>`). Rust's `secrecy` achieves a genuine guarantee that way — `println!("{}", secret)` does not compile, because no `Display` impl exists.

**Decision.** `@Sensitive` attaches to a **field** (the propagating form, recorded in the registry's field band), a **parameter** (mandatory for primitives), a **class** (marks every field), and a **method** (marks its return). It does not attach to a type.

**And it is not boolean.** Following Palantir `safe-logging`'s three-valued lattice (`@Safe` / `@Unsafe` / `@DoNotLog`), adorn distinguishes *unmarked*, `@Sensitive()`, and `@Sensitive({never: true})` — the last making a conflicting `@Telemetry.value()` on the same site a **decoration-time error** rather than a silently-vetoed override. That is DEC-021's move applied here: make the wrong thing unexpressible rather than merely detected.

**Rationale.** TypeScript types are erased — *"Type annotations never change the runtime behavior of your program."* Rust's guarantee comes from `Debug`/`Display` being runtime traits the formatting machinery dispatches; a TS brand is gone before any formatting operation exists. A runtime wrapper class with a `#private` field is genuinely strong and is the right answer for **credentials**, but it changes the developer's data — `user.ssn` stops being a string — which is unacceptable for a **domain field** the application legitimately reads and renders.

**Consequences.** adorn covers domain fields and points at existing wrapper packages for credentials rather than competing with them. The field band brings DEC-021's inheritance union for free, so a subclass can never un-mark an inherited sensitive field — weakening is *unexpressible*, which is exactly the property a privacy marking needs and which adorn already built for unrelated reasons.

### DEC-PII-3 — object values are redacted against the runtime constructor, not `design:paramtypes`
**Status:** PROPOSED

**Context.** The obvious implementation of propagation reads a parameter's declared type from `design:paramtypes` and looks up that constructor's field markings. That inherits every `design:paramtypes` weakness: erasure to `Object` for interfaces, unions and generics, and total absence under esbuild/Babel (DEC-004).

**Decision.** At emit time, resolve markings from the **runtime value's own prototype**, not its declared type. `design:paramtypes` is used only for the *static* build-time report (§8.1), where no runtime value exists, and there subject to the usual honest-absence rule.

**Rationale.** At emit time adorn holds the actual object, so the exact prototype is available. No erasure; unions resolve to whichever member arrived; subclasses resolve correctly and pick up DEC-021's inherited union; and **the feature works with no `emitDecoratorMetadata` at all**, so propagation does not inherit DEC-004's toolchain constraint. This is strictly more reliable than the declared type and removes the design's largest apparent fragility.

**Consequences.** The runtime walk and the static report can disagree — the report is limited by declared types, the walk is not. That is an honest difference between a static and a dynamic question, and the report must say so rather than imply completeness.

### DEC-PII-4 — violation messages render a derived projection of the received value
**Status:** PROPOSED · **breaking for every violation message** · resolves **BUG-19**

**Context.** `Descriptor.formatMessage` interpolates the offending value into the `Error` message. `setViolationPolicy` and `setContractDiagnosticsSink` exist to route violations elsewhere, so the value travels wherever errors travel — further than `console.log`. Per-parameter redaction at `@Log` cannot help: by then the value is inside an opaque string.

**Decision.** Split the structured violation from its rendered string (P3.1's `ContractViolation`). The structured form carries `constraint`, `params`, `describe()`, site and trust, and **does not carry the value** except as a **non-enumerable** property. `formatMessage` renders a projection supplied by a new `describeReceived(value)` hook on `ConstraintDefinition` — **derived** per DEC-010, permitted to return a bounded description, never the raw value. Default disclosure is `'projected'`; `setViolationValueDisclosure('full' | 'projected' | 'none')` exists for local development. The marking reaches `Descriptor.ts` as a pre-resolved `disclosure` field on `ViolationContext`, plain data, resolved at install time by the two enforcement call sites — the same pattern `signature` already uses, and the same shape as GAP-9's "the registry learned about *fields*, not decorators."

**Rationale.** Measured: making the message a projection and the value non-enumerable reduces **five** accidental leak paths (`message`, `String(err)`, `JSON.stringify`, `util.inspect`, spread) to **one deliberate** one (`err.value`). That is `secrecy`'s `expose_secret()` property achieved in JavaScript — reachable for debugging, unreachable by accident, greppable at every access. And for most built-in constraints the received value is largely redundant with the constraint's own dimension: a `minLength` violation is diagnosed by the length, not the content.

**Consequences.** Every violation message changes, and tests pinning them change with it. This cuts against `vision.md`'s "great failure is a feature" — genuinely, and more for `pattern` and `oneOf` than for length and range constraints. The default in `formatMessage` applies when `disclosure` is absent, so a future enforcement path that forgets to forward it gets the safe rendering rather than the unsafe one. `setViolationValueDisclosure('full')` is itself a risk: someone will set it in production.

### DEC-PII-5 — the primitive-parameter gap is documented, never papered over
**Status:** PROPOSED

**Context.** `transfer(user: User)` can be redacted from a `@Sensitive User.ssn` declaration. `transfer(ssn: string)` cannot: the value is a primitive and the connection to `User.ssn` was destroyed at the call site by value semantics. The information does not exist in the callee's frame.

**Decision.** Require an explicit `@Sensitive()` on the parameter, and state the gap in the same breath as every claim about propagation — in the README, not a footnote. Ship no fallback.

**Rationale.** The two available fallbacks are both worse than the gap. **Name heuristics** catch `password` and miss `dob`, `ssnLast4`, `motherMaidenName`, `answer`, `note`, `payload` — and, verified against `esbuild --minify`, would see `t`, `c`, `e` in the production build, so they work in development and silently stop working in production. **Value tainting** is worse still: primitives cannot carry markings (assignment silently no-ops; boxing makes `typeof` return `'object'` and `===` return `false`, and `JSON.stringify` unwraps it anyway), and an ambient taint set must retain the sensitive values to compare against, creating the exposure it exists to prevent, over-tainting on value collisions, and failing on any transformation such as `ssn.slice(-4)`.

**Consequences.** Coverage is partial by construction, exactly as Q-3 forced this project to concede for fuzzing. The honest claim is *"mark a field once and object-typed parameters redact automatically"* — not *"mark a field once and you are covered."* Making that distinction badly is the single largest risk in this design.

### DEC-PII-6 — the exposure report is a projection; the runtime alert is not
**Status:** PROPOSED

**Context.** The user's "alert on conditions where those fields are exposed" looks like the documentation projection's shape: enumerate sensitive fields, enumerate what is logged, report the intersection.

**Decision.** Ship the intersection as a genuine **sixth projection** — registry-only, pure read, build-time, with the same two-step extract/render seam `docs.ts` established, satisfying DEC-012 identically. Ship the runtime redaction counter and the test-time assertion helper as **separate mechanisms**, and do not describe either as a projection.

**Rationale.** The intersection is a projection because both of its inputs are declarations in the registry. The alert is not: it reports **actual traffic**, and it answers a question declarations cannot — *is this field actually reaching a log boundary?* Conflating them would repeat the overclaim Q-3 already made this project retract once. The test-time assertion is what actually prevents the class-transformer failure mode, because it fails a build rather than producing a document nobody reads, and it should ship *with* the surface rather than after it.

**Consequences.** The report inherits DEC-007's limitation — the registry only sees what has been imported — and that matters more here than for documentation, because a short report reads as a clean bill of health. It must state its own enumeration basis. Under minification the report's structure survives and its class-name labels degrade.

---

## 14. References

**Node / TypeScript**
- [pino — redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md) · [`lib/redaction.js`](https://raw.githubusercontent.com/pinojs/pino/main/lib/redaction.js) · [`package.json`](https://raw.githubusercontent.com/pinojs/pino/main/package.json) · [`@pinojs/redact`](https://github.com/pinojs/redact) · [fast-redact readme](https://raw.githubusercontent.com/davidmarkclements/fast-redact/master/readme.md) · [pino#847 — child-logger bypass](https://github.com/pinojs/pino/issues/847)
- [winston — logform formats](https://github.com/winstonjs/logform) · [winston#1079 — "redacting secrets", closed "use a custom format"](https://github.com/winstonjs/winston/issues/1079)
- [bunyan README](https://github.com/trentm/node-bunyan) · [`lib/bunyan.js` — `headers: req.headers`](https://raw.githubusercontent.com/trentm/node-bunyan/master/lib/bunyan.js) · [pino-std-serializers `req.js`](https://raw.githubusercontent.com/pinojs/pino-std-serializers/master/lib/req.js)
- [class-transformer README](https://github.com/typestack/class-transformer) · [#146](https://github.com/typestack/class-transformer/issues/146) · [#246](https://github.com/typestack/class-transformer/issues/246) · [#1539 (closed as not planned)](https://github.com/typestack/class-transformer/issues/1539) · [NestJS serialization docs](https://raw.githubusercontent.com/nestjs/docs.nestjs.com/master/content/techniques/serialization.md) · [nestjs/nest#10086](https://github.com/nestjs/nest/issues/10086)
- [redact-pii](https://github.com/solvvy/redact-pii) · [pino-noir](https://github.com/pinojs/pino-noir)
- [`@transcend-io/secret-value`](https://github.com/transcend-io/secret-value) · [`@pallad/secret`](https://github.com/pallad-ts/secret)

**OpenTelemetry**
- [Trace SDK spec — sampler and SpanProcessor constraints](https://opentelemetry.io/docs/specs/otel/trace/sdk/)
- [Collector redaction processor — allowlist-first](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor)
- [Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/) · [Attribute requirement levels — Opt-In](https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/)

**Other ecosystems**
- [Lombok `@ToString`](https://projectlombok.org/features/ToString) · [`@ToString.Exclude` javadoc](https://projectlombok.org/api/lombok/ToString/Exclude.html)
- [Serilog `IDestructuringPolicy`](https://github.com/serilog/serilog/blob/dev/src/Serilog/Core/IDestructuringPolicy.cs) · [`LoggerDestructuringConfiguration`](https://github.com/serilog/serilog/blob/dev/src/Serilog/Configuration/LoggerDestructuringConfiguration.cs) · [Structured Data wiki](https://github.com/serilog/serilog/wiki/Structured-Data) · [Destructurama.Attributed](https://github.com/destructurama/attributed) · [Serilog.Enrichers.Sensitive](https://github.com/serilog-contrib/Serilog.Enrichers.Sensitive)
- [`secrecy` docs.rs](https://docs.rs/secrecy/latest/secrecy/) · [source](https://raw.githubusercontent.com/iqlusioninc/crates/main/secrecy/src/lib.rs) · [changelog](https://github.com/iqlusioninc/crates/blob/main/secrecy/CHANGELOG.md)
- [structlog processors](https://www.structlog.org/en/stable/processors.html) · [recipes — traceback redaction](https://www.structlog.org/en/stable/recipes.html) · [Python logging cookbook — filters](https://docs.python.org/3/howto/logging-cookbook.html#using-filters-to-impart-contextual-information)
- [TypeScript handbook — type erasure](https://www.typescriptlang.org/docs/handbook/2/basic-types.html)

**Static analysis**
- [CodeQL — `js/clear-text-logging`](https://codeql.github.com/codeql-query-help/javascript/js-clear-text-logging/) (CWE-312/359/532) · [Ruby equivalent](https://codeql.github.com/codeql-query-help/ruby/rb-clear-text-logging-sensitive-data/) · [`java/sensitive-log`](https://codeql.github.com/codeql-query-help/java/java-sensitive-log/) (precision `medium`, off by default)
- [`SensitiveActions.qll`](https://raw.githubusercontent.com/github/codeql/main/javascript/ql/lib/semmle/javascript/security/SensitiveActions.qll) — *"This library tries to guess…"* · [`SensitiveDataHeuristics.qll`](https://github.com/github/codeql/blob/main/shared/concepts/codeql/concepts/internal/SensitiveDataHeuristics.qll) — the name regexes, incl. `// this seems too noisy`
- [`CleartextLoggingQuery.qll`](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/CleartextLoggingQuery.qll) — *"We rely on heuristic sources"* · [`CleartextLoggingCustomizations.qll`](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/CleartextLoggingCustomizations.qll) — hashing as a name-matched sanitizer
- [Suite selectors](https://github.com/github/codeql/blob/main/misc/suite-helpers/code-scanning-selectors.yml) — the `precision: high` gate · [CodeQL 2.17.4 changelog](https://codeql.github.com/docs/codeql-overview/codeql-changelog/codeql-cli-2.17.4/)
- [CodeQL models-as-data (Java)](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-java-and-kotlin/) · [barrier models changelog](https://github.blog/changelog/2026-04-21-codeql-now-supports-sanitizers-and-validators-in-models-as-data/)
- [Semgrep taint mode](https://docs.semgrep.dev/writing-rules/data-flow/taint-mode) · [Pro Engine intro](https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro) — intraprocedural limit in CE · [`logger-credential-leak.yaml`](https://github.com/semgrep/semgrep-rules/blob/develop/python/lang/security/audit/logging/logger-credential-leak.yaml) · [`avoid-logging-everything.yaml`](https://github.com/semgrep/semgrep-rules/blob/develop/ruby/rails/security/audit/avoid-logging-everything.yaml)
- [Rails `filter_parameter_logging`](https://github.com/rails/rails/blob/main/railties/lib/rails/generators/rails/app/templates/config/initializers/filter_parameter_logging.rb.tt) — name-based by default
- [Checker Framework Tainting Checker](https://checkerframework.org/manual/#tainting-checker) · [ECOOP 2025 — *Practical Type-Based Taint Checking and Inference*](https://arxiv.org/abs/2504.18529)
- [Pysa model DSL](https://pyre-check.org/docs/pysa-model-dsl/) — `typing.Annotated` matching removed · [Pysa basics](https://pyre-check.org/docs/pysa-basics/)
- [Mariana Trench models](https://mariana-tren.ch/docs/models/) — `has_annotation` as a taint source

**Standards**
- [GDPR Recital 26](https://gdpr-info.eu/recitals/no-26/) — pseudonymised data is still personal data · [Art. 5](https://gdpr-info.eu/art-5-gdpr/) · [Art. 25](https://gdpr-info.eu/art-25-gdpr/) · [Art. 32](https://gdpr-info.eu/art-32-gdpr/)
- PCI-DSS **v4.0.1 (June 2024)** requirements 3.3.1, 3.4.1 (PAN masked — **BIN** and last four), 3.5.1 (incl. the audit-logs applicability note) and 3.5.1.1 (**keyed** cryptographic hashes). [Document library](https://www.pcisecuritystandards.org/document_library/) — see §12 on sourcing.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — the data-to-exclude list · [OWASP ASVS 4.0.3 §V7](https://github.com/OWASP/ASVS/blob/v4.0.3/4.0/en/0x15-V7-Error-Logging.md) — 7.1.1 / 7.1.2
- [CWE-532](https://cwe.mitre.org/data/definitions/532.html) · [CWE-312](https://cwe.mitre.org/data/definitions/312.html) · [CWE-359](https://cwe.mitre.org/data/definitions/359.html)
- [Palantir safe-logging](https://github.com/palantir/safe-logging) · [Log4j2 delegating appender docs](https://logging.apache.org/log4j/2.x/manual/appenders/delegating.html) — recommends safe-logging over runtime scrubbing

**Internal**
- `docs/observability-plan.md` §5.3, §6, §7 (DEC-OBS-2, DEC-OBS-3, DEC-OBS-4) · `docs/DECISIONS.md` (DEC-006, DEC-007, DEC-010, DEC-011, DEC-012, DEC-016, DEC-020, DEC-021) · `docs/ISSUES.md` (BUG-13, BUG-18, BUG-19, SMELL-1, SMELL-18, GAP-9, Q-3, Q-4, Q-6) · `docs/vision.md`
- `src/Core/Descriptor.ts` · `src/Core/ContractRegistry.ts` · `src/Core/FieldDecoratorFactory.ts` · `src/Core/ParameterDecoratorFactory.ts` · `src/Core/Configuration.ts` · `src/MethodDecorators/Log.ts` · `src/Projections/docs.ts`
</content>
