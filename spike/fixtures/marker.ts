/**
 * SPIKE ONLY — throwaway marker. NOT the real `@Sensitive`.
 *
 * A single function usable as a property decorator, a parameter decorator and a class
 * decorator under `experimentalDecorators`. It records nothing and does nothing: the spike
 * is about what a *static* analyser can see, so the runtime behaviour is irrelevant and is
 * deliberately empty so nothing here can be mistaken for an implementation.
 */
export function Sensitive(): any {
    return function (..._args: any[]): void {
        /* intentionally inert */
    };
}
