/**
 * SPIKE ONLY — throwaway stand-ins for adorn's *own emitters*. NOT the real decorators.
 *
 * The re-evaluation (docs/sensitive-flow-spike.md §14) narrows the threat model: adorn is
 * responsible for its own emissions, not for a developer's raw `console.log`. That makes the
 * sink set closed and enumerable, and these are the members of it, mirroring the real shapes:
 *
 *   @Log()            src/MethodDecorators/Log.ts     — emits EVERY argument + the return value
 *   @Enforce.min(...) src/Core/Descriptor.ts          — emits the received value in a violation
 *   @Telemetry.value() docs/observability-plan.md     — proposed, not implemented
 *   @Time()           src/MethodDecorators/Time.ts    — label + duration ONLY, no argument values
 *
 * All inert. The spike is about what a static analyser can see, so runtime behaviour is
 * irrelevant and is deliberately empty.
 */

/** Stand-in for `@Log()`. A MethodDecorator — legal ONLY on a concrete class method. */
export function Log(): MethodDecorator {
    return function (..._args: any[]): void {
        /* intentionally inert */
    };
}

/** Stand-in for `@Time()`. Emits no argument values — present to prove it is NOT a value sink. */
export function Time(): MethodDecorator {
    return function (..._args: any[]): void {
        /* intentionally inert */
    };
}

/** Stand-in for `@Enforce.*` parameter constraints, whose violation message embeds the value. */
export const Enforce = {
    min(_n: number): ParameterDecorator {
        return function (..._args: any[]): void {
            /* intentionally inert */
        };
    },
    minLength(_n: number): ParameterDecorator {
        return function (..._args: any[]): void {
            /* intentionally inert */
        };
    },
};

/** Stand-in for the proposed `@Telemetry.value()` opt-in. */
export const Telemetry = {
    value(): ParameterDecorator {
        return function (..._args: any[]): void {
            /* intentionally inert */
        };
    },
};
