// --- Parameter decorators -------------------------------------------------
// The line breaks group these by what they constrain — ordering, then the other numeric
// predicates, then string — which one-specifier-per-line would flatten away.
// prettier-ignore
import {
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
import {Log} from './src/MethodDecorators/Log';
import {Time, setTimingSink} from './src/MethodDecorators/Time';

// --- Installation & diagnostics -------------------------------------------
import {Contract, Validate} from './src/Core/ContractInstaller';
import {
    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,
} from './src/Core/ContractDiagnostics';

// --- Enforcement configuration (DEC-008) ----------------------------------
// Grouped by line: the mode/trust setters, then the guard controls.
// prettier-ignore
import {
    setEnforcementMode, setAssertEnforcement, setDefaultTrust,
    disableGuardEnforcement, enableGuardEnforcement, setViolationPolicy,
} from './src/Core/Configuration';

// --- Registry introspection (Q-6: this surface is now semver-relevant) -----
// Read surface only. The writers (recordParameterConstraint, recordFieldConstraint,
// setParameterMetadata, setFieldMetadata, markInstalled, ...) are deliberately NOT
// exported: they would let a caller bypass the adapter that owns declaration
// ordering (SMELL-13) and installation, and write contracts the enforcement path
// never sees.
//
// Grouped by line: method reads, then declared-field reads, then the inheritance-aware reads.
// prettier-ignore
import {
    getContracts, getContract, getContractedClasses, getContractsForClass,
    getFieldContract, getFieldContracts, getFieldContractsForClass,
    getEffectiveFieldConstraints, getEffectiveFieldContract,
} from './src/Core/ContractRegistry';

// --- Projections ----------------------------------------------------------
import {
    documentClass, documentContracts, renderMarkdown, generateMarkdown,
} from './src/Projections/docs';

// The projection's model types, so a consumer can actually type a variable holding one.
// `ClassDoc.fields` is deliberately required, not optional: an optional band is one a future
// projection can silently forget to populate, which is the failure this whole layer exists to avoid.
export type {
    ClassDoc, MethodDoc, ParameterDoc, ConstraintDoc, FieldDoc, MarkdownOptions,
} from './src/Projections/docs';

// --- Constraint descriptors, namespaced -----------------------------------
// `src/Contracts/*` exports `GreaterThan`, `Between`, `GreaterThanEqual`, ... under the SAME
// names as the parameter decorators above — but those are *descriptors* (data), not
// decorators. A flat re-export would collide, so they are namespaced. Use them wherever a
// descriptor is wanted directly:
//
//     Verify.that(NumberContracts.Between(1, 10), 'retries', retries);
//     @CreateFieldDecorator(NumberContracts.MultipleOf(5)) step: number;
import * as NumberContracts from './src/Contracts/number';
import * as StringContracts from './src/Contracts/string';

// The public surface, and the one place a reader can see its whole shape at once. Both the
// section comments and the line grouping within each section are load-bearing: they say which
// exports belong together. Prettier would put every specifier on its own line, turning a
// 60-line map of the API into a 120-line alphabet-soup column, and would drop the blank line
// after `Validate` that separates installation from diagnostics.
// prettier-ignore
export {
    // Parameter decorators
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
    Log, Time, setTimingSink,

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
    getFieldContract, getFieldContracts, getFieldContractsForClass,

    // Inheritance-aware field reads (DEC-021). The prefix is the whole distinction:
    // `getFieldContract`/`getFieldContracts` answer "what does this class *declare*",
    // while `getEffectiveFieldContract`/`getEffectiveFieldConstraints` answer "what is
    // *in force* here" — the union of every declaration on the prototype chain, which is
    // what enforcement applies and what a projection should render.
    getEffectiveFieldConstraints, getEffectiveFieldContract,

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
                LessThan
                GreaterThan
                Between
                Filter
            Modifiers:
                Map
        T:
            Map

    Method:
        Time
 */
