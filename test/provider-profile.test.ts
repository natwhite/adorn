/**
 * `{ provider, strict }` — the provider-compatibility profile that supersedes the boolean `providerStrict`
 * (DEC-093, GPT review). `providerStrict` is kept as a deprecated, behaviour-identical alias; the honest shape
 * names what strict mode actually is — a specific provider's compatibility rules, not a generic flag. An
 * unsupported provider is a loud build-time error, never a silent OpenAI fallback.
 */
import {toolSchemaFrom, NullableContracts, StringContracts, NumberContracts} from '../index';
import type {ToolSchemaProvider} from '../index';

const input = {
    name: 'f',
    params: {
        a: StringContracts.NotEmpty(),
        b: {descriptor: NullableContracts.Nullable(NumberContracts.Between(1, 5)), optional: true},
    },
};

describe('provider profile supersedes providerStrict (DEC-093)', () => {
    it('{ provider: "openai", strict: true } equals the deprecated { providerStrict: true }', () => {
        const viaNew = toolSchemaFrom(input, {provider: 'openai', strict: true});
        const viaOld = toolSchemaFrom(input, {providerStrict: true});
        expect(viaNew).toEqual(viaOld);
        // strict promotes the nullable-optional `b` back into required at the root.
        expect(viaNew.required.slice().sort()).toEqual(['a', 'b']);
    });

    it('{ strict: true } alone defaults the provider to openai', () => {
        expect(toolSchemaFrom(input, {strict: true})).toEqual(toolSchemaFrom(input, {providerStrict: true}));
    });

    it('{ provider: "openai" } without strict is a non-strict no-op', () => {
        const viaProvider = toolSchemaFrom(input, {provider: 'openai'});
        const bare = toolSchemaFrom(input);
        expect(viaProvider).toEqual(bare);
        // the optional `b` is NOT force-required without strict.
        expect(viaProvider.required).toEqual(['a']);
    });

    it('an unsupported provider throws at build time, never a silent openai fallback', () => {
        const unsupported: string = 'anthropic';
        expect(() =>
            toolSchemaFrom(input, {provider: unsupported as ToolSchemaProvider, strict: true}),
        ).toThrow(/provider 'anthropic' has no compatibility profile/);
        // even without strict — asking for an unsupportable profile is itself the error.
        expect(() => toolSchemaFrom(input, {provider: unsupported as ToolSchemaProvider})).toThrow(
            /has no compatibility profile/,
        );
    });

    it('the strict refusal message points at the { provider, strict } form, not the deprecated boolean', () => {
        const bareOptional = {
            params: {note: {descriptor: StringContracts.NotEmpty(), optional: true}},
        };
        let message = '';
        try {
            toolSchemaFrom(bareOptional, {strict: true});
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/nullable/i);
        expect(message).toContain('strict: true');
        expect(message).not.toContain('providerStrict'); // the deprecated spelling is gone from the advice
    });
});
