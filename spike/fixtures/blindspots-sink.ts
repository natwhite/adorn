/**
 * SPIKE FIXTURE (re-evaluation) — the blind-spot inventory RE-PARTITIONED.
 *
 * `blindspots.ts` measured 25 genuinely-leaking cases against a broad threat model in which any
 * `console.log` was a sink. The narrowed model makes adorn responsible only for its OWN
 * emissions, so each case has to be re-asked: does the value arrive at an argument position of
 * an adorn emitter, or does it exit the framework?
 *
 * Each case below is tagged in a machine-readable comment on the line above the function:
 *
 *   SCOPE-IN    the value reaches a parameter of an `@Log`-decorated method. adorn IS in this
 *               call path, so a miss here is a GENUINE MISS and counts against the design.
 *   SCOPE-OUT   the value reaches raw `console.log`, or a receiver that could never BE an adorn
 *               emitter (a function-typed parameter — a function type node cannot host `@Log`,
 *               measured in spike/sink-legality.js). adorn was never in this call path.
 *
 * The shapes are unchanged from `blindspots.ts`. Only the terminal receiver moves, and it moves
 * ONLY where the shape realistically permits — the point of the exercise is to avoid waving a
 * whole category away, so template interpolation appears BOTH as SCOPE-OUT (into `console.log`)
 * and as SCOPE-IN (into an `@Log` method's argument).
 */
import {Sensitive} from './marker';
import {Log} from './adorn-markers';

export class Subject {
    @Sensitive() ssn: string = '';
    @Sensitive() dob: string = '';
    id: string = '';
}

/** The one and only adorn emitter in this file. Every SCOPE-IN case terminates here. */
export class Emitter {
    @Log()
    emit(v: string): void {
        void v;
    }

    @Log()
    emitObj(o: {ssn: string}): void {
        void o;
    }

    @Log()
    emitWrapped(o: {value: string}): void {
        void o;
    }

    @Log()
    emitRest(label: string, ...rest: string[]): void {
        void label;
        void rest;
    }
}

export const SINK = new Emitter();

/* SCOPE-IN  bs0_control — marked field passed directly into an @Log parameter */
export function bs0_control(s: Subject): void {
    SINK.emit(s.ssn);
}

/* SCOPE-IN  bs1_localVar — one line of severing between the field and the @Log parameter */
export function bs1_localVar(s: Subject): void {
    const copy = s.ssn;
    SINK.emit(copy);
}

/* SCOPE-IN  bs2_any — holder typed `any`, still handed to an @Log parameter */
export function bs2_any(s: any): void {
    SINK.emit(s.ssn);
}

/* SCOPE-IN  bs3_dynamic — dynamic property access into an @Log parameter */
export function bs3_dynamic(s: Subject, key: 'ssn' | 'dob'): void {
    SINK.emit(s[key]);
}

/* SCOPE-IN  bs4_jsonBoundary — JSON round trip with a cast, into an @Log parameter */
export function bs4_jsonBoundary(s: Subject): void {
    const wire = JSON.stringify(s);
    const back = JSON.parse(wire) as Subject;
    SINK.emit(back.ssn);
}

/* SCOPE-IN  bs5_callback — through a .forEach callback, terminating at an @Log parameter */
export function bs5_callback(s: Subject): void {
    [s.ssn].forEach(v => SINK.emit(v));
}

/* SCOPE-OUT bs5_hof — receiver is a function-typed parameter, which can NEVER host @Log */
export function bs5_hof(s: Subject, emit: (v: string) => void): void {
    emit(s.ssn);
}

/* SCOPE-IN  bs5_install — the installed callback is the thing that reaches the @Log parameter */
export function bs5_install(s: Subject): void {
    bs5_hof(s, v => SINK.emit(v));
}

/* SCOPE-IN  bs6_destructure — destructured in the body, into an @Log parameter */
export function bs6_destructure(s: Subject): void {
    const {ssn} = s;
    SINK.emit(ssn);
}

/* SCOPE-IN  bs6_paramDestructure — destructured in the parameter list */
export function bs6_paramDestructure({ssn}: Subject): void {
    SINK.emit(ssn);
}

/* SCOPE-IN  bs7_objectSpread — the whole marked object spread into an @Log parameter */
export function bs7_objectSpread(s: Subject): void {
    SINK.emitObj({...s});
}

/* SCOPE-IN  bs7_argSpread — argument spread into an @Log parameter */
export function bs7_argSpread(s: Subject): void {
    const args: [string] = [s.ssn];
    SINK.emit(...args);
}

/* SCOPE-IN  bs8_template — template interpolation into an @Log ARGUMENT. Still adorn's problem. */
export function bs8_template(s: Subject): void {
    SINK.emit(`user ${s.ssn}`);
}

/* SCOPE-OUT bs8_direct — template interpolation into raw console.log. adorn is not in this path. */
export function bs8_direct(s: Subject): void {
    console.log(`user ${s.ssn}`);
}

/* SCOPE-IN  bs9_assign — Object.assign copy into an @Log parameter */
export function bs9_assign(s: Subject): void {
    const target = Object.assign({}, s);
    SINK.emit(target.ssn);
}

/* SCOPE-IN  bs10_caller — value returned from a function, into an @Log parameter */
export function bs10_read(s: Subject): string {
    return s.ssn;
}
export function bs10_caller(s: Subject): void {
    SINK.emit(bs10_read(s));
}

/* SCOPE-IN  bs11_transform — .slice(-4), the PCI-relevant fragment, into an @Log parameter */
export function bs11_transform(s: Subject): void {
    SINK.emit(s.ssn.slice(-4));
}

/* SCOPE-IN  bs12_wrapped — wrapped in an object literal, into an @Log parameter */
export function bs12_wrapped(s: Subject): void {
    SINK.emitWrapped({value: s.ssn});
}

/* SCOPE-IN  bs13_rest — into the rest parameter of an @Log method */
export function bs13_rest(s: Subject): void {
    SINK.emitRest('label', s.ssn);
}

/* SCOPE-IN  bs14_fieldWrite — laundered through an unmarked class field */
export class Bs14Carrier {
    payload: string = '';
}
export function bs14_fieldWrite(s: Subject): void {
    const c = new Bs14Carrier();
    c.payload = s.ssn;
    SINK.emit(c.payload);
}

/* SCOPE-IN  bs15_cast — `as unknown as` cast into an @Log parameter */
export function bs15_cast(s: Subject): void {
    SINK.emit(s.ssn as unknown as string);
}

/* SCOPE-OUT bs16_directSink — straight into raw console.log. Nothing of adorn's is involved. */
export function bs16_directSink(s: Subject): void {
    console.log(s.ssn);
}

/* SCOPE-IN  bs17_iface — dispatched through an interface whose implementation is @Log-decorated */
export interface Reporter {
    report(v: string): void;
}
export class LoggingReporter implements Reporter {
    @Log()
    report(v: string): void {
        void v;
    }
}
export function bs17_iface(s: Subject, r: Reporter): void {
    r.report(s.ssn);
}

/* SCOPE-IN  bs18_indexSig — laundered through an index-signature bag */
export function bs18_indexSig(s: Subject): void {
    const bag: Record<string, string> = {};
    bag['ssn'] = s.ssn;
    SINK.emit(bag['ssn']);
}

/* SCOPE-IN  bs19_optional — optional chaining + ?? into an @Log parameter */
export function bs19_optional(s?: Subject): void {
    SINK.emit(s?.ssn ?? '');
}
