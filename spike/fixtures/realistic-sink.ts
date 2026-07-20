/**
 * SPIKE FIXTURE (re-evaluation) — realistic.ts re-pointed at adorn's OWN sinks.
 *
 * Same payments service, same flows. Ground truth is re-tagged for the narrowed threat model,
 * and the tag set gains a third member that did not exist before:
 *
 *   ADORN-SINK    this parameter IS an adorn emission position — a parameter of an `@Log`
 *                 method, or one carrying `@Enforce.*` whose violation message renders it.
 *                 An annotation here is LOAD-BEARING: it is what the emitter reads to redact.
 *   REACHES       the value reaches an adorn emission position further down, but this parameter
 *                 is not itself one. An annotation here is bookkeeping.
 *   INERT         the value reaches no adorn emitter on any path.
 *   ESCAPES       the value reaches raw `console.log` — a real leak that the NARROWED model
 *                 declares out of scope. This tag exists to make question 5 measurable: it is
 *                 the exact population a developer could wrongly believe adorn covers.
 */
import {Sensitive} from './marker';
import {Log, Enforce} from './adorn-markers';

export class PaymentInstrument {
    @Sensitive() pan: string = '';
    @Sensitive() holderEmail: string = '';
    last4: string = '';
    network: string = '';
}

export class Gateway {
    charge(instrument: PaymentInstrument, amount: number): boolean {
        const token = tokenize(instrument.pan);
        assessRisk(instrument.pan, amount);
        luhn(instrument.pan);
        queueReceipt(instrument.holderEmail, amount);
        AUDIT.record(instrument.pan, 'charge');
        debugDump(instrument.pan);
        dumpEmail(instrument.holderEmail);
        return submit(token, amount);
    }
}

/** adorn's emitters for this fixture. */
export class ReviewLog {
    /* ADORN-SINK detail */
    @Log()
    write(detail: string, score: number): void {
        void detail;
        void score;
    }
}

export class AuditTrail {
    /* ADORN-SINK subject */
    @Log()
    record(subject: string, kind: string): void {
        void subject;
        void kind;
    }

    /* ADORN-SINK pan — the violation-message path, not the @Log path */
    checkPan(@Enforce.minLength(12) pan: string): void {
        void pan;
    }
}

export const REVIEW = new ReviewLog();
export const AUDIT = new AuditTrail();

/* INERT — hashes and returns; nothing downstream emits */
export function tokenize(rawPan: string): string {
    return simpleHash(rawPan);
}

/* INERT — arithmetic only */
export function simpleHash(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
        h = (h * 31 + input.charCodeAt(i)) | 0;
    }
    return String(h);
}

/* REACHES — forwards to an adorn emitter two hops down */
export function assessRisk(pan: string, amount: number): number {
    const score = amount > 1000 ? 90 : 10;
    if (score > 50) {
        recordReview(pan, score);
    }
    return score;
}

/* REACHES — one hop from the emitter */
export function recordReview(subject: string, score: number): void {
    REVIEW.write(subject, score);
}

/* INERT — pure numeric validation, no forwarding */
export function luhn(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        sum += digits.charCodeAt(i) - 48;
    }
    return sum % 10 === 0;
}

/* INERT — hands off to a template renderer that never reaches an emitter */
export function queueReceipt(address: string, amount: number): void {
    enqueue(renderReceipt(address, amount));
}

/* INERT */
export function renderReceipt(to: string, amount: number): string {
    return `To: ${to}\nAmount: ${amount}`;
}

/* INERT — the parameter here is the rendered body, not the address */
export function enqueue(body: string): void {
    OUTBOX.push(body);
}

export const OUTBOX: string[] = [];

/* INERT — token, not the PAN */
export function submit(token: string, amount: number): boolean {
    return token.length > 0 && amount > 0;
}

// A genuine leak that the NARROWED model declares out of scope. The developer wrote this
// `console.log` themselves; adorn was never in the call path and no annotation anywhere would
// redact it. This is question 5's false-confidence population, made countable.
/* ESCAPES debugDump */
export function debugDump(pan: string): void {
    console.log(`[debug] pan=${pan}`);
}

/* ESCAPES dumpEmail — the same shape via a template literal, the commonest leak in JavaScript */
export function dumpEmail(address: string): void {
    console.log(`[debug] email=${address}`);
}
