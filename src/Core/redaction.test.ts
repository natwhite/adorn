import {
    getValueDisclosure,
    REDACTED,
    resetValueDisclosure,
    setValueDisclosure,
    shouldDiscloseValue,
} from './redaction';

/**
 * The redaction runtime's configuration surface (DEC-025 / DEC-PII-1).
 *
 * The load-bearing property under test is that safe-by-default holds *without* consulting any
 * `@Sensitive` marking: `shouldDiscloseValue` never reads the registry, and its default answer is
 * "do not disclose". The `sensitive` argument only ever *removes* disclosure.
 */
describe('redaction — value disclosure', () => {
    afterEach(() => resetValueDisclosure());

    it('ships redacting: disclosure defaults to none', () => {
        expect(getValueDisclosure()).toBe('none');
        expect(shouldDiscloseValue(false)).toBe(false);
        expect(shouldDiscloseValue(true)).toBe(false);
    });

    it('discloses non-sensitive values only when explicitly opted in', () => {
        setValueDisclosure('all');
        expect(getValueDisclosure()).toBe('all');
        expect(shouldDiscloseValue(false)).toBe(true);
    });

    it('keeps a sensitive site redacted even with disclosure on — @Sensitive vetoes, never grants', () => {
        setValueDisclosure('all');
        expect(shouldDiscloseValue(true)).toBe(false);
    });

    it('never grants disclosure while off, sensitive or not', () => {
        setValueDisclosure('none');
        expect(shouldDiscloseValue(false)).toBe(false);
        expect(shouldDiscloseValue(true)).toBe(false);
    });

    it('resets to the shipped default', () => {
        setValueDisclosure('all');
        resetValueDisclosure();
        expect(getValueDisclosure()).toBe('none');
    });

    it('rejects an unknown mode rather than silently failing open', () => {
        expect(() => setValueDisclosure('full' as any)).toThrow(/must be 'none' or 'all'/);
        expect(() => setValueDisclosure(undefined as any)).toThrow(/must be 'none' or 'all'/);
        // The failed set left the safe default in place.
        expect(getValueDisclosure()).toBe('none');
    });

    it('exposes a single fixed placeholder token', () => {
        expect(REDACTED).toBe('[REDACTED]');
    });
});
