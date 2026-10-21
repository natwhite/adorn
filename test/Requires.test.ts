/**
 * `@Requires` — cross-parameter preconditions (IDEA-26 / DEC-057), the input-side twin of `@Ensures`.
 *
 * These pin the four things that matter: it enforces a relation across parameters BEFORE the call
 * (caller-blamed); a `@Requires`-only method (no per-position constraints) still installs and enforces;
 * the exported `evaluatePreconditions` oracle agrees byte-for-byte with what enforcement rejects (the
 * no-drift guarantee a fuzzer relies on); and it is UNPROJECTABLE — a `@Requires`-only method emits an
 * empty tool schema, exactly as `@Ensures` emits nothing.
 */

import {Requires, GreaterThanEqual, Contract} from '../index';
import {toolSchemaForMethod} from '../schema';
import {evaluatePreconditions, getEffectivePreconditions} from '../introspection';

describe('@Requires — cross-parameter enforcement (DEC-057)', () => {
    @Contract()
    class Booking {
        @Requires((start: number, end: number) => start < end, 'start is before end')
        reserve(start: number, end: number): [number, number] {
            return [start, end];
        }
    }

    it('runs the method when the precondition holds', () => {
        expect(new Booking().reserve(1, 5)).toEqual([1, 5]);
    });

    it('throws before the method runs when the precondition fails, naming the description', () => {
        expect(() => new Booking().reserve(5, 1)).toThrow('start is before end');
    });

    it('a @Requires-only method (no per-position constraints) still installs and enforces', () => {
        @Contract()
        class Range {
            @Requires((lo: number, hi: number) => lo <= hi, 'lo <= hi')
            make(lo: number, hi: number) {
                return {lo, hi};
            }
        }
        expect(new Range().make(1, 5)).toEqual({lo: 1, hi: 5});
        expect(() => new Range().make(5, 1)).toThrow('lo <= hi');
    });

    it('runs cross-parameter AFTER per-position constraints (a bad parameter is reported first)', () => {
        @Contract()
        class Span {
            @Requires((lo: number, hi: number) => lo < hi, 'lo < hi')
            of(@GreaterThanEqual(0) lo: number, hi: number) {
                return [lo, hi];
            }
        }
        // The per-position @GreaterThanEqual(0) fails first for a negative lo...
        expect(() => new Span().of(-1, 10)).toThrow();
        // ...and the cross-parameter @Requires fails when the positions are individually fine.
        expect(() => new Span().of(5, 2)).toThrow('lo < hi');
        expect(new Span().of(1, 2)).toEqual([1, 2]);
    });

    it('a predicate that THROWS is a precondition failure, not a method crash', () => {
        @Contract()
        class Deref {
            @Requires((x: {nested?: {deep?: boolean}}) => !!x.nested!.deep, 'x.nested.deep is set')
            run(x: unknown) {
                return x;
            }
        }
        // The predicate throws reading `.deep` of undefined — surfaced as a precondition failure.
        expect(() => new Deref().run({})).toThrow('Precondition failed');
    });
});

describe('@Requires — the shared oracle and no-drift (DEC-057)', () => {
    @Contract()
    class Booking {
        @Requires((start: number, end: number) => start < end, 'start is before end')
        reserve(start: number, end: number) {
            return [start, end];
        }
    }

    it('evaluatePreconditions is the exact function enforcement runs (oracle == enforced)', () => {
        const pres = getEffectivePreconditions(Booking.prototype, 'reserve');
        expect(pres.length).toBe(1);

        // The oracle flags exactly the arguments enforcement rejects, and passes those it accepts.
        expect(evaluatePreconditions(pres, [5, 1]).ok).toBe(false);
        expect(() => new Booking().reserve(5, 1)).toThrow();

        expect(evaluatePreconditions(pres, [1, 5]).ok).toBe(true);
        expect(new Booking().reserve(1, 5)).toEqual([1, 5]);
    });

    it('evaluatePreconditions reports the first failing precondition, first-failure-wins', () => {
        const pre = {predicate: (a: number, b: number) => a < b, description: 'a < b'};
        expect(evaluatePreconditions([pre], [1, 2])).toEqual({ok: true});
        const verdict = evaluatePreconditions([pre], [2, 1]);
        if (verdict.ok) throw new Error('expected a precondition failure');
        expect(verdict.failed).toBe(pre);
    });
});

describe('@Requires — inheritance and unprojectability (DEC-057)', () => {
    it('a subclass override inherits its parent @Requires (DEC-022 union, installer effective keys)', () => {
        @Contract()
        class Base {
            @Requires((n: number) => n > 0, 'n positive')
            m(n: number) {
                return n;
            }
        }
        @Contract()
        class Sub extends Base {
            m(n: number) {
                return n * 2;
            } // overrides WITHOUT redeclaring @Requires
        }
        expect(new Sub().m(3)).toBe(6);
        expect(() => new Sub().m(-1)).toThrow('n positive'); // inherited precondition still enforced
    });

    it('is UNPROJECTABLE: a @Requires-only method projects to an empty tool schema', () => {
        @Contract()
        class Range {
            @Requires((lo: number, hi: number) => lo <= hi, 'lo <= hi')
            make(lo: number, hi: number) {
                return {lo, hi};
            }
        }
        const schema = toolSchemaForMethod(Range, 'make');
        // The precondition contributes nothing — no properties, nothing required (like @Ensures).
        expect(schema.properties).toEqual({});
        expect(schema.required).toEqual([]);
    });
});
