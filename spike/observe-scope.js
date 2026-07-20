/**
 * SPIKE (third pass) — Question A.3: scope propagation.
 *
 * The observed set has to live somewhere that survives the gap between the READ (in the caller)
 * and the EMIT (in the adorn-decorated method). `AsyncLocalStorage` is the obvious vehicle.
 * This measures where the scope survives, where it is lost, and — the case that decides whether
 * the design is safe rather than merely useful — where it LEAKS ACROSS requests.
 *
 * Run:  node spike/observe-scope.js
 */

'use strict';

const {EventEmitter} = require('node:events');
const {Sensitive, Log, decorateField, decorateMethod, withScope, emissions, resetEmissions, CENSOR} = require('./observe');

class Subject {
    constructor(ssn) {
        this.ssn = ssn || '123-45-6789';
    }
}
decorateField(Subject.prototype, 'ssn', Sensitive());

class Sink {
    emit(v) {
        void v;
    }
}
decorateMethod(Sink.prototype, 'emit', Log());
const SINK = new Sink();

const POLICY = {minLength: 0, primitives: false, match: 'exact', cap: Infinity};

const results = [];

function check(name, note) {
    const printed = emissions.map(e => e.rendered.join('')).join('|');
    const scoped = emissions.length > 0 ? emissions[emissions.length - 1].scoped : false;
    const redacted = printed.indexOf(CENSOR) !== -1;
    results.push({name, redacted, scoped, printed, note});
}

async function main() {
    // ---- 1. plain synchronous ------------------------------------------------
    resetEmissions();
    withScope(POLICY, () => {
        const s = new Subject();
        const copy = s.ssn;
        SINK.emit(copy);
    });
    check('sync', 'read and emit in the same frame');

    // ---- 2. await ------------------------------------------------------------
    resetEmissions();
    await withScope(POLICY, async () => {
        const s = new Subject();
        const copy = s.ssn;
        await new Promise(r => setTimeout(r, 1));
        SINK.emit(copy);
    });
    check('await + setTimeout', 'read before await, emit after');

    // ---- 3. Promise.all ------------------------------------------------------
    resetEmissions();
    await withScope(POLICY, async () => {
        const s = new Subject();
        const copy = s.ssn;
        await Promise.all([Promise.resolve().then(() => SINK.emit(copy)), Promise.resolve()]);
    });
    check('Promise.all', 'emit inside a concurrent branch');

    // ---- 4. setTimeout callback ---------------------------------------------
    resetEmissions();
    await new Promise(done => {
        withScope(POLICY, () => {
            const s = new Subject();
            const copy = s.ssn;
            setTimeout(() => {
                SINK.emit(copy);
                done();
            }, 1);
        });
    });
    check('setTimeout callback', 'scope exited before the callback ran');

    // ---- 5. process.nextTick / queueMicrotask -------------------------------
    resetEmissions();
    await new Promise(done => {
        withScope(POLICY, () => {
            const s = new Subject();
            const copy = s.ssn;
            process.nextTick(() => {
                SINK.emit(copy);
                done();
            });
        });
    });
    check('process.nextTick', '');

    // ---- 6. EventEmitter, emitted INSIDE the scope --------------------------
    resetEmissions();
    {
        const bus = new EventEmitter();
        bus.on('x', v => SINK.emit(v));
        withScope(POLICY, () => {
            const s = new Subject();
            bus.emit('x', s.ssn);
        });
    }
    check('EventEmitter, same tick', 'listener registered outside, emit() called inside');

    // ---- 7. EventEmitter, emitted OUTSIDE the scope -------------------------
    resetEmissions();
    {
        const bus = new EventEmitter();
        bus.on('x', v => SINK.emit(v));
        let captured;
        withScope(POLICY, () => {
            const s = new Subject();
            captured = s.ssn;
        });
        bus.emit('x', captured); // the scope has closed
    }
    check('EventEmitter, deferred', 'value read in scope, emitted after the scope closed');

    // ---- 8. a value cached and re-emitted in a LATER request ----------------
    resetEmissions();
    {
        let cache;
        await withScope(POLICY, async () => {
            const s = new Subject();
            cache = s.ssn; // request A reads it and caches it
        });
        await withScope(POLICY, async () => {
            SINK.emit(cache); // request B emits it, having never read the field
        });
    }
    check('cross-request cache', 'request A reads, request B emits — B never read the field');

    // ---- 9. concurrent requests: does A's secret leak into B's scope? -------
    resetEmissions();
    {
        const A = new Subject('AAA-AA-AAAA');
        const B = new Subject('BBB-BB-BBBB');
        await Promise.all([
            withScope(POLICY, async () => {
                void A.ssn;
                await new Promise(r => setTimeout(r, 2));
            }),
            withScope(POLICY, async () => {
                void B.ssn;
                await new Promise(r => setTimeout(r, 1));
                SINK.emit('AAA-AA-AAAA'); // B emits A's secret
            }),
        ]);
    }
    check('concurrent isolation', "request B emits request A's secret; ALS keeps the scopes separate");

    // ---- 10. no scope at all -------------------------------------------------
    resetEmissions();
    {
        const s = new Subject();
        const copy = s.ssn;
        SINK.emit(copy);
    }
    check('NO SCOPE OPENED', 'nothing called withScope — the ordinary case for a library');

    // ---- 11. read at module/startup time, emitted inside a scope ------------
    resetEmissions();
    {
        const s = new Subject();
        const atStartup = s.ssn; // read before any request exists
        withScope(POLICY, () => {
            SINK.emit(atStartup);
        });
    }
    check('read at startup', 'field read outside any scope, emitted inside one');

    // ---- report --------------------------------------------------------------
    console.log('');
    console.log('=== A.3 — AsyncLocalStorage scope propagation ===');
    console.log('');
    console.log('  case                        redacted?  in-scope?  emitted');
    console.log('  ' + '-'.repeat(78));
    for (const r of results) {
        console.log(
            '  ' +
                r.name.padEnd(27) +
                (r.redacted ? 'YES      ' : 'NO       ') +
                (r.scoped ? 'yes       ' : 'NO        ') +
                r.printed.slice(0, 24),
        );
        if (r.note) console.log('      ' + r.note);
    }

    const survived = results.filter(r => r.redacted).length;
    console.log('');
    console.log('  scope survived in ' + survived + ' of ' + results.length + ' propagation cases');
    console.log('  LOST in: ' + results.filter(r => !r.redacted).map(r => r.name).join(', '));

    // -----------------------------------------------------------------------
    // A.3b — WHO OPENS THE SCOPE?
    //
    // The cases above assume something called withScope(). adorn is a decorator library: it does
    // not own the request lifecycle and cannot assume a consumer installed middleware. The only
    // scope adorn can open by itself is one per DECORATED METHOD CALL. That is measured here,
    // because it determines the real coverage boundary.
    // -----------------------------------------------------------------------

    console.log('');
    console.log('=== A.3b — the only scope adorn can open for itself ===');
    console.log('');

    /** A method decorator that opens a scope for the duration of the call — adorn-hostable. */
    function Scoped() {
        return function (target, key, descriptor) {
            const original = descriptor.value;
            descriptor.value = function scopedCall(...args) {
                return withScope(POLICY, () => original.apply(this, args));
            };
            return descriptor;
        };
    }

    // (i) the read happens INSIDE an adorn-decorated frame
    class HandlerInside {
        process(s) {
            const copy = s.ssn; // read inside the scope this method opened
            SINK.emit(copy);
        }
    }
    decorateMethod(HandlerInside.prototype, 'process', Scoped());

    resetEmissions();
    new HandlerInside().process(new Subject());
    const insideOk = emissions.map(e => e.rendered.join('')).join('').indexOf(CENSOR) !== -1;
    console.log('  read inside a decorated frame     redacted=' + (insideOk ? 'YES' : 'NO'));

    // (ii) the read happens in the CALLER, before the decorated method is entered
    class HandlerOutside {
        process(copy) {
            SINK.emit(copy);
        }
    }
    decorateMethod(HandlerOutside.prototype, 'process', Scoped());

    resetEmissions();
    {
        const s = new Subject();
        const copy = s.ssn; // read BEFORE the decorated method opens its scope
        new HandlerOutside().process(copy);
    }
    const outsideOk = emissions.map(e => e.rendered.join('')).join('').indexOf(CENSOR) !== -1;
    console.log('  read in the caller, then passed   redacted=' + (outsideOk ? 'YES' : 'NO'));

    // (iii) an ordinary free function — no adorn frame anywhere
    resetEmissions();
    (function plainFreeFunction() {
        const s = new Subject();
        SINK.emit(s.ssn);
    })();
    const freeOk = emissions.map(e => e.rendered.join('')).join('').indexOf(CENSOR) !== -1;
    console.log('  free function, no adorn frame     redacted=' + (freeOk ? 'YES' : 'NO'));

    console.log('');
    console.log('  => coverage is exactly "reads that occur inside an adorn-decorated call frame".');
    console.log('     A read in the caller of a decorated method is NOT covered, and that is the');
    console.log('     ordinary shape: a handler reads the field, then calls the logging service.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
