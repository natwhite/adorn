/**
 * `@Observe` — the span + duration + disclosed-value observability decorator (O1c, DEC-035, DEC-036).
 *
 * ## What it is
 *
 * A method decorator that, when an {@link ObservationSink} is installed, opens the sink's around-shaped
 * `scope` for the call and emits a `{kind:'completed'}` event when the work *settles* — carrying the
 * duration, the outcome, structured error facts on a throw, and the per-call **pre-disclosed** values. With
 * no sink installed it costs exactly one reference compare and does nothing (the automatic signal stays
 * quiet until a sink is chosen). All of that lives in {@link observeBehavior}; this file is the decorator
 * surface and the span-kind option.
 *
 * ```ts
 * class Api {
 *     @Observe({kind: 'client'})
 *     fetchUser(@Telemetry.value() id: string): Promise<User> { ... }   // an outbound span, id disclosed
 * }
 * ```
 *
 * ## Span kind is declared, never inferred (Q-24 R7)
 *
 * `kind` is not derivable from a signature, and guessing would fabricate — so it is *declared* here, with a
 * reasoned default of `'internal'` (OTel's own default, correct for the overwhelming majority of decorated
 * methods). `@Observe({kind})` is the only place `SpanKind` is set; `@Time` (duration) and `@Log` (message)
 * produce no span and carry no kind.
 *
 * ## The double-emit reconciliation (plan §5)
 *
 * A `@Contract()`+`@Observe()` method installs two wrappers, and without coordination both would emit
 * `{kind:'completed'}`. `@Observe` therefore marks the wrapper it installs as the completion owner
 * ({@link markOwnsCompletion}); the enforcement weave detects that marker at install time and suppresses
 * its own completed emit, deferring to `@Observe`'s richer completion. This changes no contract-check
 * semantics — violations still emit, checks still run, throws still propagate — only which wrapper reports
 * settlement, so the sink sees `completed` exactly once.
 */

import {CreateMethodDecorator} from '../Adapters/legacy/MethodDecoratorFactory';
import {MethodKey} from '../Core/ContractRegistry';
import {observeBehavior} from '../Adapters/legacy/ObservationBehavior';
import {markOwnsCompletion, ObservationDetail, SpanKind} from '../Core/Observation';

const SPAN_KINDS: ReadonlyArray<SpanKind> = ['internal', 'server', 'client', 'producer', 'consumer'];
const DETAILS: ReadonlyArray<ObservationDetail> = ['always', 'detail'];

/** Options for {@link Observe}. */
export interface ObserveOptions {
    /**
     * The OpenTelemetry span kind for this method. Declared, not inferred (Q-24 R7). Defaults to
     * `'internal'` — correct for domain logic; set `'client'`/`'server'`/`'producer'`/`'consumer'` at a
     * boundary so the adapter can draw the service-graph edge.
     */
    readonly kind?: SpanKind;
    /**
     * `'always'` (default) emits under the shipped `'normal'` verbosity; `'detail'` emits only when the host
     * opts into `setObservationVerbosity('detailed')`. The one authoring-time verbosity dial.
     */
    readonly detail?: ObservationDetail;
}

/**
 * Observe a method: open a span-scope for the call and emit a completion when it settles.
 *
 * Composes with `@Contract()` / `@Validate()`; whichever decorator is applied closest to the method runs
 * innermost. When both are present the sink sees `completed` exactly once (see the module note).
 */
export function Observe(options?: ObserveOptions): MethodDecorator {
    const kind = options && options.kind !== undefined ? options.kind : 'internal';
    const detail = options && options.detail !== undefined ? options.detail : 'always';
    if (SPAN_KINDS.indexOf(kind) === -1) {
        throw new TypeError(
            `@Observe: kind must be one of ${SPAN_KINDS.join(', ')}, received ${String(kind)}`,
        );
    }
    if (DETAILS.indexOf(detail) === -1) {
        throw new TypeError(`@Observe: detail must be 'always' or 'detail', received ${String(detail)}`);
    }

    const decorate = CreateMethodDecorator(observeBehavior({kind, detail}));

    return function (target: object, propertyKey: MethodKey, descriptor: PropertyDescriptor) {
        const result = (decorate(target, propertyKey, descriptor as any) as PropertyDescriptor) || descriptor;
        // Mark the installed wrapper as the completion owner so an OUTER enforcement wrapper suppresses its
        // duplicate completed emit (plan §5). The marker is non-enumerable and does not change identity.
        const wrapper = result.value;
        if (typeof wrapper === 'function') markOwnsCompletion(wrapper);
        return result as any;
    } as MethodDecorator;
}
