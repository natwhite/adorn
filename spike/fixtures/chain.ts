/**
 * SPIKE FIXTURE — the convergence fixture.
 *
 * A 5-hop chain from a `@Sensitive` field to two different sinks, with a branch at hop 3
 * and a merge at hop 4. Shapes deliberately present:
 *
 *   hop 1  customer.ssn        -> validate(taxId)
 *   hop 2  validate            -> route(candidate)
 *   hop 3  route               -> reject(bad) | accept(good)      BRANCH (two receivers)
 *   hop 4  reject, accept      -> audit(subject)                  MERGE (two callers, one receiver)
 *   hop 5  audit               -> writeAuditLog(entry)            SINK 1
 *          audit              -> emitMetric(label)                SINK 2
 *
 * Nothing here is annotated past the field. Every parameter below is a hop the iterative
 * design has to discover on a later round.
 */
import {Sensitive} from './marker';

export class Customer {
    @Sensitive() ssn: string = '';
    @Sensitive() email: string = '';
    id: string = '';
}

export class Enrollment {
    start(customer: Customer): boolean {
        return validate(customer.ssn);
    }
}

export function validate(taxId: string): boolean {
    return route(taxId);
}

export function route(candidate: string): boolean {
    if (candidate.length !== 11) {
        return reject(candidate);
    }
    return accept(candidate);
}

export function reject(bad: string): boolean {
    audit(bad, 'rejected');
    return false;
}

export function accept(good: string): boolean {
    audit(good, 'accepted');
    return true;
}

export function audit(subject: string, outcome: string): void {
    writeAuditLog(subject, outcome);
    emitMetric(subject);
}

export function writeAuditLog(entry: string, outcome: string): void {
    console.log(`audit: ${entry} ${outcome}`);
}

export function emitMetric(label: string): void {
    console.log({label});
}
