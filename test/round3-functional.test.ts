/**
 * Voice-agent Round 3 functional-surface additions (DEC-074): `violationFromCheck` (L11) and
 * `createConsoleObservationSink` (L12).
 */

import {
    Verify,
    violationFromCheck,
    createConsoleObservationSink,
    consoleObservationSink,
    ObjectContracts,
    StringContracts,
    NumberContracts,
} from '../index';
import type {CheckResult, CheckFailure, Observation, ObservationEvent} from '../index';

const shape = ObjectContracts.Fields({
    name: StringContracts.NotEmpty(),
    age: NumberContracts.Between(0, 120),
});

// Narrow a CheckResult to its failure arm, throwing if it unexpectedly succeeded. Since DEC-079 (strict)
// the `if (r.ok) throw` guard narrows `r` for us — no cast.
function asFail(r: CheckResult<unknown>): CheckFailure {
    if (r.ok) throw new Error('expected a failed CheckResult');
    return r;
}

describe('L11 — violationFromCheck maps a failed CheckResult onto ViolationFacts', () => {
    it('carries constraint/kind and the localized expectation, with boundary defaults', () => {
        const r = asFail(Verify.check(shape, 'args', {age: 30})); // name missing → localized
        const facts = violationFromCheck(r, {parameter: 'args'});
        expect(facts.constraint).toBe(r.constraint);
        expect(facts.kind).toBe(r.kind);
        expect(facts.parameterName).toBe('args');
        expect(facts.parameterIndex).toBe(0);
        expect(facts.trust).toBe('guard'); // boundary posture
        expect(facts.blame).toBe('caller');
        expect(facts.params).toEqual({});
        expect(typeof facts.expectation).toBe('string');
        expect(facts.expectation.length).toBeGreaterThan(0);
    });

    it('honours explicit trust/blame/index overrides', () => {
        const r = asFail(Verify.check(StringContracts.NotEmpty(), 'x', ''));
        const facts = violationFromCheck(r, {index: 2, trust: 'assert', blame: 'callee'});
        expect(facts.parameterIndex).toBe(2);
        expect(facts.trust).toBe('assert');
        expect(facts.blame).toBe('callee');
        expect(facts.parameterName).toBeUndefined();
    });
});

describe('L12 — createConsoleObservationSink writes through a configurable stream', () => {
    const observation: Observation = {
        owner: 'reminders',
        member: 'schedule',
        name: 'reminders.schedule',
        isStatic: false,
        detail: 'always',
        kind: 'internal',
        parameters: [],
    };
    const completed: ObservationEvent = {
        kind: 'completed',
        observation,
        callId: 0,
        durationMs: 12,
        outcome: 'returned',
        settled: true,
    };

    it('routes each event line to the provided writer, not console.log', () => {
        const lines: string[] = [];
        const sink = createConsoleObservationSink(line => lines.push(line));
        sink.record?.(completed);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('[adorn:observe]');
        expect(lines[0]).toContain('reminders.schedule');
    });

    it('a throwing writer never fails the observed call', () => {
        const sink = createConsoleObservationSink(() => {
            throw new Error('stream closed');
        });
        expect(() => sink.record?.(completed)).not.toThrow();
    });

    it('the ready-made consoleObservationSink still works (default writer)', () => {
        expect(() => consoleObservationSink.record?.(completed)).not.toThrow();
    });
});
