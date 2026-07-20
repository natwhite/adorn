/**
 * SPIKE FIXTURE — termination under recursion.
 *
 * Three shapes:
 *   1. direct self-recursion, passing the sensitive parameter to itself
 *   2. mutual recursion, a 2-cycle
 *   3. a 3-cycle, to check the fixpoint is not an artefact of cycle length 2
 *
 * If the "annotations are only ever added" termination argument holds, every one of these
 * reaches a fixpoint. If any of them oscillates or grows without bound, the design is dead.
 */
import {Sensitive} from './marker';

export class Holder {
    @Sensitive() secret: string = '';
}

/* 1. direct self-recursion */
export function countdown(value: string, n: number): string {
    if (n <= 0) {
        return value;
    }
    return countdown(value, n - 1);
}

/* 2. mutual recursion, 2-cycle */
export function ping(payload: string): void {
    pong(payload);
}
export function pong(payload: string): void {
    ping(payload);
}

/* 3. mutual recursion, 3-cycle */
export function alpha(token: string): void {
    beta(token);
}
export function beta(token: string): void {
    gamma(token);
}
export function gamma(token: string): void {
    alpha(token);
}

export class Driver {
    run(h: Holder): void {
        countdown(h.secret, 4);
        ping(h.secret);
        alpha(h.secret);
    }
}
