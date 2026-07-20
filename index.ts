import {StringMinLength, Positive, GreaterThanEqual, LessThanEqual} from './src/ParameterDecorators/Constraints';
import {Enforce} from './src/FieldDeocrators/Enforce';
import {Verify} from './src/Validation/Verify';
import {Log, Memoize} from './src/MethodDecorators/promise/Memoize';
import {Contract, Validate} from './src/Core/ContractInstaller';
import {
    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,
} from './src/Core/ContractDiagnostics';

export {
    LessThanEqual,
    GreaterThanEqual,
    Positive,
    StringMinLength,
    Enforce,
    Verify,
    Memoize,
    Log,

    /**
     * BREAKING (P1.3) — required on any class using parameter constraints.
     *
     * Parameter decorators record; `@Contract()` installs. Without it the constraints are recorded
     * but never enforced, and the class is invisible to documentation and fuzzing projections. A
     * development-mode warning names any class that forgets it; the controls below tune that
     * warning, they do not substitute for the annotation.
     */
    Contract,
    /** Per-method opt-in alternative to `@Contract()`. Enforces, but does not register for projection. */
    Validate,

    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,
};


/*
    Parameters & Field:
        String:
            Length:
                Min
                Max
            Regex:
                Matches
                Url
                Email
            Modifiers:
                default
                RegexReplace
        Number:
            Constraints:
                Positive
                Negative
                LessThan
                GreaterThan
                Between
                Filter
            Modifiers:
                Map
        T:
            Map

    Method:
        Memoize
        Time
 */
