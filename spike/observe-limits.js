/**
 * SPIKE (third pass) — Question A.7: what runtime observation fundamentally CANNOT see,
 * and the false-confidence surface the brief asks to settle.
 *
 * The mechanism observes READS OF DECORATED FIELDS. That is narrower than "sensitive data".
 * Anything that reaches an emitter without passing through an adorn accessor is invisible, and
 * — the part that matters — invisible SILENTLY, with a clean-looking emission.
 *
 * Run:  node spike/observe-limits.js
 */

'use strict';

const {Sensitive, Log, decorateField, decorateMethod, withScope, emissions, resetEmissions, CENSOR} = require('./observe');

const POLICY = {minLength: 0, primitives: false, match: 'exact', cap: Infinity};

class Sink {
    emit(v) {
        void v;
    }
}
decorateMethod(Sink.prototype, 'emit', Log());
const SINK = new Sink();

const SSN = '123-45-6789';

function probe(name, fn, note) {
    resetEmissions();
    withScope(POLICY, fn);
    const printed = emissions.map(e => e.rendered.join('')).join('|');
    const redacted = printed.indexOf(CENSOR) !== -1;
    return {name, redacted, printed, note};
}

// ---------------------------------------------------------------------------
// A.7 — values that never pass through the accessor
// ---------------------------------------------------------------------------

class Subject {
    constructor(ssn) {
        this.ssn = ssn === undefined ? SSN : ssn;
        this.email = 'a@b.com';
    }
}
decorateField(Subject.prototype, 'ssn', Sensitive());

const limits = [];

// read outside every scope, at "startup" — must be evaluated before the probe that uses it
const preRead = new Subject().ssn;

limits.push(
    probe(
        'decorated field, read normally',
        () => {
            SINK.emit(new Subject().ssn);
        },
        'the control — this is what the design covers',
    ),
);

limits.push(
    probe(
        'plain object from JSON.parse',
        () => {
            const row = JSON.parse('{"ssn":"123-45-6789"}'); // no class, no accessor
            SINK.emit(row.ssn);
        },
        'a wire payload / API response — no prototype, so no accessor exists',
    ),
);

limits.push(
    probe(
        'row from a DB driver',
        () => {
            const row = Object.create(null); // drivers commonly return null-prototype rows
            row.ssn = SSN;
            SINK.emit(row.ssn);
        },
        'the value never belonged to a decorated class',
    ),
);

limits.push(
    probe(
        'value read BEFORE any scope, emitted inside one',
        () => {
            SINK.emit(preRead);
        },
        'module-load / constructor-time read; the scope did not exist yet',
    ),
);

limits.push(
    probe(
        'own data property shadowing the accessor',
        () => {
            const s = new Subject();
            Object.defineProperty(s, 'ssn', {value: SSN, writable: true, enumerable: true, configurable: true});
            SINK.emit(s.ssn); // the accessor was replaced; nothing records
        },
        'defineProperty over the instance slot removes the getter entirely',
    ),
);

limits.push(
    probe(
        'undecorated sibling field on a decorated class',
        () => {
            SINK.emit(new Subject().email); // email is NOT decorated
        },
        'THE FALSE-CONFIDENCE CASE — the class carries @Sensitive, this field does not',
    ),
);

limits.push(
    probe(
        'literal typed at the call site',
        () => {
            SINK.emit('123-45-6789'); // the same secret, never read from a field
        },
        'a hardcoded or externally-sourced copy of the same value',
    ),
);

console.log('');
console.log('=== A.7 — what runtime observation cannot see ===');
console.log('');
for (const l of limits) {
    console.log('  ' + l.name.padEnd(46) + (l.redacted ? 'REDACTED  ' : 'LEAKED    ') + l.printed.slice(0, 20));
    console.log('      ' + l.note);
}
const blind = limits.filter(l => !l.redacted).length;
console.log('');
console.log('  ' + blind + ' of ' + limits.length + ' probes leaked. The covered case is exactly one: a read of a DECORATED field,');
console.log('  through the accessor, inside an open scope.');

// ---------------------------------------------------------------------------
// The false-confidence surface, quantified: partial marking
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.8 — partial marking: the developer marks 1 of 3 sensitive fields ===');
console.log('');

class Patient {
    constructor() {
        this.mrn = 'MRN-99881';
        this.diagnosis = 'hypertension';
        this.insuranceId = 'INS-4410-22';
    }
}
// The developer marks only the one that "looks like" an identifier.
decorateField(Patient.prototype, 'mrn', Sensitive());

resetEmissions();
withScope(POLICY, () => {
    const p = new Patient();
    SINK.emit({mrn: p.mrn, diagnosis: p.diagnosis, insuranceId: p.insuranceId});
});
console.log('  emitted: ' + emissions[0].rendered.join(''));
console.log('');
console.log('  1 of 3 fields redacted. The other two print in the clear.');
console.log('  The emission LOOKS protected — it visibly contains a [REDACTED] token — which is');
console.log('  the strongest possible signal that redaction is working. Nothing in the output');
console.log('  distinguishes "this record is protected" from "one third of this record is protected".');

// ---------------------------------------------------------------------------
// The same partial marking under STATIC analysis, for the comparison the brief asks for
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.9 — can the design tell the developer what it did NOT see? ===');
console.log('');
console.log('  A static pass enumerates declarations: it can print "N fields are @Sensitive, M');
console.log('  fields on contracted classes are not" from a pure registry read, with no flow');
console.log('  analysis. That is a scope disclosure (DEC-026 point 4).');
console.log('');
console.log('  Runtime observation cannot produce the equivalent. To report "a sensitive value');
console.log('  reached an emitter without being observed" it would have to already know the value');
console.log('  was sensitive — which is the thing it learns only by observing the read. The');
console.log('  mechanism is definitionally unable to enumerate its own misses.');

resetEmissions();
withScope(POLICY, () => {
    const p = new Patient();
    SINK.emit(p.diagnosis);
});
console.log('');
console.log('  proof: emitting an unmarked sensitive field prints "' + emissions[0].rendered.join('') + '"');
console.log('  with no warning, no counter, and no difference from emitting a non-sensitive value.');

// ---------------------------------------------------------------------------
// A.10 — the property that is genuinely NEW: the SAME LINE redacts or leaks
//        depending on execution history, not on any declaration.
//
// Partial marking (A.8) is not new — the ratified object-walk design has it too, and its
// coverage is at least an enumerable property of declarations. What runtime observation adds
// is coverage that varies per execution path for identical code. This is class-transformer
// #146's failure shape ("leaked on one route and not another") reproduced from the inside.
// ---------------------------------------------------------------------------

console.log('');
console.log('=== A.10 — the same line of code, two outcomes ===');
console.log('');

const cache = new Map();

/** An utterly ordinary memoised read. The emit line is IDENTICAL on both calls. */
function handleRequest(subject) {
    let ssn = cache.get(subject.id);
    if (ssn === undefined) {
        ssn = subject.ssn; // <- the accessor fires ONLY on a cache miss
        cache.set(subject.id, ssn);
    }
    SINK.emit(ssn); // <- the same line, every time
}

class CachedSubject {
    constructor() {
        this.id = 'cus_0001';
        this.ssn = SSN;
    }
}
decorateField(CachedSubject.prototype, 'ssn', Sensitive());

for (const label of ['request 1 (cache miss)', 'request 2 (cache hit)', 'request 3 (cache hit)']) {
    resetEmissions();
    withScope(POLICY, () => handleRequest(new CachedSubject()));
    const printed = emissions[0].rendered.join('');
    console.log('  ' + label.padEnd(26) + (printed.indexOf(CENSOR) !== -1 ? 'REDACTED' : 'LEAKED  ') + '  ' + printed);
}

console.log('');
console.log('  One `SINK.emit(ssn)`. Redacted on the first request, in the clear on every');
console.log('  subsequent one. No declaration changed, no code changed, nothing was reported.');
console.log('  A test written against request 1 passes and proves nothing about request 2.');
