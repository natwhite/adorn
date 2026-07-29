/**
 * `@adorn/otel` — the OpenTelemetry binding under the O1 observation layer (IDEA-14, DEC-041).
 *
 * ## What this is, and where it lives (DEC-041, DEC-044/045)
 *
 * A **separate, opt-in add-on** that turns adorn's neutral O1 observation stream into OpenTelemetry
 * spans, exceptions, attributes, and (optionally) metrics. It is a *pure mapping layer over a frozen
 * public API*: it consumes ONLY the package root (`../../index`) — `setObservationSink`, `settle`, the
 * `ObservationSink`/`ObservationEvent` union, `ViolationFacts`/`EmittedValue`/`ErrorFacts`, `SpanKind`,
 * `RETURN_INDEX` — exactly as a published downstream consumer would, and adds **zero** new core surface
 * (DEC-045: `@adorn/otel` "needs nothing new"). It names no `src/` internal.
 *
 * `@opentelemetry/api` is the add-on's declared **peer** (a devDependency in this repo, for building and
 * testing only). It never enters core, never reaches `dist/`, and no OTel/span-shaped symbol leaks onto
 * the root export surface — the DEC-019/DEC-044 isolation contract, asserted executably by
 * `isolation.test.ts` (the OTel twin of `addons/test/isolation.test.ts`). The core runtime dep set stays
 * `{tslib}`.
 *
 * It lives in-repo under `addons/` (excluded from the library build, like `addons/test`), is covered by
 * `npm test`, and is **not re-exported from the root `index.ts`** — the runtime export surface (72 value
 * exports, DEC-039) is unchanged. It is a future `@adorn/otel` package.
 *
 * @example
 *   import {setObservationSink} from 'adorn';
 *   import {createOtelSink} from '@adorn/otel';
 *   import {trace, metrics} from '@opentelemetry/api';
 *
 *   // The host wires its own OTel SDK, then installs the sink.
 *   setObservationSink(createOtelSink({tracer: trace.getTracer('app'), meter: metrics.getMeter('app')}));
 */

export {
    createOtelSink,
    mapSpanKind,
    attributesFromValues,
    violationAttributes,
    ADORN_OTEL_VERSION,
} from './sink';
export type {OtelSinkOptions} from './sink';
