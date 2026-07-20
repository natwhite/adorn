// --- Parameter decorators -------------------------------------------------
import {
    Positive, Negative, NonNegative, NonPositive,
    LessThanEqual, GreaterThanEqual, LessThan, GreaterThan,
    Between, Integer, MultipleOf,
    StringMinLength, MinLength, MaxLength, NotEmpty, Matches, Email, Url,
} from './src/ParameterDecorators/Constraints';

// --- Field decorators -----------------------------------------------------
import {Enforce} from './src/FieldDeocrators/Enforce';
import {CreateFieldDecorator, installFieldContracts} from './src/Core/FieldDecoratorFactory';

// --- Imperative assertion (for call sites with no decoration point) --------
import {Verify} from './src/Validation/Verify';

// --- Method decorators ----------------------------------------------------
import {Log, Memoize} from './src/MethodDecorators/promise/Memoize';
import {Time, setTimingSink} from './src/MethodDecorators/Time';

// --- Installation & diagnostics -------------------------------------------
import {Contract, Validate} from './src/Core/ContractInstaller';
import {
    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,
} from './src/Core/ContractDiagnostics';

// --- Enforcement configuration (DEC-008) ----------------------------------
import {
    setEnforcementMode, setAssertEnforcement, setDefaultTrust,
    disableGuardEnforcement, enableGuardEnforcement, setViolationPolicy,
} from './src/Core/Configuration';

// --- Registry introspection (Q-6: this surface is now semver-relevant) -----
import {
    getContracts, getContract, getContractedClasses, getContractsForClass,
} from './src/Core/ContractRegistry';

// --- Projections ----------------------------------------------------------
import {
    documentClass, documentContracts, renderMarkdown, generateMarkdown,
} from './src/Projections/docs';

// --- Constraint descriptors, namespaced -----------------------------------
// `src/Contracts/*` exports `Positive`, `Between`, `GreaterThanEqual`, ... under the SAME
// names as the parameter decorators above — but those are *descriptors* (data), not
// decorators. A flat re-export would collide, so they are namespaced. Use them wherever a
// descriptor is wanted directly:
//
//     Verify.that(NumberContracts.Between(1, 10), 'retries', retries);
//     @CreateFieldDecorator(NumberContracts.MultipleOf(5)) step: number;
import * as NumberContracts from './src/Contracts/number';
import * as StringContracts from './src/Contracts/string';

export {
    // Parameter decorators
    Positive, Negative, NonNegative, NonPositive,
    LessThanEqual, GreaterThanEqual, LessThan, GreaterThan,
    Between, Integer, MultipleOf,
    StringMinLength, MinLength, MaxLength, NotEmpty, Matches, Email, Url,

    // Field decorators
    Enforce,
    CreateFieldDecorator,
    installFieldContracts,

    // Imperative assertion
    Verify,

    // Method decorators
    Memoize, Log, Time, setTimingSink,

    /**
     * BREAKING (P1.3) — required on any class using parameter constraints.
     *
     * Parameter decorators record; `@Contract()` installs. Without it the constraints are recorded
     * but never enforced, and the class is invisible to documentation and fuzzing projections. A
     * development-mode warning names any class that forgets it; the controls below tune that
     * warning, they do not substitute for the annotation.
     */
    Contract,
    /**
     * Per-method alternative to `@Contract()`.
     *
     * Since DEC-016 it **also registers the class for projection** — installation implies
     * enumeration, so adorn never enforces at runtime what it would omit from a generated artifact.
     */
    Validate,

    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,

    // Enforcement configuration. `guard` contracts survive production; `assert` contracts are
    // stripped by default. Guards are only removable via disableGuardEnforcement({confirm, reason}).
    setEnforcementMode, setAssertEnforcement, setDefaultTrust,
    disableGuardEnforcement, enableGuardEnforcement, setViolationPolicy,

    // Registry introspection — what the projections read
    getContracts, getContract, getContractedClasses, getContractsForClass,

    // Projections: documentation generated from recorded contracts
    documentClass, documentContracts, renderMarkdown, generateMarkdown,

    // Constraint descriptors (data, not decorators)
    NumberContracts, StringContracts,
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
