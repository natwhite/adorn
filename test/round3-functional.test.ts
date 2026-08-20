/**
 * Voice-agent Round 3 functional-surface additions (DEC-074): `Verify.checkJson` (L10),
 * `violationFromCheck` (L11), and `createConsoleObservationSink` (L12).
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

// `strict:false` does not narrow a `CheckResult` on `r.ok`, so cast after the guard (the codebase's
// established asFail pattern). Sound: we throw unless the result is a failure.
function asFail(r: CheckResult<unknown>): CheckFailure {
    if (r.ok) throw new Error('expected a failed CheckResult');
    return r as CheckFailure;
}

describe('L10 — Verify.checkJson distinguishes a malformed envelope from a wrong shape', () => {
    it('parses valid JSON of the right shape and returns the narrowed value', () => {
        const r = Verify.checkJson(shape, 'args', '{"name":"Al","age":30}');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual({name: 'Al', age: 30});
    });

    it('flags malformed JSON with malformedJson:true and never says "fields missing"', () => {
        const r = asFail(Verify.checkJson(shape, 'args', '{"name":"Al","age":'));
        expect(r.malformedJson).toBe(true);
        expect(r.message).toMatch(/not valid JSON/i);
        expect(r.message).not.toMatch(/field/i);
    });

    it('a non-string / non-JSON primitive is malformed too', () => {
        expect(asFail(Verify.checkJson(shape, 'args', 'not json at all')).malformedJson).toBe(true);
    });

    it('valid JSON of the WRONG shape is an ordinary shape failure (no malformedJson), localized', () => {
        const r = asFail(Verify.checkJson(shape, 'args', '{"age":30}')); // name missing
        expect(r.malformedJson).toBeUndefined();
        expect(r.path).toEqual(['name']);
    });

    it('never leaks the raw text into the message', () => {
        const secret = '{"ssn":"123-45-6789"'; // malformed, carries a secret
        expect(asFail(Verify.checkJson(shape, 'args', secret)).message).not.toContain('123-45-6789');
    });
});

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
