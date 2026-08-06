// --- Parameter decorators -------------------------------------------------
// The line breaks group these by what they constrain — ordering, then the other numeric
// predicates, then string — which one-specifier-per-line would flatten away.
// prettier-ignore
import {
    LessThanEqual, GreaterThanEqual, LessThan, GreaterThan,
    Between, Integer, MultipleOf,
    StringMinLength, MinLength, MaxLength, NotEmpty, Matches, Email, Url,
    Uuid, DateTime, Ipv4, Format,
    OneOf, Const, ArrayOf, Dictionary, Shape, Nullable,
} from './src/ParameterDecorators/Constraints';

// --- Field decorators -----------------------------------------------------
import {Enforce} from './src/FieldDecorators/Enforce';
import {CreateFieldDecorator, installFieldContracts} from './src/Adapters/legacy/FieldDecoratorFactory';

// --- Sensitive marker (DEC-PII-1/2) ---------------------------------------
// Record-only: marks a field/parameter/class as holding sensitive data; it does NOT redact.
// Redaction (safe-by-default emission) is a separate, later piece. See docs/sensitive.md.
import {Sensitive} from './src/Sensitive/Sensitive';
export type {SensitiveOptions} from './src/Sensitive/Sensitive';

// --- Contract markers (DEC-051) -------------------------------------------
// Record-only parameter markers, enforcement-aware. @Optional makes an ABSENT (undefined) argument
// satisfy the position (skipped by the installer, dropped from the tool schema's `required`); @Default
// annotates a JSON default (emitted as a non-asserting `{default}`) and implies @Optional. Inheritance
// is REQUIRED-WINS so a subclass cannot silently weaken (DEC-016/DEC-022); adorn does NOT inject the
// default at runtime — it annotates, the host applies it.
import {Optional} from './src/Markers/Optional';
import {Default} from './src/Markers/Default';

// --- Description markers (Q-30) --------------------------------------------
// Record-only, pure annotation (posture-neutral — never rejects a value). @Describe('…') is a parameter
// description the model reads (→ the property's `description`); @Tool('…') is a method/tool description
// (→ the tool schema's top-level `description`, overridden by the toolSchemaForMethod({description})
// option when both are present). Both flow into docs too. JSDoc stays rejected (DEC-007).
import {Describe} from './src/Markers/Describe';
import {Tool} from './src/Markers/Tool';

// --- Imperative assertion (for call sites with no decoration point) --------
// `Verify.that` throws; `Verify.check` (DEC-053) returns a discriminated `CheckResult` instead — the
// non-throwing path an untrusted I/O boundary needs (a bad body → a `400` as a value, not an exception).
import {Verify} from './src/Validation/Verify';
export type {CheckResult} from './src/Validation/Verify';
// The reified constraint type (GAP-22) — the declared parameter type of `@Dictionary`/`@ArrayOf`/`@Nullable`
// and the shape `Verify.that`/`check` narrow from. Type-only; carries the phantom output param (DEC-059),
// so `ConstraintDescriptor<ConstraintParams, string>` names a string-producing constraint.
export type {ConstraintDescriptor, ConstraintParams} from './src/Core/Descriptor';

// --- Method decorators ----------------------------------------------------
import {Log} from './src/MethodDecorators/Log';
import {Time, setTimingSink} from './src/MethodDecorators/Time';
import {Ensures} from './src/MethodDecorators/Ensures';
import {Requires} from './src/MethodDecorators/Requires';
import {Returns} from './src/MethodDecorators/Returns';
import {Observe} from './src/MethodDecorators/Observe';
export type {ObserveOptions} from './src/MethodDecorators/Observe';

// --- Telemetry disclosure opt-in (O1c, DEC-036) ---------------------------
// Record-only, the twin of @Sensitive: @Telemetry.value()/.redact()/.result() opt a parameter or the
// return INTO value disclosure on the observation `record` path (redacted-by-default otherwise). It does
// NOT emit or install — the rendering is @Observe's job, gated by the shared disclosure resolver.
// @Sensitive still vetoes, and the veto is surfaced (a diagnostic + a `vetoed` flag), not silenced.
import {Telemetry} from './src/Telemetry/Telemetry';

// --- Installation & diagnostics -------------------------------------------
import {Contract, Validate} from './src/Adapters/legacy/ContractInstaller';
import {
    setContractDiagnosticsEnabled,
    setContractDiagnosticsSink,
    flushContractDiagnostics,
} from './src/Adapters/legacy/ContractDiagnostics';

// --- Enforcement configuration (DEC-008) ----------------------------------
// Grouped by line: the mode/trust setters, then the guard controls, then the O1c verbosity dial.
// prettier-ignore
import {
    setEnforcementMode, setAssertEnforcement, setDefaultTrust,
    disableGuardEnforcement, enableGuardEnforcement, setViolationPolicy,
    setObservationVerbosity,
} from './src/Core/Configuration';
export type {ObservationVerbosity} from './src/Core/Configuration';

// --- Value disclosure (DEC-030) -------------------------------------------
// adorn's own emissions (@Log, violation messages) redact values by default; this is the
// opt-in to turn them back on for local debugging. @Sensitive always vetoes (DEC-025).
import {setValueDisclosure, getValueDisclosure} from './src/Core/redaction';

// --- Observability (O1): the neutral observation seam (DEC-035, DEC-036) ---
// A settable, around-shaped sink and the shared settle() classifier. ZERO third-party deps:
// this is the neutral layer that ENDS where OpenTelemetry begins; the @adorn/otel adapter
// (DEC-019) is a separate future add-on and is NOT built here. `RETURN_INDEX` marks the return
// value in an EmittedValue. NOOP_SINK and ViolationError stay INTERNAL — a sink author needs
// neither the sentinel nor the typed error (facts arrive through the sink, not by catching).
import {setObservationSink, getObservationSink, RETURN_INDEX} from './src/Core/Observation';
import {settle} from './src/Core/settle';
// O1c: a ready-made zero-dependency JSON-to-console sink (opt-in; never installed automatically).
import {consoleObservationSink} from './src/Adapters/legacy/ObservationBehavior';

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
    getEffectivePostconditions, getEffectivePreconditions,
} from './src/Core/ContractRegistry';

// --- Postcondition evaluation (DEC-032) -----------------------------------
// `evaluatePostconditions` is the SAME function the runtime wrapper calls, so a fuzzer
// (Phase B) checking the oracle checks exactly what enforcement enforces — no drift.
import {evaluatePostconditions} from './src/Core/Postconditions';
export type {PostconditionResult} from './src/Core/Postconditions';
// `@Requires` cross-parameter preconditions (DEC-057). `evaluatePreconditions` is the SAME function the
// runtime wrapper calls, so a fuzzer that filters generated args by it checks exactly what enforcement runs.
import {evaluatePreconditions} from './src/Core/Preconditions';
export type {PreconditionResult} from './src/Core/Preconditions';

// --- Projections ----------------------------------------------------------
import {documentClass, documentContracts, renderMarkdown, generateMarkdown} from './src/Projections/docs';
// prettier-ignore
import {
    schemaForClass, schemaForContracts, serializeSchema, generateSchema, toolSchemaForMethod,
} from './src/Projections/schema';
// O1d: the "what leaves the process" privacy-review projection — the sixth projection. A pure registry
// read (DEC-012), it reports the disclosure each parameter/return carries and renders its own scanned
// denominator (a clean table is never a clean bill of health). It makes no claim about runtime flows.
// prettier-ignore
import {
    telemetryForClass, telemetryForContracts, serializeTelemetry, generateTelemetryReport,
} from './src/Projections/telemetry';
export type {TelemetryReport} from './src/Projections/telemetry';

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
export type {ClassSchema, SchemaOptions, ToolSchema, ToolSchemaOptions} from './src/Projections/schema';

// The observation model + the event/payload surface an ObservationSink binds to (O1a). This union is
// semver-frozen the moment an adapter binds to it (Q-6): every event payload field is optional and
// object-shaped, so the "seeing ≠ emitting" channel (values, error, attributes) grows additively.
// prettier-ignore
export type {
    ObservationSink, Observation, ObservedParameter, ParameterDisclosure,
    ObservationEvent, ViolationFacts, EmittedValue, ErrorFacts,
    Attributes, AttributeValue, LogLevel, ObservationDetail, ObservationCall, SpanKind,
} from './src/Core/Observation';
// The value-XOR-error settlement handed to settle()'s callback, and its kind discriminant.
export type {Settlement, SettleKind} from './src/Core/settle';

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
// `@OneOf` (IDEA-21/GAP-14): the reified enum/membership descriptor. `EnumContracts.OneOf([...])`
// yields a descriptor for `Verify.that`/`CreateFieldDecorator`, exactly as the number/string
// namespaces expose theirs; the flat `OneOf` above is the parameter *decorator* over the same rule.
import * as EnumContracts from './src/Contracts/enum';
// `@ArrayOf` (DEC-050 / IDEA-22 / GAP-15): the first *compositional* descriptor. `ArrayContracts.
// ArrayOf(itemDescriptor, {minItems?, maxItems?})` yields a descriptor for `Verify.that`/
// `CreateFieldDecorator`, exactly as the number/string/enum namespaces expose theirs; the flat
// `ArrayOf` parameter *decorator* below wraps the same rule. The item rides as serialised data.
import * as ArrayContracts from './src/Contracts/array';
// `@Dictionary` (DEC-054) and `@Shape` (DEC-055) live here — the object compositional descriptors.
// `ObjectContracts.Dictionary(valueDescriptor)` yields an open-map descriptor for `Verify.that`/
// `CreateFieldDecorator`, exactly as the array namespace exposes `ArrayOf`.
import * as ObjectContracts from './src/Contracts/object';
// `@Nullable` (DEC-056) — the compositional null-widening combinator. `NullableContracts.Nullable(inner)`
// yields a descriptor usable directly (`Verify.that`, `CreateFieldDecorator`, an `@ArrayOf` item).
import * as NullableContracts from './src/Contracts/nullable';

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
    // String formats (IDEA-23) — VALIDATING, never annotate-only. Each is a real descriptor with a
    // total, strict predicate and projects to {type:'string', format:'uuid'|'date-time'|'ipv4'} (the
    // predicate is at-least-as-strict as the format keyword, so the emitted `format` never over-claims —
    // DEC-029). @Format(name) is a keyed alias over the same three; an unknown name throws at decoration.
    Uuid, DateTime, Ipv4, Format,
    // @OneOf (IDEA-21/GAP-14) — a reified enum/membership constraint, type-agnostic. Projects to a
    // JSON Schema `{enum:[…]}` (the LLM constrained-decoding target), a real docs line, and a sound
    // `fc.constantFrom` fuzzer. The descriptor is `EnumContracts.OneOf` below.
    OneOf,
    // @Const (DEC-056) — the single-literal sibling of `@OneOf`: `value === v`, projecting to the exact
    // `{const: v}` keyword. The descriptor is `EnumContracts.Const` below (it rides the enum namespace).
    Const,
    // @ArrayOf (DEC-050/IDEA-22/GAP-15) — the first COMPOSITIONAL constraint: a list whose every
    // element satisfies an inner descriptor carried as serialised data. Projects to a JSON Schema
    // `{type:'array', items:<item schema>, minItems?, maxItems?}` inheriting the item's own fragment,
    // a real docs line, and a sound recursive `fc.array` fuzzer. The descriptor is `ArrayContracts.
    // ArrayOf` below; nests (`@ArrayOf(ArrayContracts.ArrayOf(...))`) and round-trips through JSON.
    ArrayOf,
    // @Dictionary (DEC-054) — the OPEN-map compositional constraint: `Record<string, V>`, every value
    // satisfying an inner descriptor carried as serialised data. Projects to `{type:'object',
    // additionalProperties:<value fragment>}` (open by construction) — the shape a `Record<string,string>`
    // tool argument needs. The descriptor is `ObjectContracts.Dictionary` below.
    Dictionary,
    // @Shape (DEC-055) — the CLOSED-DTO compositional constraint: an object validated against another
    // class's `@Contract`ed instance fields, read as serialised data at authoring time (DEC-007). Projects
    // descriptively to `{type:'object', properties}`; `toolSchemaForMethod` tightens it recursively to
    // `required` + `additionalProperties:false`. The descriptor is `ObjectContracts.Shape` below.
    Shape,
    // @Nullable (DEC-056) — the compositional combinator that widens any constraint to also accept `null`
    // (distinct from `@Optional`'s "may be absent"). Projects to the item fragment with `null` added to
    // its `type` (or an `anyOf` union). The descriptor is `NullableContracts.Nullable` below.
    Nullable,

    // Field decorators
    Enforce,
    CreateFieldDecorator,
    installFieldContracts,

    // Sensitive marker (record-only; DEC-PII-1/2). Marks data as sensitive for the build-time
    // detector and a future exposure report — it does not redact. See docs/sensitive.md.
    Sensitive,

    // Contract markers (DEC-051), record-only + enforcement-aware. @Optional makes an absent (undefined)
    // argument satisfy the position and drops it from the tool schema's `required`; @Default annotates a
    // JSON default ({default}, non-asserting) and implies @Optional. Inheritance is required-wins so a
    // subclass cannot silently weaken (DEC-016/DEC-022); adorn annotates the default, it does not inject it.
    Optional, Default,

    // Description markers (Q-30), record-only + posture-neutral (pure annotation, never rejects). @Describe
    // is a parameter description (→ the property's `description`); @Tool is a method/tool description (→ the
    // schema's top-level `description`, overridden by the toolSchemaForMethod({description}) option). Both
    // also flow into docs. A @Tool-only method with no constrained params still projects (the S1 union).
    Describe, Tool,

    // Imperative assertion
    Verify,

    // Method decorators
    Log, Time, setTimingSink,
    // @Observe (O1c) — span + duration + disclosed-value observability sugar over the shared
    // ObservationBehavior; carries the declared SpanKind ({kind}, default 'internal') and the detail dial.
    Observe,

    // @Telemetry (O1c) — the per-parameter/return value-disclosure opt-in on the observation record path.
    // Record-only (the @Sensitive twin): .value()/.redact(strategy)/.result(). @Sensitive vetoes, surfaced.
    Telemetry,

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
    // `@Requires((...args)=>bool)` (DEC-057) — cross-parameter preconditions, the `pre` closure band's
    // first writer. Enforced before the call (caller-blamed), consumed by a fuzzer as an argument filter;
    // like `@Ensures` it is a closure, so it is enforced-but-UNPROJECTABLE (emits nothing to docs/schema).
    Requires,

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
    // `setObservationVerbosity` (O1c) is the 'normal'|'detailed' dial gating `detail`-level observations.
    setEnforcementMode, setAssertEnforcement, setDefaultTrust,
    disableGuardEnforcement, enableGuardEnforcement, setViolationPolicy,
    setObservationVerbosity,

    // Value disclosure (DEC-030). @Log and violation messages redact values by default;
    // setValueDisclosure('all') opts in for local debugging. @Sensitive always vetoes.
    setValueDisclosure, getValueDisclosure,

    // Observability (O1). Install one around-shaped ObservationSink and read it; the enforcement weave
    // emits value-free violation facts + completions through it, and @Observe (O1c) opens the scope and
    // emits completions carrying the pre-disclosed values (redacted by default — "seeing ≠ emitting").
    // `settle` is the shared sync/thenable/observable settling classifier @Time now rides and an
    // @adorn/otel adapter (DEC-019) ends spans with. `RETURN_INDEX` marks the return value in an
    // EmittedValue. `consoleObservationSink` is a ready-made zero-dep JSON-to-console sink (opt-in; never
    // installed automatically). NOOP_SINK / ViolationError stay internal.
    setObservationSink, getObservationSink, settle, RETURN_INDEX, consoleObservationSink,

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
    getEffectivePostconditions, getEffectivePreconditions,

    // The postcondition oracle — the same evaluator the runtime wrapper runs, exposed so a
    // fuzzer (Phase B) checks exactly what enforcement enforces. `evaluatePreconditions` is its
    // input-side twin (DEC-057): a fuzzer filters generated args through the same function enforcement runs.
    evaluatePostconditions, evaluatePreconditions,

    // Projections: documentation generated from recorded contracts
    documentClass, documentContracts, renderMarkdown, generateMarkdown,

    // Projections: JSON Schema (draft 2020-12) generated from recorded contracts
    schemaForClass, schemaForContracts, serializeSchema, generateSchema,

    // Projection: the PRESCRIPTIVE LLM tool-call schema for ONE method (IDEA-20/DEC-048). A sibling of
    // schemaForClass, not a flag on it: params-as-object and tight (required + additionalProperties:false)
    // where schemaForClass is a descriptive instance schema that under-claims. Reuses schema.ts's merge
    // internals (no fork, DEC-010); Core+Contracts only (DEC-012). `@OneOf` flows in as `{enum:[…]}`.
    toolSchemaForMethod,

    // Projections: telemetry disclosure (O1d) — the "what leaves the process" privacy-review table.
    // A pure registry read (DEC-012) that reports the disclosure each position carries and renders its
    // own scanned denominator; it makes no claim about runtime flows.
    telemetryForClass, telemetryForContracts, serializeTelemetry, generateTelemetryReport,

    // Constraint descriptors (data, not decorators). `ArrayContracts` (DEC-050) is the compositional
    // one — its `ArrayOf` takes another descriptor as its item.
    NumberContracts, StringContracts, EnumContracts, ArrayContracts, ObjectContracts, NullableContracts,
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
