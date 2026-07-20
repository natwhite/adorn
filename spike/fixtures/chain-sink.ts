/**
 * SPIKE FIXTURE (re-evaluation) — chain.ts re-pointed at adorn's OWN sinks.
 *
 * Structurally identical to `chain.ts`: same 5 hops, same branch at 3, same merge at 4, same two
 * terminal sinks. ONE thing changes — the two terminal functions are no longer free functions
 * that happen to call `console.log`. They are methods of a class, decorated with `@Log()`, which
 * under the narrowed threat model is an *adorn emission*: `src/MethodDecorators/Log.ts` renders
 * every argument with `safeStringify` and writes it to `console.log`.
 *
 *   hop 1  customer.ssn        -> validate(taxId)
 *   hop 2  validate            -> route(candidate)
 *   hop 3  route               -> reject(bad) | accept(good)          BRANCH
 *   hop 4  reject, accept      -> audit(subject)                      MERGE
 *   hop 5  audit               -> AuditService.writeAuditLog(entry)   ADORN SINK 1  (@Log)
 *          audit              -> Metrics.emitMetric(label)            ADORN SINK 2  (@Log)
 *
 * `Metrics.emitTiming` is decorated with `@Time()`, which emits a label and a duration and NO
 * argument values — it is present to prove the sink set is narrower than "any adorn decorator".
 */
import {Sensitive} from './marker';
import {Log, Time} from './adorn-markers';

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
    AUDIT.writeAuditLog(subject, outcome);
    METRICS.emitMetric(subject);
}

export class AuditService {
    /** ADORN SINK — `@Log` renders every argument into the log line. */
    @Log()
    writeAuditLog(entry: string, outcome: string): void {
        void entry;
        void outcome;
    }
}

export class Metrics {
    /** ADORN SINK — same. */
    @Log()
    emitMetric(label: string): void {
        void label;
    }

    /** NOT a sink — `@Time` emits a label and a duration, never an argument value. */
    @Time()
    emitTiming(label: string): void {
        void label;
    }
}

export const AUDIT = new AuditService();
export const METRICS = new Metrics();

/**
 * The DIRECT case — a marked field passed straight into an adorn sink, no intermediate hops.
 * This is the shape question 2 asks about: is it reachable without any propagation at all?
 */
export function directToSink(customer: Customer): void {
    AUDIT.writeAuditLog(customer.ssn, 'direct');
}

/** A `@Time`-decorated receiver of a marked field. Must NOT be reported — it emits no values. */
export function directToNonSink(customer: Customer): void {
    METRICS.emitTiming(customer.ssn);
}
