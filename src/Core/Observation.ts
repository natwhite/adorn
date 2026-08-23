/**
 * O1a — the neutral observation model and the around-shaped sink slot (DEC-035, DEC-036).
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is **interfaces, a frozen empty object ({@link NOOP_SINK}), and three functions**. TypeScript
 * interfaces erase at compile time, so there is nothing here for a bundler to resolve and no runtime
 * dependency of any kind. In particular there is **no module specifier that names `@opentelemetry/*`**
 * — not in an import, not in a string literal, not inside a guarded call. That is the whole point:
 * O1 is the *neutral* observation layer, and it ends exactly where OpenTelemetry begins. The OTel
 * adapter (`@adorn/otel`) is a separate future add-on that maps this model onto spans; it is a peer on
 * `@opentelemetry/api` and is out of scope here (DEC-019). GAP-6 cannot recur because its precondition
 * — a third-party specifier on the load path — is never created.
 *
 * ## Layering (DEC-012)
 *
 * Decorator-agnostic and Core-only: it imports **only** `Descriptor` types. A projection and an adapter
 * may both read it. Nothing here reaches the registry, a decorator, or the enforcement config.
 *
 * ## Two surfaces, two trust levels — "seeing ≠ emitting" (DEC-036, Q-24/R0)
 *
 * The sink has two surfaces and the per-call payload belongs to them differently:
 *
 * - **`record`** (fire-and-forget point events) is the exported, reviewable, privacy-projected surface.
 *   It carries **only pre-disclosed data** — never a raw argument or return value. Disclosure is
 *   resolved once, the per-call renderer produces the `EmittedValue`s, and the event carries the
 *   *rendering*, which is `[REDACTED]` by default (DEC-030).
 * - **`scope`** (the around-wrapper) is definitionally *inside* the call: it wraps `proceed()`, so it
 *   already sees the raw return value and the raw thrown error, exactly as `@Time` already does and is
 *   safe because it does not *emit* them. Handing the adapter the settled value/error via
 *   {@link ObservationCall} is not a new exposure — it is making explicit what around-shape grants.
 *
 * ## Semver-frozen surface (Q-6)
 *
 * {@link ObservationSink} and {@link ObservationEvent} are the surface an adapter binds to. Every new
 * event payload field is **optional and object-shaped**, so `NOOP_SINK`, a record-only sink, and a
 * values-off default all remain the cheap, empty case, and future growth stays additive.
 */

import type {ConstraintKind, ConstraintParams} from './Descriptor';

// ---------------------------------------------------------------------------
// Attributes — the low-cardinality span/log attribute map
// ---------------------------------------------------------------------------

/**
 * A telemetry attribute value. Deliberately narrow and low-cardinality-friendly. It is **not** the
 * carrier for disclosed argument/return values — those are high-cardinality by nature and live on
 * {@link EmittedValue} instead, so the two are never conflated.
 */
export type AttributeValue = string | number | boolean;

export interface Attributes {
    readonly [key: string]: AttributeValue | undefined;
}

/** How much a developer asked to see. Two values only (DEC-035), not the DEC-008 trust ladder. */
export type ObservationDetail = 'always' | 'detail';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * OpenTelemetry span kind, as adorn's **own** string union — mapped to the OTel enum by the adapter,
 * so core names no OTel symbol (Q-24/F3). Default `'internal'`, which fabricates nothing (it is OTel's
 * own default) and is overridden only by an explicit `@Observe({kind})` (O1c).
 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/** Sentinel index for the return value in an {@link EmittedValue}. Parameters are index `>= 0`. */
export const RETURN_INDEX = -1;

/**
 * Marker set by `@Observe` on the wrapper it installs, so the enforcement weave can detect — at install
 * time, once, with zero per-call cost — that an *inner* `@Observe` already owns the `{kind:'completed'}`
 * emit for this method (plan §5 wrapper-unification). A `@Contract()`+`@Observe()` method installs two
 * wrappers; without this both would emit `completed`, so enforcement reads this marker off the method it
 * is about to wrap and **suppresses its own** completed emit, deferring to `@Observe`'s richer completion
 * (which carries the `scope` and the pre-disclosed `values`). It changes NO contract-check semantics —
 * violations still emit, checks still run, throws still propagate — only which wrapper reports settlement.
 */
export const OBSERVED_COMPLETION: unique symbol = Symbol('adorn.observation.ownsCompletion');

/** Whether `fn` is an `@Observe` wrapper that already owns the `completed` emit (see {@link OBSERVED_COMPLETION}). */
export function ownsCompletion(fn: unknown): boolean {
    return typeof fn === 'function' && (fn as any)[OBSERVED_COMPLETION] === true;
}

/** Stamp `fn` as the `completed`-emit owner. Called by `@Observe` on its installed wrapper. */
export function markOwnsCompletion(fn: Function): void {
    Object.defineProperty(fn, OBSERVED_COMPLETION, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: true,
    });
}

// ---------------------------------------------------------------------------
// Per-call correlation id (Q-27, DEC-047) — the additive correlation token
// ---------------------------------------------------------------------------

/**
 * A process-local monotonic counter backing {@link nextCallId}. A plain counter — NOT `Date.now()` or
 * `Math.random()` — is deterministic, allocation-free, and collision-free for the life of the process:
 * the id only has to be unique among concurrently-live calls, and a strictly increasing integer is.
 */
let callSeq = 0;

/**
 * The next per-call correlation id (Q-27). It is stamped once per observed invocation onto that call's
 * {@link ObservationCall} and every {@link ObservationEvent} the same invocation emits, so a sink can
 * match a record-path event (`completed`/`violation`/`message`) back to the specific `scope` call it
 * belongs to — the correlation the frozen, *non-unique* {@link Observation} reference could not provide
 * under concurrent same-method async.
 *
 * There is ONE shared sequence for the whole process (not one counter per wrapper) so ids can never
 * collide across the `@Observe` span wrapper and the enforcement weave. A sink can therefore trust that
 * two events with equal `callId`s came from the *same* wrapper's emit for the *same* invocation.
 * Same-wrapper correlation is the guarantee; cross-wrapper correlation (a weave violation vs. an inner
 * `@Observe` span — different nesting levels, DEC-046) is deliberately out of scope, so those carry
 * distinct ids by construction.
 *
 * Module-internal: a sink never mints ids, it only reads the ones adorn stamped, so this is not on the
 * root export surface (DEC-039).
 */
export function nextCallId(): number {
    return ++callSeq;
}

// ---------------------------------------------------------------------------
// Install-time facts of an instrumented method
// ---------------------------------------------------------------------------

/** The resolved emit decision for one parameter, computed once at install time from the bands (O1c). */
export type ParameterDisclosure = 'deny' | 'value' | {readonly redact: string};

/** A parameter's structural facts. `name` may be absent (minification, DEC-035) — then only `index`. */
export interface ObservedParameter {
    readonly index: number;
    readonly name?: string;
    readonly type?: string;
    readonly disclosure: ParameterDisclosure;
}

/**
 * Everything structurally derivable about ONE instrumented method, fixed for the life of the wrapper
 * and built once at install time — never per call. `name` is `code.function.name`-shaped by
 * construction (`Owner.member`). Never a value here — values live on the per-call event/call.
 */
export interface Observation {
    readonly owner: string; // 'Accounts'
    readonly member: string; // 'transfer'
    readonly name: string; // 'Accounts.transfer' — semconv code.function.name
    readonly isStatic: boolean;
    readonly detail: ObservationDetail;
    /** Span kind (Q-24/F3). Default `'internal'`; overridden only by `@Observe({kind})`. */
    readonly kind: SpanKind;
    /** Per-parameter structural facts + resolved disclosures. Empty until the O1c resolver runs. */
    readonly parameters: ReadonlyArray<ObservedParameter>;
}

// ---------------------------------------------------------------------------
// Per-call payload — the value/error channel (Q-24/R2)
// ---------------------------------------------------------------------------

/**
 * ONE per-call value that has ALREADY passed the disclosure resolver (O1c) — safe to leave the process.
 * Deliberately NOT an {@link Attributes} entry: `Attributes` stays low-cardinality; `rendering` is
 * high-cardinality by nature and lives in its own field. It never carries a raw, ungated value — only
 * the disclosure OUTCOME (`[REDACTED]` by default, the value under an opt-in, a surrogate under redact).
 */
export interface EmittedValue {
    readonly index: number; // parameter index, or RETURN_INDEX for the return
    readonly name?: string; // parameter/return name when recoverable (DEC-035)
    readonly type?: string; // design:paramtypes name when the toolchain emitted it
    /** `true` → `rendering` is the disclosed value or a surrogate; `false` → it is REDACTED. */
    readonly disclosed: boolean;
    /** The resolver's output: REDACTED by default, a rendering under opt-in, a surrogate under redact. */
    readonly rendering: string | number | boolean | null;
    /** `true` only when an explicit `@Telemetry` opt-in was overridden by `@Sensitive` (O1c, Q-24/R8). */
    readonly vetoed?: boolean;
}

/**
 * The thrown error, structured for `span.recordException` and error records (Q-24/F2).
 *
 * `type` is `'adorn.<constraint>'` for a reified contract violation, `'_OTHER'` for the semconv
 * fallback (a hand-written `@Ensures` closure, or a value with no error name). `message` is carried as
 * the emitter produced it: adorn's own violation messages are ALREADY redacted by default at the source
 * (BUG-19), and a user-thrown error's message is developer-authored — no new leak, no new veto.
 */
export interface ErrorFacts {
    readonly type: string;
    readonly message?: string;
    readonly stack?: string;
}

/**
 * The structured, VALUE-FREE facts of a contract violation (DEC-035). Assembled from constraint
 * identity + params + `describe()` + parameter identity, with `trust`/`blame` added at the enforcement
 * site. It carries NO received value and NO rendered message string — that is the whole point (the
 * rendered message can embed the value under disclosure; these facts must be safe unconditionally).
 *
 * For a reified constraint (`@GreaterThan`, `@Returns(<descriptor>)`) every field is real and groupable.
 * For a hand-written `@Ensures` closure it degrades: `constraint` is the `'_OTHER'` sentinel, `kind` is
 * `'generic'`, and `params` is empty — the SMELL-14 trade, stated not hidden.
 */
export interface ViolationFacts {
    readonly constraint: string; // 'minLength' → error.type: adorn.min_length ; '_OTHER' for a closure
    readonly kind: ConstraintKind;
    readonly params: ConstraintParams;
    readonly expectation: string; // describe() — 'a string of at least 10 characters'
    readonly parameterName?: string;
    readonly parameterIndex: number; // RETURN_INDEX for a postcondition on the return value
    readonly parameterType?: string;
    readonly trust: 'guard' | 'assert'; // the free guard-vs-assert dimension (DEC-008)
    readonly blame: 'caller' | 'callee'; // precondition blames the caller, postcondition the callee
}

/**
 * Everything the AROUND surface ({@link ObservationSink.scope}) sees for one call: install-time facts
 * plus the pre-disclosed per-parameter renderings. Raw args are deliberately NOT here — the record path
 * carries only disclosed data, and the around path reaches the raw outcome through its own `proceed()`.
 */
export interface ObservationCall {
    readonly observation: Observation;
    readonly thisArg: unknown;
    /** Pre-disclosed arg renderings (placeholder unless opted in). THE safe span-attribute source. */
    readonly values: ReadonlyArray<EmittedValue>;
    /**
     * Per-call correlation id (Q-27, DEC-047), from {@link nextCallId}. It is shared with every
     * {@link ObservationEvent} this same invocation emits — in particular this `scope` call's
     * `completed` event — so a sink can correlate a record-path event to the exact span/call it belongs
     * to under concurrent same-method async, which the non-unique {@link Observation} reference cannot.
     */
    readonly callId: number;
}

// ---------------------------------------------------------------------------
// The event union — the record surface
// ---------------------------------------------------------------------------

/**
 * A point-in-time event handed to {@link ObservationSink.record}. Three kinds; an adapter reads them,
 * a projection reads them, an O3 metrics counter reads them. Every payload field beyond the
 * discriminant is optional and object-shaped so the union grows additively (Q-6).
 *
 * The one required addition since the freeze is `callId` (Q-27, DEC-047): a scalar per-call correlation
 * token present on every variant. It is reader-safe and additive — a sink *receives* these events (it
 * never constructs the union), and {@link ObservationSink} is unchanged — while giving a sink the token
 * to match a record-path event back to its `scope` call, which the non-unique {@link Observation}
 * reference could not. It shares the invocation's {@link ObservationCall.callId}.
 */
export type ObservationEvent =
    | {
          readonly kind: 'completed';
          readonly observation: Observation;
          readonly callId: number; // correlation token (Q-27) — shared with this call's scope
          /**
           * Epoch-ms start (voice-agent L14, DEC-076). Optional and additive: with it a record-only sink can
           * POSITION this interval — place a span at `[startedAt, startedAt + durationMs]` — not only measure
           * its length. The retroactive/socket-driven case (two events many awaits apart, no call stack to
           * wrap with `scope`). Absent → a sink falls back to the span its `scope` opened, as before.
           */
          readonly startedAt?: number;
          /**
           * The `callId` of the enclosing call (voice-agent L15, DEC-076). Optional and additive: a consumer
           * emitting a TREE from the record path states the parent EDGE explicitly — declaration, not the
           * cross-wrapper INFERENCE DEC-046 scoped out. A sink that nests via `scope`'s active context ignores
           * it; a record-only sink rebuilding a tree from socket events uses it to nest without a context manager.
           */
          readonly parentCallId?: number;
          readonly durationMs: number;
          readonly outcome: 'returned' | 'threw';
          readonly settled: boolean;
          readonly values?: ReadonlyArray<EmittedValue>; // pre-disclosed arg + return renderings
          readonly error?: ErrorFacts; // present iff outcome === 'threw'
          readonly attributes?: Attributes; // optional low-cardinality span/log attrs
      }
    | {
          readonly kind: 'violation';
          readonly observation: Observation;
          readonly callId: number; // correlation token (Q-27) — shared across this invocation's emits
          readonly violation: ViolationFacts; // value-free — that is its point
          readonly values?: ReadonlyArray<EmittedValue>; // the offending parameter, iff opted in (O1c)
          readonly error?: ErrorFacts; // the violation error (message redacted by default)
      }
    | {
          readonly kind: 'message';
          readonly observation: Observation;
          readonly callId: number; // correlation token (Q-27) — shared across this invocation's emits
          readonly level: LogLevel;
          readonly message?: string;
          readonly attributes: Attributes; // the low-cardinality map
          readonly values?: ReadonlyArray<EmittedValue>; // disclosed renderings, SEPARATE from attributes
      };

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/**
 * The one telemetry seam. Both members are optional on purpose: a sink that only wants records omits
 * `scope`; a sink that only wants span-nesting omits `record`; {@link NOOP_SINK} omits both, so
 * "no sink installed" and "installed but does not care about this signal" are the same cheap branch.
 */
export interface ObservationSink {
    /**
     * AROUND-shaped — THE reason this is not `(event) => void`. An OTel adapter implements it as
     * `tracer.startActiveSpan(call.observation.name, {...}, () => proceed())`, so the span is the
     * active context for the duration of the call and nested decorated methods / auto-instrumented I/O
     * nest under it. A record-only sink implements this as just `proceed()` and uses `record` alone.
     */
    scope?<T>(call: ObservationCall, proceed: () => T): T;

    /** Fire-and-forget point events. Carries ONLY pre-disclosed data (DEC-036). */
    record?(event: ObservationEvent): void;
}

/**
 * The default. `scope` is absent (so the seam is exactly `proceed()` — no wrapping, no allocation) and
 * `record` is absent. A single shared frozen reference, so the hot-path test is one `===` compare and
 * the seam is a genuine no-op until a sink is set — zero overhead when unobserved.
 *
 * **Internal.** Not re-exported from the package: a sink author does not need the sentinel.
 */
export const NOOP_SINK: ObservationSink = Object.freeze({});

let sink: ObservationSink = NOOP_SINK;

/** Route every observation somewhere — an `@adorn/otel` adapter, a JSON logger, a test spy. */
export function setObservationSink(next: ObservationSink | null): void {
    sink = next || NOOP_SINK;
}

/** The installed sink, read live by the emitters. Compare against {@link NOOP_SINK} for the fast path. */
export function getObservationSink(): ObservationSink {
    return sink;
}
