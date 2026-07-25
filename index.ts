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

// --- Sensitive marker (DEC-PII-1/2) ---------------------------------------
// Record-only: marks a field/parameter/class as holding sensitive data; it does NOT redact.
// Redaction (safe-by-default emission) is a separate, later piece. See docs/sensitive.md.
import {Sensitive} from './src/Sensitive/Sensitive';
export type {SensitiveOptions} from './src/Sensitive/Sensitive';

// --- Imperative assertion (for call sites with no decoration point) --------
import {Verify} from './src/Validation/Verify';

// --- Method decorators ----------------------------------------------------
import {Log} from './src/MethodDecorators/Log';
import {Time, setTimingSink} from './src/MethodDecorators/Time';
import {Ensures} from './src/MethodDecorators/Ensures';
import {Returns} from './src/MethodDecorators/Returns';

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

// --- Value disclosure (DEC-030) -------------------------------------------
// adorn's own emissions (@Log, violation messages) redact values by default; this is the
// opt-in to turn them back on for local debugging. @Sensitive always vetoes (DEC-025).
import {setValueDisclosure, getValueDisclosure} from './src/Core/redaction';

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
    getEffectiveContract, getEffectiveParameterConstraints,
    getEffectivePostconditions,
} from './src/Core/ContractRegistry';

// --- Postcondition evaluation (DEC-032) -----------------------------------
// `evaluatePostconditions` is the SAME function the runtime wrapper calls, so a fuzzer
// (Phase B) checking the oracle checks exactly what enforcement enforces — no drift.
import {evaluatePostconditions} from './src/Core/Postconditions';
export type {PostconditionResult} from './src/Core/Postconditions';

// --- Projections ----------------------------------------------------------
import {documentClass, documentContracts, renderMarkdown, generateMarkdown} from './src/Projections/docs';
import {schemaForClass, schemaForContracts, serializeSchema, generateSchema} from './src/Projections/schema';

// The projection's model types, so a consumer can actually type a variable holding one.
// `ClassDoc.fields` is deliberately required, not optional: an optional band is one a future
// projection can silently forget to populate, which is the failure this whole layer exists to avoid.
export type {
    ClassDoc,
    MethodDoc,
    ParameterDoc,
    ConstraintDoc,
    FieldDoc,
    MarkdownOptions,
} from './src/Projections/docs';
export type {ClassSchema, SchemaOptions} from './src/Projections/schema';

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

    // Sensitive marker (record-only; DEC-PII-1/2). Marks data as sensitive for the build-time
    // detector and a future exposure report — it does not redact. See docs/sensitive.md.
    Sensitive,

    // Imperative assertion
    Verify,

    // Method decorators
    Log, Time, setTimingSink,

    // Postconditions (DEC-032). `@Ensures` records; `@Contract()`/`@Validate()` installs. Runs
    // after the method returns — a throw skips, async awaits-then-checks, inheritance conjoins
    // (covariant strengthening, free via the DEC-021/022 union). `evaluatePostconditions` below
    // is the same oracle the fuzzer consumes.
    Ensures,
    // `@Returns(<descriptor>)` (DEC-033) — the projectable postcondition tier. Records an existing
    // ConstraintDescriptor into the reserved `post` band, so the return value is checked by the same
    // predicate machinery preconditions use (DEC-010) AND emitted into docs (a Returns table) and
    // schema (a `returns` fragment). Coexists with @Ensures on one method — the reified band is
    // checked first; a descriptor relates one value, a closure relates result-to-inputs. The registry
    // writer/reader (recordReturnConstraint / getEffectiveReturnConstraints) stay internal (Q-6).
    Returns,

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

    // Value disclosure (DEC-030). @Log and violation messages redact values by default;
    // setValueDisclosure('all') opts in for local debugging. @Sensitive always vetoes.
    setValueDisclosure, getValueDisclosure,

    // Registry introspection — what the projections read
    getContracts, getContract, getContractedClasses, getContractsForClass,
    getFieldContract, getFieldContracts, getFieldContractsForClass,

    // Inheritance-aware reads (DEC-021 fields, DEC-022 methods). The prefix is the whole
    // distinction: the plain reads answer "what does this class *declare*", while the
    // `getEffective*` reads answer "what is *in force* here" — the union of every
    // declaration on the prototype chain, which is what enforcement applies and what a
    // projection should render. Reading the plain form and assuming it describes runtime
    // behaviour is a mistake, which is why the names disambiguate.
    //
    // `getEffectiveContractKeys` is deliberately NOT exported: it exists for the installer,
    // and Q-6 makes every registry export semver-relevant.
    getEffectiveFieldConstraints, getEffectiveFieldContract,
    getEffectiveContract, getEffectiveParameterConstraints,
    getEffectivePostconditions,

    // The postcondition oracle — the same evaluator the runtime wrapper runs, exposed so a
    // fuzzer (Phase B) checks exactly what enforcement enforces.
    evaluatePostconditions,

    // Projections: documentation generated from recorded contracts
    documentClass, documentContracts, renderMarkdown, generateMarkdown,

    // Projections: JSON Schema (draft 2020-12) generated from recorded contracts
    schemaForClass, schemaForContracts, serializeSchema, generateSchema,

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
