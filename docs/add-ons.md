# Add-ons — `adorn/otel` and `adorn/test`

[← README](../README.md) · [Decorators & contracts](decorators.md) · [Schemas & projections](schemas.md) · [Functional API](functional-api.md) · [Observability & privacy](observability.md)

Both add-ons ship in the package as **opt-in subpath exports**: built into `dist`, reachable as `adorn/otel` and
`adorn/test`, but importing the package root (`require('adorn')`) never pulls them — the core runtime dependency
stays `tslib` alone, asserted by the isolation tests. Each declares its heavy dependency as an **optional peer**
you install only when you use that entry point.

## `adorn/test` — property-based testing

```ts
import { fuzzClass } from 'adorn/test';
```

Property-based testing that derives `fast-check` generators from constraint descriptors. Its rule is **sound
generation**: produce only inputs the contract accepts, or *decline* and say so. It consumes the *same* functions
enforcement runs, so the oracle flags an input exactly when the enforced wrapper throws — an executably-pinned
no-drift property.

`fuzzSequence` extends this to **stateful** objects: it drives generated call sequences against one evolving
instance, skips calls whose [`@EnabledWhen`](decorators.md#contracts-pre--and-postconditions) guard says "not
enabled here", and checks that field invariants and postconditions survive every transition.

**Optional peer:** `fast-check`.

```bash
npm install --save-dev fast-check
```

## `adorn/otel` — OpenTelemetry sink

```ts
import { createOtelSink } from 'adorn/otel';
import { setObservationSink } from 'adorn';

setObservationSink(createOtelSink({ /* ... */ }));
```

An OpenTelemetry [`ObservationSink`](observability.md): `createOtelSink()` maps `scope` → an active span,
`completed` → a duration histogram, and `violation` → `recordException` + a value-free span event.

**Optional peer:** `@opentelemetry/api`.

```bash
npm install @opentelemetry/api
```

---

Promoting either add-on to its own top-level `@adorn/*` package later remains an option, but is no longer
required to consume them.
