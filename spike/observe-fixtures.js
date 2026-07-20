/**
 * SPIKE FIXTURE (third pass) — the 22 SCOPE-IN shapes from `spike/fixtures/blindspots-sink.ts`,
 * reproduced in plain JavaScript so they can be EXECUTED rather than merely parsed.
 *
 * The shapes are transcribed one-for-one. Types erase, so every runtime-relevant construct —
 * the local copy, the destructure, the spread, the template literal, the interface dispatch — is
 * identical to the TypeScript fixture. The 3 SCOPE-OUT cases (bs8_direct, bs16_directSink,
 * bs5_hof) are carried too, so the out-of-scope population can be re-examined at runtime.
 *
 * Ground truth per case: `sink` names the emission that must be redacted; `expect` says whether
 * the sensitive value should appear in the emitter's argument at all.
 */

'use strict';

const {Sensitive, Log, decorateField, decorateMethod} = require('./observe');

const SSN = '123-45-6789';
const DOB = '1981-04-02';

class Subject {
    constructor(ssn, dob, id) {
        this.ssn = ssn === undefined ? SSN : ssn;
        this.dob = dob === undefined ? DOB : dob;
        this.id = id === undefined ? 'cus_0001' : id;
    }
}
decorateField(Subject.prototype, 'ssn', Sensitive());
decorateField(Subject.prototype, 'dob', Sensitive());

class Emitter {
    emit(v) {
        void v;
    }
    emitObj(o) {
        void o;
    }
    emitWrapped(o) {
        void o;
    }
    emitRest(label, ...rest) {
        void label;
        void rest;
    }
}
decorateMethod(Emitter.prototype, 'emit', Log());
decorateMethod(Emitter.prototype, 'emitObj', Log());
decorateMethod(Emitter.prototype, 'emitWrapped', Log());
decorateMethod(Emitter.prototype, 'emitRest', Log());

const SINK = new Emitter();

// --- interface dispatch (bs17). In JS the "interface" is structural; the concrete class is the
// --- @Log-decorated one, which is precisely the point.
class LoggingReporter {
    report(v) {
        void v;
    }
}
decorateMethod(LoggingReporter.prototype, 'report', Log());

class Bs14Carrier {
    constructor() {
        this.payload = '';
    }
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

function bs0_control(s) {
    SINK.emit(s.ssn);
}

function bs1_localVar(s) {
    const copy = s.ssn;
    SINK.emit(copy);
}

function bs2_any(s) {
    SINK.emit(s.ssn);
}

function bs3_dynamic(s, key) {
    SINK.emit(s[key]);
}

function bs4_jsonBoundary(s) {
    const wire = JSON.stringify(s);
    const back = JSON.parse(wire);
    SINK.emit(back.ssn);
}

function bs5_callback(s) {
    [s.ssn].forEach(v => SINK.emit(v));
}

function bs5_hof(s, emit) {
    emit(s.ssn);
}

function bs5_install(s) {
    bs5_hof(s, v => SINK.emit(v));
}

function bs6_destructure(s) {
    const {ssn} = s;
    SINK.emit(ssn);
}

function bs6_paramDestructure({ssn}) {
    SINK.emit(ssn);
}

function bs7_objectSpread(s) {
    SINK.emitObj({...s});
}

function bs7_argSpread(s) {
    const args = [s.ssn];
    SINK.emit(...args);
}

function bs8_template(s) {
    SINK.emit(`user ${s.ssn}`);
}

function bs8_direct(s) {
    // SCOPE-OUT: raw console.log. adorn is not in this call path (DEC-025).
    return `user ${s.ssn}`;
}

function bs9_assign(s) {
    const target = Object.assign({}, s);
    SINK.emit(target.ssn);
}

function bs10_read(s) {
    return s.ssn;
}
function bs10_caller(s) {
    SINK.emit(bs10_read(s));
}

function bs11_transform(s) {
    SINK.emit(s.ssn.slice(-4));
}

function bs12_wrapped(s) {
    SINK.emitWrapped({value: s.ssn});
}

function bs13_rest(s) {
    SINK.emitRest('label', s.ssn);
}

function bs14_fieldWrite(s) {
    const c = new Bs14Carrier();
    c.payload = s.ssn;
    SINK.emit(c.payload);
}

function bs15_cast(s) {
    SINK.emit(s.ssn);
}

function bs16_directSink(s) {
    // SCOPE-OUT
    return s.ssn;
}

function bs17_iface(s, r) {
    r.report(s.ssn);
}

function bs18_indexSig(s) {
    const bag = {};
    bag['ssn'] = s.ssn;
    SINK.emit(bag['ssn']);
}

function bs19_optional(s) {
    SINK.emit((s && s.ssn) ?? '');
}

/**
 * The inventory. `scope` matches blindspots-sink.ts's tags. `staticSeen` records what the §14
 * static analysis found, so the two can be compared directly.
 *
 * `secretShape` says which value must not escape:
 *   'whole'    the full SSN must not appear
 *   'derived'  only a TRANSFORM of the SSN reaches the emitter (bs11 — .slice(-4))
 */
const CASES = [
    {id: 'bs0_control', scope: 'IN', staticSeen: true, secretShape: 'whole', run: s => bs0_control(s)},
    {id: 'bs1_localVar', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs1_localVar(s)},
    {id: 'bs2_any', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs2_any(s)},
    {id: 'bs3_dynamic', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs3_dynamic(s, 'ssn')},
    {id: 'bs4_jsonBoundary', scope: 'IN', staticSeen: true, secretShape: 'whole', run: s => bs4_jsonBoundary(s)},
    {id: 'bs5_callback', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs5_callback(s)},
    {id: 'bs5_install', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs5_install(s)},
    {id: 'bs6_destructure', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs6_destructure(s)},
    {
        id: 'bs6_paramDestructure',
        scope: 'IN',
        staticSeen: false,
        secretShape: 'whole',
        run: s => bs6_paramDestructure(s),
    },
    {id: 'bs7_objectSpread', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs7_objectSpread(s)},
    {id: 'bs7_argSpread', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs7_argSpread(s)},
    {id: 'bs8_template', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs8_template(s)},
    {id: 'bs9_assign', scope: 'IN', staticSeen: true, secretShape: 'whole', run: s => bs9_assign(s)},
    {id: 'bs10_caller', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs10_caller(s)},
    {id: 'bs11_transform', scope: 'IN', staticSeen: false, secretShape: 'derived', run: s => bs11_transform(s)},
    {id: 'bs12_wrapped', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs12_wrapped(s)},
    {id: 'bs13_rest', scope: 'IN', staticSeen: true, secretShape: 'whole', run: s => bs13_rest(s)},
    {id: 'bs14_fieldWrite', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs14_fieldWrite(s)},
    {id: 'bs15_cast', scope: 'IN', staticSeen: true, secretShape: 'whole', run: s => bs15_cast(s)},
    {id: 'bs17_iface', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs17_iface(s, new LoggingReporter())},
    {id: 'bs18_indexSig', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs18_indexSig(s)},
    {id: 'bs19_optional', scope: 'IN', staticSeen: false, secretShape: 'whole', run: s => bs19_optional(s)},

    // SCOPE-OUT, carried for completeness
    {id: 'bs5_hof', scope: 'OUT', staticSeen: true, secretShape: 'whole', run: s => bs5_hof(s, () => {})},
    {id: 'bs8_direct', scope: 'OUT', staticSeen: false, secretShape: 'whole', run: s => bs8_direct(s)},
    {id: 'bs16_directSink', scope: 'OUT', staticSeen: true, secretShape: 'whole', run: s => bs16_directSink(s)},
];

module.exports = {Subject, Emitter, SINK, LoggingReporter, Bs14Carrier, CASES, SSN, DOB};
