/**
 * SPIKE FIXTURE — realistic application code, for the false-positive / annotation-spam count.
 *
 * A payments-shaped service. A `@Sensitive` PAN and a `@Sensitive` email flow through a lot
 * of parameters. Ground truth is tagged on every receiving parameter:
 *
 *   REACHES-SINK  the value this parameter receives does eventually reach console/log output
 *   INERT         it does not, on any path, ever
 *
 * "Annotation spam" is the count of INERT parameters the iterative design would annotate.
 */
import {Sensitive} from './marker';

export class PaymentInstrument {
    @Sensitive() pan: string = '';
    @Sensitive() holderEmail: string = '';
    last4: string = '';
    network: string = '';
}

export class Gateway {
    charge(instrument: PaymentInstrument, amount: number): boolean {
        // hop into the tokenizer — INERT branch
        const token = tokenize(instrument.pan);
        // hop into the risk engine — REACHES-SINK branch
        assessRisk(instrument.pan, amount);
        // hop into a pure validator — INERT branch
        luhn(instrument.pan);
        // hop into a notifier — INERT branch (email is templated, never printed)
        queueReceipt(instrument.holderEmail, amount);
        return submit(token, amount);
    }
}

/* INERT — hashes and returns; nothing downstream prints */
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

/* REACHES-SINK — forwards to a logger two hops down */
export function assessRisk(pan: string, amount: number): number {
    const score = amount > 1000 ? 90 : 10;
    if (score > 50) {
        recordReview(pan, score);
    }
    return score;
}

/* REACHES-SINK */
export function recordReview(subject: string, score: number): void {
    writeReviewLog(subject, score);
}

/* REACHES-SINK — the actual sink */
export function writeReviewLog(detail: string, score: number): void {
    console.warn(`review ${detail} score=${score}`);
}

/* INERT — pure numeric validation, no forwarding */
export function luhn(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        sum += digits.charCodeAt(i) - 48;
    }
    return sum % 10 === 0;
}

/* INERT — hands off to a template renderer that never prints */
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
