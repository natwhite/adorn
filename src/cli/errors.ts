/**
 * CLI error type and the process exit-code vocabulary.
 *
 * A {@link CliError} is a *handled* failure — a bad invocation, a missing entry file, a missing
 * optional toolchain dependency. `main` catches it, prints only its message (no stack), and exits with
 * its {@link CliError.exitCode}. Anything else that escapes is an unexpected bug and is printed with a
 * stack, so the two are never confused.
 */

/**
 * The exit-code vocabulary, deliberately small.
 *
 * `LEAKS` is `1` so `adorn check` follows the lint-tool convention a caller expects: a zero exit means
 * "clean", a `1` means "the thing you asked me to look for was found". `USAGE` is `2`, the conventional
 * "you invoked me wrong" code, kept distinct so a CI script can tell a real leak from a typo. A runtime
 * failure (an entry that would not load, a write that failed) is `1` — a failure, but not a usage error.
 */
export const EXIT = {
    /** Success. Also: `check` ran and found no leaks. */
    OK: 0,
    /** `check` found at least one leak. */
    LEAKS: 1,
    /** A handled runtime failure (entry failed to load, output could not be written). */
    RUNTIME: 1,
    /** The command line was malformed — unknown command, missing required argument. */
    USAGE: 2,
} as const;

/**
 * A failure the user is meant to read as a message, not a stack trace. Carries the exit code the
 * process should end with, so the dispatcher does not have to map error kinds to codes itself.
 */
export class CliError extends Error {
    readonly exitCode: number;

    constructor(message: string, exitCode: number = EXIT.USAGE) {
        super(message);
        this.name = 'CliError';
        this.exitCode = exitCode;
    }
}
