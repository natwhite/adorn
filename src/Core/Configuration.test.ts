/**
 * P3.2 — the trust model (DEC-008 / Q-2 / SMELL-4).
 *
 * The assertion this suite exists for is `production strips assert and KEEPS guard`. A single global
 * boolean cannot express that, which is why one was rejected: it would either keep both (and be
 * pointless) or strip both (and remove the checks standing between untrusted input and the code
 * behind it).
 */

import {
    disableGuardEnforcement,
    enableGuardEnforcement,
    getEnforcementMode,
    isGuardEnforcementEnabled,
    resetConfiguration,
    resolveTrust,
    setAssertEnforcement,
    setConfigurationSink,
    setDefaultTrust,
    setEnforcementMode,
    setViolationPolicy,
    shouldEnforce,
    applyViolationPolicy,
    ViolationSite,
} from './Configuration';

const SITE: ViolationSite = {owner: 'Task', member: 'send', trust: 'guard'};

beforeEach(resetConfiguration);
afterEach(resetConfiguration);

describe('the production switch', () => {
    it('keeps guards and strips asserts in production — the whole point', () => {
        setEnforcementMode('production');

        expect(shouldEnforce('guard')).toBe(true);
        expect(shouldEnforce('assert')).toBe(false);
    });

    it('enforces both in development', () => {
        setEnforcementMode('development');

        expect(shouldEnforce('guard')).toBe(true);
        expect(shouldEnforce('assert')).toBe(true);
    });

    it('follows NODE_ENV by default, read per call rather than cached at import', () => {
        const previous = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            expect(getEnforcementMode()).toBe('production');
            expect(shouldEnforce('assert')).toBe(false);

            process.env.NODE_ENV = 'development';
            expect(getEnforcementMode()).toBe('development');
            expect(shouldEnforce('assert')).toBe(true);
        } finally {
            process.env.NODE_ENV = previous;
        }
    });

    it('lets asserts be pinned on in production, and off in development', () => {
        setEnforcementMode('production');
        setAssertEnforcement(true);
        expect(shouldEnforce('assert')).toBe(true);

        setEnforcementMode('development');
        setAssertEnforcement(false);
        expect(shouldEnforce('assert')).toBe(false);

        // ...and `guard` is unaffected by either
        expect(shouldEnforce('guard')).toBe(true);
    });
});

describe('disabling guards', () => {
    it('refuses without an explicit confirmation and a reason', () => {
        expect(() => disableGuardEnforcement({} as any)).toThrow(/refusing to strip guard contracts/);
        expect(() => disableGuardEnforcement({confirm: false, reason: 'x'} as any)).toThrow(/refusing/);
        expect(() => disableGuardEnforcement({confirm: true, reason: '   '} as any)).toThrow(/refusing/);

        expect(isGuardEnforcementEnabled()).toBe(true);
    });

    it('points at the safe alternative rather than just saying no', () => {
        expect(() => disableGuardEnforcement({} as any)).toThrow(/setAssertEnforcement/);
    });

    it('announces itself loudly when it does happen', () => {
        const warnings: string[] = [];
        setConfigurationSink(message => warnings.push(message));

        disableGuardEnforcement({confirm: true, reason: 'benchmarking only'});

        expect(shouldEnforce('guard')).toBe(false);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('GUARD CONTRACTS DISABLED');
        expect(warnings[0]).toContain('benchmarking only');
    });

    it('is reversible, and re-enabling is silent', () => {
        const warnings: string[] = [];
        setConfigurationSink(message => warnings.push(message));

        disableGuardEnforcement({confirm: true, reason: 'test'});
        enableGuardEnforcement();

        expect(shouldEnforce('guard')).toBe(true);
        expect(warnings).toHaveLength(1); // no second message
    });

    it('is not reachable by the production switch', () => {
        setEnforcementMode('production');
        setAssertEnforcement(false);

        // Nothing about going to production can turn a guard off.
        expect(shouldEnforce('guard')).toBe(true);
    });
});

describe('trust resolution', () => {
    it('defaults to guard — the safe direction to be wrong in', () => {
        expect(resolveTrust()).toBe('guard');
        expect(resolveTrust({})).toBe('guard');
    });

    it('takes an explicit per-decorator option over the process default', () => {
        expect(resolveTrust({trust: 'assert'})).toBe('assert');

        setDefaultTrust('assert');
        expect(resolveTrust()).toBe('assert');
        expect(resolveTrust({trust: 'guard'})).toBe('guard');
    });

    it('rejects an unknown trust level rather than silently defaulting', () => {
        expect(() => resolveTrust({trust: 'maybe' as any})).toThrow(/must be 'guard' or 'assert'/);
    });
});

describe('violation routing', () => {
    it('throws by default', () => {
        const violation = new Error('bad');
        expect(() => applyViolationPolicy(violation, SITE)).toThrow(violation);
    });

    it("returns without throwing under 'warn', and says which contract it let through", () => {
        const warnings: string[] = [];
        setConfigurationSink(message => warnings.push(message));
        setViolationPolicy('warn');

        expect(() => applyViolationPolicy(new Error('bad'), SITE)).not.toThrow();
        expect(warnings[0]).toContain('Task.send');
        expect(warnings[0]).toContain('bad');
    });

    it('routes to a custom handler, which suppresses by returning', () => {
        const seen: Array<{violation: unknown; site: ViolationSite}> = [];
        setViolationPolicy((violation, site) => seen.push({violation, site}));

        const violation = new Error('bad');
        expect(() => applyViolationPolicy(violation, SITE)).not.toThrow();

        expect(seen).toHaveLength(1);
        expect(seen[0].violation).toBe(violation);
        expect(seen[0].site.owner).toBe('Task');
        expect(seen[0].site.trust).toBe('guard');
    });

    it('lets a custom handler escalate by throwing', () => {
        setViolationPolicy(() => { throw new Error('escalated'); });

        expect(() => applyViolationPolicy(new Error('bad'), SITE)).toThrow(/escalated/);
    });
});

describe('resetConfiguration', () => {
    it('restores every setting to its shipped default', () => {
        setEnforcementMode('production');
        setAssertEnforcement(true);
        setDefaultTrust('assert');
        setViolationPolicy('warn');
        setConfigurationSink(() => undefined);
        disableGuardEnforcement({confirm: true, reason: 'test'});

        resetConfiguration();

        expect(isGuardEnforcementEnabled()).toBe(true);
        expect(resolveTrust()).toBe('guard');
        expect(() => applyViolationPolicy(new Error('bad'), SITE)).toThrow();
    });
});
