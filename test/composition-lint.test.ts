/**
 * The unsatisfiable-stack diagnostic (GAP-20 / round-3 §3 / DEC-063).
 *
 * `@ArrayOf(X) @OneOf(ROSTER)` (two flat param decorators) conjoins to an always-false predicate + a
 * plausible-but-unsatisfiable `{type:'array', enum:[…], items:…}`. The wrong spelling is the more natural
 * one. adorn warns at install time (report-only, dev-gated) because composition is registry data; the
 * fix pushes the enum inside the container: `@ArrayOf(EnumContracts.OneOf([...]))`.
 */

import {
    Contract,
    ArrayOf,
    OneOf,
    Const,
    Dictionary,
    GreaterThanEqual,
    LessThanEqual,
    EnumContracts,
    StringContracts,
    setContractDiagnosticsSink,
    setContractDiagnosticsEnabled,
} from '../index';

/** Capture whatever diagnostics `build` (which defines + installs a class) emits. */
function capture(build: () => void): string[] {
    const messages: string[] = [];
    setContractDiagnosticsSink(m => messages.push(m));
    try {
        build();
    } finally {
        setContractDiagnosticsSink(null);
    }
    return messages;
}
const warned = (messages: string[]): boolean => messages.some(m => /Unsatisfiable constraint stack/.test(m));

describe('unsatisfiable-stack diagnostic (GAP-20 / DEC-063)', () => {
    it('warns on @ArrayOf stacked with @OneOf (the natural wrong spelling)', () => {
        const messages = capture(() => {
            @Contract()
            class Bad {
                pick(@ArrayOf(StringContracts.NotEmpty()) @OneOf(['a', 'b']) subjects: string[]) {
                    return subjects;
                }
            }
            void Bad;
        });
        expect(warned(messages)).toBe(true);
        expect(messages.join('')).toMatch(/@ArrayOf\(EnumContracts\.OneOf/); // the fix is named
    });

    it('warns on @Dictionary stacked with @Const', () => {
        const messages = capture(() => {
            @Contract()
            class Bad2 {
                set(@Dictionary(StringContracts.NotEmpty()) @Const('x') opts: Record<string, string>) {
                    return opts;
                }
            }
            void Bad2;
        });
        expect(warned(messages)).toBe(true);
    });

    it('does NOT warn on the correct @ArrayOf(OneOf([...])) form (enum inside the container)', () => {
        const messages = capture(() => {
            @Contract()
            class Good {
                pick(@ArrayOf(EnumContracts.OneOf(['a', 'b'])) subjects: string[]) {
                    return subjects;
                }
            }
            void Good;
        });
        expect(warned(messages)).toBe(false);
    });

    it('does NOT warn on a plain primitive stack, nor a container alone', () => {
        const messages = capture(() => {
            @Contract()
            class Fine {
                clamp(@GreaterThanEqual(1) @LessThanEqual(10) x: number) {
                    return x;
                }
                tag(@ArrayOf(StringContracts.NotEmpty()) tags: string[]) {
                    return tags;
                }
            }
            void Fine;
        });
        expect(warned(messages)).toBe(false);
    });

    it('is silenced when diagnostics are disabled', () => {
        setContractDiagnosticsEnabled(false);
        const messages = capture(() => {
            @Contract()
            class Silent {
                pick(@ArrayOf(StringContracts.NotEmpty()) @OneOf(['a', 'b']) subjects: string[]) {
                    return subjects;
                }
            }
            void Silent;
        });
        setContractDiagnosticsEnabled(true);
        expect(warned(messages)).toBe(false);
    });
});
