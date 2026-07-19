# adorn — Vision & Directions

*An aspirational look at where this project could go. This is a document of ideas and directions, not a build plan. It describes a destination worth aiming at, so that day-to-day decisions can be made in its light.*

---

## Where adorn is today

Today, adorn is a small, sharp idea with a working core. It offers a handful of decorators that:

- **validate method parameters at call time** — positivity, numeric bounds, minimum string length;
- **guard fields on assignment** through property setters;
- **wrap methods** to memoize RxJS observables and log calls.

Underneath those conveniences sits the thing that makes adorn interesting: a **decorator factory**. TypeScript's raw parameter decorators are inert — they run once at definition time and never see a real argument. adorn's signature move is to quietly rewrite the decorated method so that those inert annotations become *live behavior*, running on every call. You write a tiny function over a friendly parameter object; adorn hands you back a real, enforced decorator.

That single trick — *turning a declaration into behavior* — is the seed of everything below. The current library validates numbers and strings. But the mechanism it pioneered is far more general than the handful of checks built on top of it. This document imagines what grows from that seed.

---

## North Star

**adorn exists so that a developer states an intention once, and the system derives everything that follows from it — enforcement, documentation, tests, and the search for counterexamples.**

The intent of a method, a field, or a class is normally scattered across four places that immediately begin to disagree: a runtime check in the body, a sentence in the docs, a hand-written unit test, and whatever the author actually meant. Each is maintained separately. Each drifts. The documentation describes last year's behavior; the tests cover the cases someone thought of on a Tuesday; the check in the body is the only one that is definitely true, and it is the one nobody reads.

**The contract stops being only a runtime guard and becomes the single source from which documentation, validation, and tests all descend.**

State the constraint once, on the parameter it governs, and it should yield all four:

| | What the declaration produces |
|---|---|
| **Validation** | the check that runs on every call |
| **Documentation** | the API reference, generated from the same statement it enforces |
| **Testing** | inputs that satisfy the contract, and assertions about what must hold afterward |
| **Fuzzing** | inputs designed to break it, and a definition of what "broken" means |

That last column is what makes the idea more than convenience. A generated input is only as useful as the question you can ask about the result — so a codebase that declares what its methods *guarantee*, not merely what they *accept*, becomes automatically explorable. The contract supplies both the generator and the oracle.

If adorn succeeds, reading a signature tells you the contract; the contract is enforced; the documentation is that same contract rendered; and the test suite is that same contract explored. Nothing drifts, because there is only one thing to drift *from*.

---

## Guiding Principles

These are the commitments that should survive as the surface area grows.

- **Declaration over instruction.** The user says *what* must hold; adorn takes care of *when* and *how* it is checked or applied. A decorator is a statement of intent, not a call site buried in a method body.

- **A declaration must describe itself.** This is the principle the north star rests on, and it is a real constraint on design rather than a nicety. A contract expressed only as a piece of executable logic can be *run* and nothing else — it cannot be read, rendered, translated into a specification, or used to generate an example. To project a declaration into documentation and tests, the library must know not merely *how to check* a constraint but *what the constraint is*. Every contract should therefore carry its own meaning alongside its enforcement. A constraint that can only be executed is a dead end, however elegantly it reads at the call site.

- **Locality of intent.** A contract belongs next to the thing it constrains — on the parameter, the field, the method — not in a separate schema file that can rot out of sync with the code.

- **Authoring must stay trivial.** The reason adorn matters is that it makes *writing your own* decorators easy. Every direction below is only worth pursuing if a competent developer can add their own version of it by writing a small, obvious function. The factory is the product; the built-in decorators are demonstrations.

- **Composability by default.** Many small annotations should stack cleanly on one signature and combine into a coherent whole, in a predictable order, without surprising each other.

- **Great failure is a feature.** When a contract is violated, the message should name the object, the method, the parameter, and the expectation in plain language. adorn already builds descriptive signatures for exactly this reason. That instinct should be treated as core, not cosmetic.

- **Zero surprise, honest cost.** Rewriting methods is powerful and a little magical. The library should be transparent about what it does, quiet by default (no stray diagnostics in production), and offer a way to disappear entirely when it is not wanted.

- **Escape hatches everywhere.** Contracts should be able to warn instead of throw, to be toggled off in production, to be observed rather than enforced. Rigidity is the enemy of adoption.

---

## Direction 1 — The full vocabulary of declarative contracts

adorn began by asking "is this number positive?" The richer question is: *what is the complete grammar of things a developer might want to assert about a value, a call, or an object?* A mature adorn would let people express all of it declaratively.

- **Preconditions.** The natural extension of what exists today: any property a value must satisfy on the way in — ranges, patterns, membership in a set, non-emptiness, well-formed URLs and emails, shapes and structure. The roadmap already gestures at regex, url, email, `between`, and filters; these are the obvious first blooms.

- **Coercions and transformations.** Not every contract rejects — some *repair*. Trim a string, clamp a number into range, apply a default when a value is missing, normalize casing, parse a date. A declared transformation quietly reshapes the argument before the body ever sees it, so the body can assume clean input. This turns adorn from a gatekeeper into a gardener.

- **Defaults as declarations.** "If nothing is supplied, use this" is a contract too, and one every codebase reinvents. Stating it on the parameter is clearer than a line of `x = x ?? default` at the top of every method.

- **Postconditions.** The mirror image of preconditions: assertions about what a method *returns* or about the state it leaves behind. "This never returns null." "The result is always sorted." A method that declares its output contract is documenting and enforcing its promise to callers in one stroke.

- **Invariants.** Properties of an object that must hold *before and after* every method that touches it — a balance never goes negative, a collection stays within bounds. This is where adorn stops being about individual values and starts being about the integrity of a whole object over its lifetime.

- **Cross-parameter and cross-field relationships.** The most interesting contracts span more than one value: `start` must precede `end`; if `mode` is `"custom"` then `config` is required; these two fields must sum to a constant. Single-value checks are table stakes; relational contracts are where a declarative library earns its keep, because they are exactly the rules that are hardest to keep correct by hand.

Taken together, these turn adorn into a **Design-by-Contract toolkit for TypeScript** — preconditions, postconditions, and invariants as first-class, in-language citizens, in the tradition of contract-oriented languages but native to the way TypeScript developers already write classes.

---

## Direction 2 — Cross-cutting concerns, gracefully captured

The other half of adorn's existing surface — memoize, log — points at a different and equally large opportunity. These are **cross-cutting concerns**: behaviors that have nothing to do with a method's core logic but wrap around it, and that today get copy-pasted, half-implemented, and subtly wrong across a codebase. A method decorator is the perfect place to state them once and apply them declaratively.

The observation that adorn already reaches for RxJS is a strong hint. The natural home for many of these concerns is the world of async and reactive flow, where they are most needed and most fiddly to get right.

- **Caching and memoization**, generalized well beyond observables — with awareness of arguments, time-to-live, invalidation, and size limits. What exists is a proof of concept; the ambition is a memoization vocabulary rich enough to replace most hand-rolled caches.

- **Timing and profiling.** The roadmap already names `Time`. Declaring "measure this" turns performance visibility into an annotation rather than an instrumentation project.

- **Resilience patterns.** Retries with backoff, timeouts, circuit breakers, fallbacks, bulkheads. These are the hard-won lessons of distributed systems, and every one of them is naturally expressed as "wrap this call in this behavior." A method that says *retry three times, then fall back* is more honest and more correct than the same logic tangled into its body.

- **Flow control.** Debounce, throttle, rate-limit, queue, serialize concurrent calls. adorn's stubbed `queue` file and its RxJS lean both point here. Declaring the temporal behavior of a method — *never fire this more than once a second* — belongs on the method, not scattered across its callers.

- **Observability.** Structured logging, tracing spans, metrics, and correlation IDs that flow through calls automatically. The existing `Log` decorator is the first step of a much larger idea: that a method can declare its own observability, and the surrounding system lights up for free.

- **Authorization and policy.** "Only an admin may call this." Guarding entry to a method by declared policy keeps security decisions visible at the boundary rather than buried inside.

- **Transactions and units of work.** "Run this inside a transaction; roll back on failure." A declarative transaction boundary is clearer than manual begin/commit/rollback plumbing.

- **Feature flags and experiments.** Gating a method or swapping its behavior behind a declared flag makes rollout and experimentation a property of the code rather than a manual dance.

The unifying idea: **every recurring "wrap this call in X" pattern is a candidate for a decorator**, and adorn's factory is meant to make each one a small function rather than a framework.

---

## Direction 3 — Developer experience as the product

A contract library lives or dies by how it *feels*. adorn's real competitor is not another library; it is the developer's temptation to just write the `if` statement by hand. Winning that comparison is a matter of ergonomics.

- **Composability that reads like prose.** Several annotations on one signature should combine into something a human reads top to bottom and understands. Order should be predictable, conflicts should be caught, and the stack should compose rather than collide.

- **Error messages that teach.** adorn already assembles rich signature strings so a failure can say exactly what was expected and what arrived. This should be treated as a headline feature and pushed further: messages that point to the offending call site, suggest the fix, and never leak the library's own internals into the user's stack trace.

- **Dev/prod duality.** Some contracts are guardrails for development and dead weight in production; others must hold everywhere. A mature adorn lets a contract be strict in dev, silent or stripped in prod, or always-on — configurable centrally, so shipping fast and failing loud are not in tension. The existing (currently unused) global configuration is the beginning of this idea.

- **Discoverability.** The built-in decorators should be organized so that finding "the one that checks emails" is obvious, and so that the shape of the library teaches the shape of the domain — strings here, numbers there, method concerns over here.

- **Deep type-level integration.** The dream is that the type system and the runtime contract agree. A decorator that only makes sense on a `number` should be a type error on a `string`. Applying a coercion should refine the type the body sees. When declaration and type line up, the IDE becomes a collaborator: it surfaces the contract on hover, flags misuse before runtime, and makes the annotations feel like part of the language rather than bolted on.

- **Honesty about the magic.** Method rewriting is clever, and cleverness must be paid for with transparency. The library should be quiet by default, explain what it does when asked, and never leave diagnostic noise or global side effects in the user's way. The desire — already noted in the code — for a "pure" approach that doesn't reach into global built-ins is exactly the right instinct: the magic should be contained, predictable, and opt-in.

---

## Direction 4 — Ecosystem and positioning

adorn does not need to live alone. Its value multiplies when it connects to the tools and frameworks developers already use.

- **A good neighbor to schema validators.** The ecosystem already has excellent schema-first validation libraries. adorn's angle is different and complementary: it is *code-first and local*, putting the contract on the declaration rather than in a separate schema object. A mature adorn would interoperate — able to derive a schema from its annotations, or to defer to one — rather than compete head-on. The two philosophies can serve the same codebase.

- **Framework citizenship.** Decorator-heavy frameworks are a natural home. adorn's contracts could ride alongside dependency injection, controller routing, and ORM entity definitions, adding a layer of enforced meaning to code that is already annotation-shaped.

- **Contracts as a source of truth — now the north star, not a side benefit.** This has been promoted out of this list and to the top of the document, because it is no longer one attractive consequence among several; it is the thing adorn is *for*. The positioning consequence belongs here, though: it changes who adorn competes with. A library that merely validates values competes with excellent, mature, schema-first tools and has to argue it is somehow better at checking a number. A library whose declarations *project into four artifacts* is not in that argument at all. **Nothing in the surrounding ecosystem produces validation, documentation, tests, and fuzzing from one declaration** — the schema libraries stop at validation and inferred types, the compile-time transformers stop at validation, and the contract libraries stop at runtime enforcement. The nearest precedent is not in this ecosystem at all; it is `clojure.spec`, which pairs specification with generative testing and demonstrates the idea is sound rather than merely appealing.

- **A shared authoring standard.** Because the whole premise is that *anyone* can write a decorator over the friendly parameter object, adorn could become the substrate for a community ecosystem — a common shape for third-party contract and concern packages, so that domain-specific validators and behaviors compose with the core and with each other.

---

## Horizons

A tiered sketch of ambition — conceptual, not a schedule. Each horizon assumes the spirit of the ones before it. The tiers have been reordered around the north star: the sequence below is the order in which the *four projections* become possible, because that is what actually gates progress.

### Near horizon — *declarations that describe themselves*

Fill out the vocabulary the project already dreams of — the full set of string and number contracts, coercions, defaults, timing — but write every one of them as a **self-describing declaration** rather than a check. This is the unglamorous, decisive step: a constraint that knows it is "a minimum of zero" rather than merely knowing how to reject a negative number. Make the built-in decorators quiet and pleasant, and make configuration real so contracts can be toggled.

The reward arrives at the end of this horizon and it is the proof the whole idea works: **generated documentation**. It needs nothing but declarations that describe themselves, and it is the first moment the same statement serves two masters without being written twice.

### Mid horizon — *guarantees, and therefore an oracle*

Cross the line from constraining inputs to guaranteeing outcomes: postconditions, invariants, cross-parameter relationships. This is where adorn becomes a genuine **Design-by-Contract toolkit** for TypeScript, in the tradition the idea comes from.

It is also the horizon that unlocks the remaining two projections, and the reason they cannot come sooner. A contract on inputs tells a generator what to *produce*; only a contract on outcomes tells it what to *check*. Without that, exploration can discover crashes and nothing more. With it, **testing and fuzzing** become possible in the same motion — the declaration supplies the generator, the guarantee supplies the oracle, and a properly annotated codebase becomes explorable without anyone writing a test.

### Far horizon — *contracts between systems*

With all four projections in hand, push the idea outward past the boundary of a single program. Contracts that adapt, informed by what actually happens at runtime. Contracts negotiated *across* service boundaries, so a caller and a callee can agree on the promises between them and detect when one side has quietly changed its mind. Specifications that are not written to describe a system but are simply *read off* it, always current because they are the system.

At this horizon adorn is no longer "a library of decorators." It is a way of writing programs where **intent is stated once, honored everywhere, rendered for anyone who needs to read it, and continuously tested against reality** — never allowed to drift from the code that claims it.

---

## Closing

adorn's founding insight is quiet but powerful: a declaration can *become behavior*. The north star extends that insight one step, and the step is the whole point — a declaration can become **behavior, documentation, tests, and the search for counterexamples**, all at once, because all four were only ever restatements of the same intention in different dialects. Writing them separately was never a feature; it was the cost of having nowhere to say the thing once.

The current library is a small proof that the first of those four works. The vision is a codebase where what a developer *means*, what the program *does*, what the documentation *claims*, and what the tests *check* are, at last, the same text.
