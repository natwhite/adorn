/**
 * `@Telemetry` — the per-parameter / per-return value-disclosure opt-in (O1c, DEC-036).
 *
 * ## What this is, and what it is not
 *
 * `@Telemetry` *marks*. It records into {@link ContractRegistry}'s telemetry-disclosure band that a
 * parameter's or a return's value may leave the process on the observation `record` path. It does **not**
 * emit, install, or enforce anything — it is record-only, the exact twin of `@Sensitive`. The rendering of
 * the value (redacted by default, disclosed only under an opt-in) is `ObservationBehavior`'s job, and the
 * decision is composed by the shared disclosure resolver. Nothing about a value's runtime behaviour changes.
 *
 * ## Why it exists (the gap DEC-030 left open)
 *
 * DEC-030 gave a **global** debug switch (`setValueDisclosure('all')`) and a **veto** (`@Sensitive`). It
 * deliberately did *not* give a **per-parameter production opt-in** — the thing that lets `amount` emit its
 * value in production telemetry while `memo` never does. That is `@Telemetry`: reviewable, local to the
 * position it governs, and minification-safe via an explicit name.
 *
 * ```ts
 * @Contract()
 * class Accounts {
 *     transfer(
 *         @Telemetry.value()   @GreaterThan(0)    amount: number,    // value emitted
 *         @Telemetry.redact('type')               accountId: string, // a 'String' surrogate emitted
 *                              @StringMinLength(1) memo: string,      // never emitted (deny-by-default)
 *     ) {}
 *     @Telemetry.result() getBalance(id: string): number { return 0 }  // return opt-in (the Q-23 half)
 * }
 * ```
 *
 * ## The `@Sensitive` veto is surfaced, not silenced (DEC-025 / Q-24 R8)
 *
 * `@Sensitive` still wins — an opted-in value on a `@Sensitive` position stays redacted. But the collision
 * is announced (a one-shot dev diagnostic, an `EmittedValue.vetoed` flag, and a distinct projection row
 * state) rather than swallowed. There is deliberately no `{force:true}` escape: a per-parameter switch that
 * defeats `@Sensitive` is exactly the silent-inclusion foot-gun DEC-025 forbids.
 *
 * ## Layering (DEC-012)
 *
 * A namespace of legacy decorators that resolve their target from argument shape (as `@Sensitive` does).
 * They call the registry's record-only writers and nothing else; the registry learns a position *opted in*,
 * never that a decorator named `@Telemetry` produced the marking.
 */

import {
    MethodKey,
    recordParameterTelemetry,
    recordReturnTelemetry,
    TelemetryDisclosure,
    TelemetryMarking,
} from '../Core/ContractRegistry';

/**
 * The redact strategies shipped in O1c (plan §7): a small, honest, crypto-free set. Each strategy names its
 * own behaviour, so it cannot document one transform and apply another. `hash` / `first(n)` / `last(n)` /
 * `domain` are a deliberate fast-follow once demand exists — an unbuilt strategy is refused loudly rather
 * than silently doing the wrong thing.
 */
const SHIPPED_STRATEGIES = ['type', 'length'] as const;
const DEFERRED_STRATEGIES = ['hash', 'first', 'last', 'domain'];

export type RedactStrategy = (typeof SHIPPED_STRATEGIES)[number];

/** The constructor-parameter key, mirroring `@Sensitive` — a constructor parameter arrives with no key. */
const CONSTRUCTOR_PARAMETERS: unique symbol = Symbol('adorn.telemetry.constructor');

function recordParameter(marking: TelemetryMarking) {
    return function (target: object, propertyKey: MethodKey | undefined, parameterIndex?: number): void {
        if (typeof parameterIndex !== 'number') {
            throw new TypeError(
                '@Telemetry.value()/@Telemetry.redact() must be applied to a parameter. For a return, use ' +
                    '@Telemetry.result().',
            );
        }
        const key: MethodKey = propertyKey ?? CONSTRUCTOR_PARAMETERS;
        recordParameterTelemetry(target, key, parameterIndex, marking);
    };
}

function makeMarking(disclose: TelemetryDisclosure, name?: string): TelemetryMarking {
    // Only include `name` when supplied, so `'name' in marking` is an honest "was an explicit name given?".
    return name !== undefined ? {disclose, name} : {disclose};
}

/**
 * The `@Telemetry` value-disclosure surface. A namespace, not a single decorator, because the three
 * intentions — disclose the value, disclose a surrogate, disclose the return — are distinct and read best
 * as distinct names, exactly as `@Observe`/`@Time`/`@Log` are kept distinct.
 */
export const Telemetry = {
    /**
     * Opt one parameter's value INTO telemetry disclosure on the `record` path. `name` is the DEC-OBS-4
     * explicit-name hatch for minified builds, where the recovered parameter name degrades to a single
     * letter: `@Telemetry.value('accountId')`.
     */
    value(name?: string): ParameterDecorator {
        return recordParameter(makeMarking('value', name)) as ParameterDecorator;
    },

    /**
     * Opt one parameter into a **surrogate** instead of the raw value — a `type` name or a `length`. The
     * strategy names its own behaviour and cannot drift from it (DEC-010 spirit). Unknown or not-yet-shipped
     * strategies are rejected at decoration time rather than silently emitting the wrong thing.
     */
    redact(strategy: RedactStrategy, name?: string): ParameterDecorator {
        assertStrategy(strategy);
        return recordParameter(makeMarking({redact: strategy}, name)) as ParameterDecorator;
    },

    /**
     * Opt the return value INTO telemetry disclosure — the disclosure-side half of Q-23 (a return could not
     * be `@Sensitive`-vetoed on the value path before, and could not opt in either). `name` is accepted for
     * symmetry, though a return has no recovered name to override.
     */
    result(name?: string): MethodDecorator {
        const marking = makeMarking('value', name);
        return function (target: object, propertyKey: MethodKey, descriptor?: PropertyDescriptor): void {
            if (!descriptor || typeof descriptor.value !== 'function') {
                throw new TypeError('@Telemetry.result() must be applied to a method.');
            }
            recordReturnTelemetry(target, propertyKey, marking);
        } as MethodDecorator;
    },
};

function assertStrategy(strategy: string): void {
    if ((SHIPPED_STRATEGIES as readonly string[]).indexOf(strategy) !== -1) return;
    const deferred = DEFERRED_STRATEGIES.indexOf(strategy) !== -1;
    throw new TypeError(
        `@Telemetry.redact: unknown strategy '${String(strategy)}'. Shipped strategies are ` +
            `${SHIPPED_STRATEGIES.join(', ')}.` +
            (deferred
                ? ` '${strategy}' is a planned fast-follow and is not built yet — refused rather than ` +
                  'silently emitting the wrong surrogate.'
                : ''),
    );
}
