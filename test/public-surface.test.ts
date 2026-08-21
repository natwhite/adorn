/**
 * Q-6, the freeze — the registry read/write boundary, made mechanical (DEC-039).
 *
 * Q-6 asked which of the registry's exported functions are the semver-frozen public API and which
 * stay internal plumbing. Every projection and now a shipped binary (`adorn docs`/`schema`/`check`)
 * binds to the READ surface, so it is frozen: the reads below are guaranteed present. The WRITERS and
 * the `*Keys` enumeration helpers are the other half of the ruling — they stay internal *permanently*,
 * because exporting one would let a caller bypass the adapter that owns declaration ordering (SMELL-13)
 * and installation, writing contracts the enforcement path never sees. See `index.ts`'s "Registry
 * introspection" comment and `ContractRegistry.ts`.
 *
 * This file makes the boundary executable, so drift in EITHER direction fails CI: a read silently
 * dropped from the root, or a writer/`*Keys` helper leaking onto it. It is the twin of
 * `addons/test/isolation.test.ts` (which freezes the add-on OUT of the surface); this one freezes the
 * registry boundary WITHIN it.
 */

import * as adorn from '../index';

// The public registry READ surface (index.ts's "Registry introspection" + "Inheritance-aware reads"
// sections). Enumerated from index.ts's export block, not guessed — every name here is exported there.
const PUBLIC_REGISTRY_READS = [
    // Own-scoped reads — "what does this target declare".
    'getContracts',
    'getContract',
    'getContractedClasses',
    'getContractsForClass',
    'getFieldContract',
    'getFieldContracts',
    'getFieldContractsForClass',
    // Inheritance-aware reads (DEC-021 fields, DEC-022 methods) — "what is in force here".
    'getEffectiveFieldConstraints',
    'getEffectiveFieldContract',
    'getEffectiveContract',
    'getEffectiveParameterConstraints',
    'getEffectivePostconditions',
    'getEffectivePreconditions',
] as const;

// The registry WRITERS. Every one is `export function` in ContractRegistry.ts and every one is
// deliberately absent from index.ts's export block — a caller with a writer could record a contract
// the installer never wraps and the enforcement path never sees. Enumerated from ContractRegistry.ts's
// "Writes" sections (record*/set*Metadata/mark*/register*) plus the two mutating configuration/test
// entries, none of which belong on a consumer's surface.
const INTERNAL_REGISTRY_WRITERS = [
    // Method / parameter band
    'recordParameterConstraint',
    'setParameterMetadata',
    'markInstalled',
    // Field band
    'recordFieldConstraint',
    'setFieldMetadata',
    'markFieldInstalled',
    // Pre/postcondition + reified-return bands
    'recordPostcondition',
    'recordPrecondition',
    'recordReturnConstraint',
    // Sensitivity band (DEC-PII-1/2)
    'recordFieldSensitivity',
    'recordParameterSensitivity',
    'recordClassSensitivity',
    // Telemetry-disclosure band (O1c, DEC-036)
    'recordParameterTelemetry',
    'recordReturnTelemetry',
    // @Optional / @Default band (DEC-051)
    'recordParameterOptional',
    'recordParameterDefault',
    // @Describe / @Tool description band (Q-30)
    'recordParameterDescription',
    'recordMethodDescription',
    // Enumerable-registry + configuration/test-support mutators
    'registerContractedClass',
    'setClassEnumerationEnabled',
    'resetRegistry',
] as const;

// The `*Keys` enumeration helpers and the return-constraint reader index.ts names as deliberately NOT
// exported: they are installer/projection plumbing, and Q-6 makes every registry export semver-relevant.
// A projection reads `getEffectiveContract().post` / `getContractsForClass`, not these.
const INTERNAL_KEY_HELPERS = [
    'getEffectiveContractKeys',
    'getPostconditionKeys',
    'getEffectivePostconditionKeys',
    'getPreconditionKeys',
    'getEffectivePreconditionKeys',
    'getEffectiveReturnConstraints',
] as const;

describe('Q-6: the registry READ surface is frozen public API', () => {
    it.each(PUBLIC_REGISTRY_READS)('exports the public registry read %s', name => {
        // Present AND callable — a read demoted to a non-function (or dropped) is a breaking change
        // that the projections and the `adorn` binary would only discover at runtime.
        expect(adorn).toHaveProperty(name);
        expect(typeof (adorn as Record<string, unknown>)[name]).toBe('function');
    });
});

describe('Q-6: the registry WRITE surface stays internal', () => {
    it.each(INTERNAL_REGISTRY_WRITERS)('does NOT export the registry writer %s', name => {
        // A leaked writer lets a caller bypass the adapter that owns declaration ordering (SMELL-13)
        // and installation — writing contracts the enforcement path never sees.
        expect(adorn).not.toHaveProperty(name);
    });

    it.each(INTERNAL_KEY_HELPERS)('does NOT export the internal helper %s', name => {
        expect(adorn).not.toHaveProperty(name);
    });
});

describe('Q-6: the whole value-export surface is pinned', () => {
    // A tripwire, NOT a hard rule (cf. addons/test/isolation.test.ts's reasoning about magic counts).
    // Unlike the add-on isolation test — where core exports grow with every honest feature and a pinned
    // count would fail on each — this surface is the one Q-6 froze: adding or removing a public export
    // is a deliberate, semver-relevant act. This number is that act's signal. If a change to index.ts
    // moves it, that is expected — update this constant IN THE SAME COMMIT and note the surface change,
    // rather than treating the failure as noise. Type-only exports don't count (they erase at runtime).
    //
    // 72 → 75: the tool-schema wave (DEC-048) deliberately adds three value exports — the `@OneOf`
    // parameter decorator (IDEA-21/GAP-14), the `toolSchemaForMethod` projection (IDEA-20), and the
    // `EnumContracts` descriptor namespace. `ToolSchema`/`ToolSchemaOptions` are type-only and do not
    // count. This is exactly the deliberate-change signal DEC-039 designed the count to be.
    //
    // 75 → 77: contract-offering Wave 1 Slice A (DEC-050/IDEA-22/GAP-15) adds the `@ArrayOf` parameter
    // decorator and the `ArrayContracts` descriptor namespace — the first compositional descriptor.
    // `ArrayOfParams` is type-only and does not count.
    //
    // 77 → 79: contract-offering Wave 1 Slice B (DEC-051, resolves Q-28) adds the `@Optional` and
    // `@Default` enforcement-aware parameter markers. Their registry bands' writers
    // (`recordParameterOptional`/`recordParameterDefault`) and reads stay internal — only the two
    // decorators join the surface.
    //
    // 79 → 85: contract-offering Wave 1 Slice C (Q-30 / IDEA-23) completes the wave with SIX value
    // exports — the `@Describe`/`@Tool` record-only description markers, and four validating string-format
    // parameter decorators `@Uuid`/`@DateTime`/`@Ipv4`/`@Format`. The format *descriptor* factories ride
    // the existing `StringContracts` namespace (no new namespace export); the description bands' writers
    // (`recordParameterDescription`/`recordMethodDescription`) and reads stay internal, like the other
    // marker bands. `@Format` is kept (not folded into the three named ones) for the string-keyed
    // ergonomics, a conscious +1.
    //
    // 85 → 87: Wave-2 object vocabulary, Slice 1 (DEC-054) adds the `@Dictionary` open-map parameter
    // decorator and the `ObjectContracts` descriptor namespace (the second compositional namespace after
    // `ArrayContracts`). `DictionaryParams` is type-only and does not count. The `@Shape` decorator lands
    // in the next slice (DEC-055) on the same `ObjectContracts` namespace, so only two exports here.
    //
    // 87 → 88: Wave-2 object vocabulary, Slice 2 (DEC-055) adds the `@Shape` closed-DTO parameter
    // decorator. It rides the EXISTING `ObjectContracts` namespace (`ShapeParams` is type-only), so only
    // one export moves the count.
    //
    // 88 → 91: Wave-2 polish (DEC-056) adds THREE value exports — the `@Const` single-literal decorator
    // (its `EnumContracts.Const` factory rides the existing enum namespace), the `@Nullable` combinator
    // decorator, and the `NullableContracts` descriptor namespace it lives in. `ConstParams`/`NullableParams`
    // are type-only and do not count.
    //
    // 91 → 94: @Requires cross-parameter preconditions (DEC-057) add THREE value exports — the `@Requires`
    // method decorator, the public inheritance-aware read `getEffectivePreconditions`, and the
    // `evaluatePreconditions` oracle (the fuzzer's arg filter). Its writer (`recordPrecondition`) and the
    // `*PreconditionKeys` helpers stay internal, like the postcondition band. `PreconditionResult` is
    // type-only.
    //
    // 94 → 95: round-3 IDEA-30/DEC-061 adds the descriptor-first `toolSchemaFrom` entry point.
    // `ToolSchemaFromInput`/`ToolParamSpec` are type-only and do not count; the phantom-output-type work
    // (DEC-059) and the `locate`/`path` work (DEC-060) are type-only / an added optional field and move nothing.
    //
    // 95 → 96: the P1+P2+P3 buildout (round-4) adds ONE value export — `defineConstraint` (Slice C), the
    // factory that builds a custom constraint from data (DEC-050); `ConstraintDescriptor` shipped as a type
    // only (GAP-22). Everything else in the buildout is count-neutral: `Fields` (Slice A) rides the existing
    // `ObjectContracts` namespace; `CheckResult.expected` + the `Localization` type (Slice B) are an added
    // optional field / type-only; the `providerStrict` option (Slice D) is type-only; and the authoring types
    // (`ConstraintDefinition`/`ConstraintKind`/`Predicate`/`ViolationContext`/`JsonObject`/`JsonValue`/
    // `ConstraintFactory`) are type-only. `getConstraintDefinition` stays internal (returns `<any>`).
    //
    // 96 → 99: voice-agent Round 3 (DEC-074) adds THREE value exports — `violationFromCheck` (L11, translate a
    // functional check failure into ViolationFacts for the observation stream), the `createConsoleObservationSink`
    // factory (L12, configurable console-sink stream), and `contract` (L9, the functional twin of the contract /
    // observation decorators). `CheckFailure` / `ContractSpec` are type-only and move nothing. (L10
    // `Verify.checkJson` was reverted on reflection — a JSON decode expands a validator's domain; DEC-074.)
    const PINNED_VALUE_EXPORT_COUNT = 99;

    it('the root index exposes exactly the frozen number of value exports', () => {
        expect(Object.keys(adorn)).toHaveLength(PINNED_VALUE_EXPORT_COUNT);
    });
});

describe('voice-agent Round 3 adds exactly its intended functional-surface exports (DEC-074)', () => {
    it('exports violationFromCheck (L11)', () => {
        expect(typeof (adorn as Record<string, unknown>).violationFromCheck).toBe('function');
    });
    it('exports createConsoleObservationSink (L12)', () => {
        expect(typeof (adorn as Record<string, unknown>).createConsoleObservationSink).toBe('function');
    });
    it('exports the contract() functional wrapper (L9)', () => {
        expect(typeof (adorn as Record<string, unknown>).contract).toBe('function');
    });
});

describe('the tool-schema wave adds exactly its intended public exports (DEC-048)', () => {
    // The other half of the deliberate-change signal: the count moved *because these three landed*,
    // not because something unrelated leaked. Each is asserted present and of the right runtime shape.
    it('exports the @OneOf parameter decorator (IDEA-21/GAP-14)', () => {
        expect(typeof (adorn as Record<string, unknown>).OneOf).toBe('function');
    });

    it('exports the toolSchemaForMethod projection (IDEA-20)', () => {
        expect(typeof (adorn as Record<string, unknown>).toolSchemaForMethod).toBe('function');
    });

    it('exports the EnumContracts descriptor namespace, carrying the oneOf factory', () => {
        const enumContracts = (adorn as Record<string, unknown>).EnumContracts as Record<string, unknown>;
        expect(typeof enumContracts).toBe('object');
        // The namespaced descriptor factory, the twin of NumberContracts.Between — usable directly in
        // Verify.that / CreateFieldDecorator.
        expect(typeof enumContracts.OneOf).toBe('function');
    });
});

describe('contract-offering Wave 1 Slice A adds exactly its intended public exports (DEC-050)', () => {
    // The +2 (75→77) moved *because these two landed* — the `@ArrayOf` compositional decorator and its
    // `ArrayContracts` descriptor namespace — not because something unrelated leaked.
    it('exports the @ArrayOf parameter decorator (IDEA-22/GAP-15)', () => {
        expect(typeof (adorn as Record<string, unknown>).ArrayOf).toBe('function');
    });

    it('exports the ArrayContracts descriptor namespace, carrying the arrayOf factory', () => {
        const arrayContracts = (adorn as Record<string, unknown>).ArrayContracts as Record<string, unknown>;
        expect(typeof arrayContracts).toBe('object');
        // The namespaced compositional descriptor factory, usable directly in Verify.that /
        // CreateFieldDecorator — its item is another descriptor (DEC-050).
        expect(typeof arrayContracts.ArrayOf).toBe('function');
    });
});

describe('contract-offering Wave 1 Slice B adds exactly its intended public exports (DEC-051)', () => {
    // The +2 (77→79) moved *because these two landed* — the `@Optional` and `@Default` enforcement-aware
    // parameter markers — not because something unrelated leaked.
    it('exports the @Optional parameter marker (DEC-051)', () => {
        expect(typeof (adorn as Record<string, unknown>).Optional).toBe('function');
    });

    it('exports the @Default parameter marker (DEC-051)', () => {
        expect(typeof (adorn as Record<string, unknown>).Default).toBe('function');
    });

    it('keeps the @Optional/@Default registry reads OFF the root surface (Q-6, like the other bands)', () => {
        // Enforcement + the tool schema read these internally; a consumer reads neither, exactly as the
        // sensitivity/telemetry effective reads stay internal.
        expect(adorn).not.toHaveProperty('getEffectiveParameterOptional');
        expect(adorn).not.toHaveProperty('getEffectiveParameterDefault');
        expect(adorn).not.toHaveProperty('getParameterOptional');
        expect(adorn).not.toHaveProperty('getParameterDefault');
    });
});

describe('contract-offering Wave 1 Slice C adds exactly its intended public exports (Q-30 / IDEA-23)', () => {
    // The +6 (79→85) moved *because these six landed* — the `@Describe`/`@Tool` description markers and
    // the four validating string-format decorators — not because something unrelated leaked.
    it('exports the @Describe parameter marker and the @Tool method marker (Q-30)', () => {
        expect(typeof (adorn as Record<string, unknown>).Describe).toBe('function');
        expect(typeof (adorn as Record<string, unknown>).Tool).toBe('function');
    });

    it('exports the @Uuid/@DateTime/@Ipv4/@Format string-format decorators (IDEA-23)', () => {
        expect(typeof (adorn as Record<string, unknown>).Uuid).toBe('function');
        expect(typeof (adorn as Record<string, unknown>).DateTime).toBe('function');
        expect(typeof (adorn as Record<string, unknown>).Ipv4).toBe('function');
        expect(typeof (adorn as Record<string, unknown>).Format).toBe('function');
    });

    it('exposes the format descriptor factories on the EXISTING StringContracts namespace (no new namespace)', () => {
        const stringContracts = (adorn as Record<string, unknown>).StringContracts as Record<string, unknown>;
        expect(typeof stringContracts.Uuid).toBe('function');
        expect(typeof stringContracts.DateTime).toBe('function');
        expect(typeof stringContracts.Ipv4).toBe('function');
        expect(typeof stringContracts.Format).toBe('function');
    });

    it('keeps the @Describe/@Tool registry reads and union helpers OFF the root surface (Q-6)', () => {
        // The tool-schema + docs projections read these internally, exactly as the sensitivity/telemetry
        // effective reads and `*KeysForClass` union helpers stay internal.
        expect(adorn).not.toHaveProperty('getEffectiveParameterDescription');
        expect(adorn).not.toHaveProperty('getEffectiveMethodDescription');
        expect(adorn).not.toHaveProperty('getParameterDescription');
        expect(adorn).not.toHaveProperty('getMethodDescription');
        expect(adorn).not.toHaveProperty('getDescriptionParameterIndices');
        expect(adorn).not.toHaveProperty('getDescriptionMethodKeysForClass');
    });
});

describe('Wave-2 object vocabulary Slice 1 adds exactly its intended public exports (DEC-054)', () => {
    // The +2 (85→87) moved *because these two landed* — the `@Dictionary` open-map decorator and the
    // `ObjectContracts` descriptor namespace — not because something unrelated leaked.
    it('exports the @Dictionary parameter decorator (DEC-054)', () => {
        expect(typeof (adorn as Record<string, unknown>).Dictionary).toBe('function');
    });

    it('exports the ObjectContracts descriptor namespace, carrying the dictionary factory', () => {
        const objectContracts = (adorn as Record<string, unknown>).ObjectContracts as Record<string, unknown>;
        expect(typeof objectContracts).toBe('object');
        // The namespaced open-map descriptor factory, usable directly in Verify.that / CreateFieldDecorator —
        // its value is another descriptor (DEC-050).
        expect(typeof objectContracts.Dictionary).toBe('function');
    });
});

describe('Wave-2 object vocabulary Slice 2 adds exactly its intended public exports (DEC-055)', () => {
    // The +1 (87→88) moved *because @Shape landed* — the closed-DTO decorator on the existing namespace.
    it('exports the @Shape parameter decorator (DEC-055)', () => {
        expect(typeof (adorn as Record<string, unknown>).Shape).toBe('function');
    });

    it('exposes the Shape descriptor factory on the EXISTING ObjectContracts namespace (no new namespace)', () => {
        const objectContracts = (adorn as Record<string, unknown>).ObjectContracts as Record<string, unknown>;
        expect(typeof objectContracts.Shape).toBe('function');
    });
});

describe('Wave-2 polish adds exactly its intended public exports (DEC-056)', () => {
    // The +3 (88→91) moved *because these landed* — @Const, @Nullable, and the NullableContracts namespace.
    it('exports the @Const and @Nullable parameter decorators', () => {
        expect(typeof (adorn as Record<string, unknown>).Const).toBe('function');
        expect(typeof (adorn as Record<string, unknown>).Nullable).toBe('function');
    });

    it('exposes Const on the EXISTING EnumContracts namespace (no new namespace)', () => {
        const enumContracts = (adorn as Record<string, unknown>).EnumContracts as Record<string, unknown>;
        expect(typeof enumContracts.Const).toBe('function');
    });

    it('exports the NullableContracts descriptor namespace, carrying the nullable factory', () => {
        const nullableContracts = (adorn as Record<string, unknown>).NullableContracts as Record<string, unknown>;
        expect(typeof nullableContracts).toBe('object');
        expect(typeof nullableContracts.Nullable).toBe('function');
    });
});

describe('round-3 adds exactly its intended public exports (DEC-059/060/061)', () => {
    it('exports the descriptor-first toolSchemaFrom projection (IDEA-30/DEC-061) — the +1 to 95', () => {
        expect(typeof (adorn as Record<string, unknown>).toolSchemaFrom).toBe('function');
    });
});

describe('@Requires cross-parameter preconditions add exactly their intended public exports (DEC-057)', () => {
    // The +3 (91→94): the @Requires decorator, the getEffectivePreconditions read, the evaluatePreconditions
    // oracle. The write surface (recordPrecondition) and *PreconditionKeys helpers stay internal (Q-6).
    it('exports the @Requires method decorator', () => {
        expect(typeof (adorn as Record<string, unknown>).Requires).toBe('function');
    });

    it('exports the evaluatePreconditions oracle (the fuzzer arg filter)', () => {
        expect(typeof (adorn as Record<string, unknown>).evaluatePreconditions).toBe('function');
    });

    it('keeps the precondition writer and key helpers OFF the root surface (Q-6)', () => {
        expect(adorn).not.toHaveProperty('recordPrecondition');
        expect(adorn).not.toHaveProperty('getPreconditionKeys');
        expect(adorn).not.toHaveProperty('getEffectivePreconditionKeys');
        expect(adorn).not.toHaveProperty('getPreconditions');
    });
});

describe('the P1+P2+P3 buildout adds exactly its intended public exports (round-4 §2.3)', () => {
    // The +1 (95→96) moved *because `defineConstraint` landed* — the custom-constraint factory (GAP-22 tail) —
    // not because something unrelated leaked.
    it('exports the defineConstraint factory', () => {
        expect(typeof (adorn as Record<string, unknown>).defineConstraint).toBe('function');
    });

    it('keeps getConstraintDefinition OFF the surface — it returns ConstraintDefinition<any>', () => {
        // The internal lookup that hands back an `<any>`-typed definition stays internal, so no `any` reaches
        // a consumer (round-4 §"Six for six" verified this).
        expect(adorn).not.toHaveProperty('getConstraintDefinition');
    });
});
