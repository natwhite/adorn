/**
 * SPIKE FIXTURE — the blind-spot inventory.
 *
 * EVERY function in this file genuinely leaks: a `@Sensitive` value reaches `console.log`
 * on every one of these paths. That is the ground truth. The question the spike answers is
 * which of them a single-hop analyser can SEE, and — the part that matters — whether the
 * ones it cannot see fail loudly or silently.
 *
 * Each case is tagged `BS-n` so the report can refer to it.
 */
import {Sensitive} from './marker';

export class Subject {
    @Sensitive() ssn: string = '';
    @Sensitive() dob: string = '';
    id: string = '';
}

/* ------------------------------------------------------------------ *
 * BS-0  CONTROL — the case the design is built for. Must be detected. *
 * ------------------------------------------------------------------ */
export function bs0_control(s: Subject): void {
    bs0_sink(s.ssn);
}
export function bs0_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------------- *
 * BS-1  local variable assignment (one hop up) *
 * ------------------------------------------- */
export function bs1_localVar(s: Subject): void {
    const copy = s.ssn;
    bs1_sink(copy);
}
export function bs1_sink(v: string): void {
    console.log(v);
}

/* ------------------ *
 * BS-2  `any`-typed  *
 * ------------------ */
export function bs2_any(s: any): void {
    bs2_sink(s.ssn);
}
export function bs2_sink(v: string): void {
    console.log(v);
}

/* ------------------------------ *
 * BS-3  dynamic property access  *
 * ------------------------------ */
export function bs3_dynamic(s: Subject, key: 'ssn' | 'dob'): void {
    bs3_sink(s[key]);
}
export function bs3_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------ *
 * BS-4  JSON.parse / JSON.stringify     *
 * ------------------------------------ */
export function bs4_jsonBoundary(s: Subject): void {
    const wire = JSON.stringify(s);
    const back = JSON.parse(wire) as Subject;
    bs4_sink(back.ssn);
}
export function bs4_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------- *
 * BS-5  callback / higher-order function *
 * ------------------------------------- */
export function bs5_callback(s: Subject): void {
    [s.ssn].forEach((v) => console.log(v));
}
export function bs5_hof(s: Subject, emit: (v: string) => void): void {
    emit(s.ssn);
}
export function bs5_install(s: Subject): void {
    bs5_hof(s, (v) => console.log(v));
}

/* --------------------- *
 * BS-6  destructuring   *
 * --------------------- */
export function bs6_destructure(s: Subject): void {
    const {ssn} = s;
    bs6_sink(ssn);
}
export function bs6_paramDestructure({ssn}: Subject): void {
    bs6_sink(ssn);
}
export function bs6_sink(v: string): void {
    console.log(v);
}

/* -------------- *
 * BS-7  spread   *
 * -------------- */
export function bs7_objectSpread(s: Subject): void {
    bs7_sinkObj({...s});
}
export function bs7_argSpread(s: Subject): void {
    const args: [string] = [s.ssn];
    bs7_sink(...args);
}
export function bs7_sink(v: string): void {
    console.log(v);
}
export function bs7_sinkObj(o: {ssn: string}): void {
    console.log(o.ssn);
}

/* ------------------------------- *
 * BS-8  template-literal interp.  *
 * ------------------------------- */
export function bs8_template(s: Subject): void {
    bs8_sink(`user ${s.ssn}`);
}
export function bs8_direct(s: Subject): void {
    console.log(`user ${s.ssn}`);
}
export function bs8_sink(v: string): void {
    console.log(v);
}

/* ------------------- *
 * BS-9  Object.assign *
 * ------------------- */
export function bs9_assign(s: Subject): void {
    const target = Object.assign({}, s);
    bs9_sink(target.ssn);
}
export function bs9_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------------ *
 * BS-10  return value carries the sensitivity *
 * ------------------------------------------ */
export function bs10_read(s: Subject): string {
    return s.ssn;
}
export function bs10_caller(s: Subject): void {
    bs10_sink(bs10_read(s));
}
export function bs10_sink(v: string): void {
    console.log(v);
}

/* ---------------------------------------- *
 * BS-11  transformation (slice, toUpper...) *
 * ---------------------------------------- */
export function bs11_transform(s: Subject): void {
    bs11_sink(s.ssn.slice(-4));
}
export function bs11_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------ *
 * BS-12  array / object literal wrapper *
 * ------------------------------------ */
export function bs12_wrapped(s: Subject): void {
    bs12_sink({value: s.ssn});
}
export function bs12_sink(o: {value: string}): void {
    console.log(o.value);
}

/* -------------------------- *
 * BS-13  rest parameter       *
 * -------------------------- */
export function bs13_rest(s: Subject): void {
    bs13_sink('label', s.ssn);
}
export function bs13_sink(label: string, ...rest: string[]): void {
    console.log(label, rest);
}

/* --------------------------------- *
 * BS-14  assignment to a class field *
 * --------------------------------- */
export class Bs14Carrier {
    payload: string = '';
}
export function bs14_fieldWrite(s: Subject): void {
    const c = new Bs14Carrier();
    c.payload = s.ssn;
    bs14_sink(c.payload);
}
export function bs14_sink(v: string): void {
    console.log(v);
}

/* ---------------------------- *
 * BS-15  `as` cast / `unknown`  *
 * ---------------------------- */
export function bs15_cast(s: Subject): void {
    bs15_sink(s.ssn as unknown as string);
}
export function bs15_sink(v: string): void {
    console.log(v);
}

/* ---------------------------------------------- *
 * BS-16  direct sink call — nothing to annotate    *
 * ---------------------------------------------- */
export function bs16_directSink(s: Subject): void {
    console.log(s.ssn);
}

/* ---------------------------------------------- *
 * BS-17  method dispatched through an interface    *
 * ---------------------------------------------- */
export interface Reporter {
    report(v: string): void;
}
export class ConsoleReporter implements Reporter {
    report(v: string): void {
        console.log(v);
    }
}
export function bs17_iface(s: Subject, r: Reporter): void {
    r.report(s.ssn);
}

/* ------------------------------------- *
 * BS-18  index signature / bracket write  *
 * ------------------------------------- */
export function bs18_indexSig(s: Subject): void {
    const bag: Record<string, string> = {};
    bag['ssn'] = s.ssn;
    bs18_sink(bag['ssn']);
}
export function bs18_sink(v: string): void {
    console.log(v);
}

/* ------------------------------------------ *
 * BS-19  optional chaining / nullish coalesce  *
 * ------------------------------------------ */
export function bs19_optional(s?: Subject): void {
    bs19_sink(s?.ssn ?? '');
}
export function bs19_sink(v: string): void {
    console.log(v);
}
