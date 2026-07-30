/**
 * `@Optional` in fuzzing (DEC-051 / adversarial-review M2).
 *
 * An effective-optional position is satisfied by an ABSENT (`undefined`) argument, so the fuzzer's
 * per-position generator must sometimes produce absence — otherwise the optional path is never
 * exercised. And because the run drives the REAL `@Contract()`-installed method (whose guard skips an
 * absent optional position), the oracle must never mistake that generated absence for a violation.
 *
 * Classes are declared inside each test so the suite is independent of registry accumulation order.
 */

import * as fc from 'fast-check';
import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {GreaterThanEqual} from '../../src/ParameterDecorators/Constraints';
import {Optional} from '../../src/Markers/Optional';
import {fuzzMethod} from './oracle';

describe('@Optional exercises absence in fuzzing (M2)', () => {
    it('generates undefined SOMETIMES for an optional position, and present-valid the rest', () => {
        @Contract()
        class Scheduler {
            schedule(@Optional() @GreaterThanEqual(1) days: number): string {
                return days === undefined ? 'default' : `in ${days} days`;
            }
        }

        const result = fuzzMethod({
            target: Scheduler,
            method: 'schedule',
            subject: () => new Scheduler(),
            numRuns: 200,
        });

        expect(result.declined).toBe(false);
        expect(result.passed).toBe(true);

        // The optional position's generator produces both absence AND sound present values.
        const arbitrary = result.coverage[0].arbitrary;
        expect(arbitrary).not.toBeNull();
        const samples = fc.sample(arbitrary as fc.Arbitrary<unknown>, {numRuns: 200, seed: 7});
        expect(samples).toContain(undefined); // absence is exercised
        expect(samples.some(v => typeof v === 'number' && v >= 1)).toBe(true); // present-valid too
    });

    it('does NOT flag an absent optional argument as a contract-violation', () => {
        @Contract()
        class S {
            go(@Optional() @GreaterThanEqual(1) n: number): number {
                return n === undefined ? 0 : n;
            }
        }

        const result = fuzzMethod({
            target: S,
            method: 'go',
            subject: () => new S(),
            numRuns: 300,
        });

        expect(result.passed).toBe(true);
        expect(result.finding).toBeUndefined();
    });

    it('a NON-optional constrained position stays sound (never generates undefined)', () => {
        @Contract()
        class Strict {
            need(@GreaterThanEqual(1) n: number): number {
                return n;
            }
        }

        const result = fuzzMethod({
            target: Strict,
            method: 'need',
            subject: () => new Strict(),
            numRuns: 200,
        });

        expect(result.passed).toBe(true);
        const samples = fc.sample(result.coverage[0].arbitrary as fc.Arbitrary<unknown>, {
            numRuns: 200,
            seed: 7,
        });
        // No absence for a required position — the Phase A soundness floor is preserved.
        expect(samples).not.toContain(undefined);
    });
});
