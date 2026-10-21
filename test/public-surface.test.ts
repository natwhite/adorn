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
import * as schema from '../schema';
import * as introspection from '../introspection';
import * as observe from '../observe';
import * as privacy from '../privacy';

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
    'getEffectiveEnablednessGuards',
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
    'recordEnablednessGuard',
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
    'getEnablednessKeys',
    'getEffectiveEnablednessKeys',
    'getEffectiveReturnConstraints',
] as const;

describe('Q-6 + DEC-097: the registry READ surface is frozen, now on `adorn/introspection`', () => {
    it.each(PUBLIC_REGISTRY_READS)('exports the public registry read %s from adorn/introspection', name => {
        // The reads moved OFF the root barrel in the DEC-097 curation into `adorn/introspection`. Present AND
        // callable — a read demoted to a non-function (or dropped) is a breaking change the projections and the
        // `adorn` binary would only discover at runtime.
        expect(introspection).toHaveProperty(name);
        expect(typeof (introspection as Record<string, unknown>)[name]).toBe('function');
        // And gone from the root — the curation's whole point.
        expect(adorn).not.toHaveProperty(name);
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
    //
    // 99 → 100: `nextCallId` (DEC-077, voice-agent) — the shared correlation-id sequence a consumer's OWN
    // non-decorator observation emitter must draw from, so its `callId`s never collide with adorn's (which now
    // matters because `createOtelSink` keys retained parent spans by `callId` — DEC-076). Formerly internal.
    //
    // 100 → 101: `contractSpecOf` (DEC-084, voice-agent L19) — recover the `ContractSpec` a `contract()`
    // wrapper enforces, so the spec is no longer closure-captured and unreadable. It makes a functional
    // contract introspectable and, in particular, lets `@adorn/test`'s new `fuzzFunction` read the spec off
    // the wrapper and fuzz it as `fuzzMethod` fuzzes a class method. `contractMetaOf` (the richer read that
    // also exposes the raw target) stays package-internal. (The owner has waived the pre-publish surface
    // freeze; this pin now tracks the surface rather than fencing it — DEC-079 note, Round 5.)
    //
    // 101 → 104: `@EnabledWhen` state-reading enabledness guards (DEC-089) add THREE value exports — the
    // `@EnabledWhen` method decorator, the public inheritance-aware read `getEffectiveEnablednessGuards`,
    // and the `evaluateEnabledness` oracle (the same function enforcement runs against a live receiver, the
    // future stateful-sequence driver's enabledness check). Its writer (`recordEnablednessGuard`) and the
    // `*EnablednessKeys` helpers stay internal, exactly like the `@Requires` band.
    // `EnablednessResult`/`EnablednessGuard`/`EnablednessPredicate` are type-only and do not count.
    //
    // 104 → 106: axiform feedback (2026-10-18) adds TWO value exports — `constraintFromJSON` (§8, the
    // rehydration half of the `toJSON()` round-trip, formerly internal) and the `BooleanContracts` namespace
    // (§3, the bare boolean primitive type). The number/string primitives `NumberContracts.Finite` and
    // `StringContracts.Str` (§3) ride the EXISTING namespaces, so they move nothing; `SerializedConstraint`
    // is type-only. (The verdict surface — `contract.checked`, §1 — is a property on the existing `contract`
    // function, not a new root export, and the `ContractVerdict` type is type-only: neither moves the count.)
    //
    // 106 → 107: the fluent facade (DEC-094, GPT review) adds ONE value export — `Contracts`, a lowercase,
    // type-grouped re-grouping of the SAME `*Contracts` descriptor factories (no new descriptors; every member
    // is a reference to an existing factory, only a second spelling). The underlying namespaces stay exported,
    // so this is purely additive. `ToolSchemaProvider`/`ProviderProfileOptions` (DEC-093, the `providerStrict`
    // → `{ provider, strict }` profile) are type-only and move nothing.
    //
    // 107 → 69: the DEC-097 surface curation moved 38 value exports OFF the root barrel into subpaths —
    // `adorn/schema` (10 projection fns: documentClass / documentContracts / renderMarkdown / generateMarkdown
    // / schemaForClass / schemaForContracts / serializeSchema / generateSchema / toolSchemaForMethod /
    // toolSchemaFrom), `adorn/privacy` (4: telemetryForClass / telemetryForContracts / serializeTelemetry /
    // generateTelemetryReport), `adorn/introspection` (17: 7 registry reads + 7 getEffective* +
    // evaluatePostconditions / evaluatePreconditions / evaluateEnabledness), and `adorn/observe` (7:
    // getObservationSink / RETURN_INDEX / nextCallId / settle / consoleObservationSink /
    // createConsoleObservationSink / violationFromCheck). The root keeps the authoring surface (decorators,
    // descriptor factories + Contracts, contract / Verify, config setters); `setObservationSink` stays on root
    // (a configuration verb). The per-subpath surfaces are pinned in their own block below.
    const PINNED_VALUE_EXPORT_COUNT = 69;

    it('the root index exposes exactly the frozen number of value exports', () => {
        expect(Object.keys(adorn)).toHaveLength(PINNED_VALUE_EXPORT_COUNT);
    });
});

describe('axiform feedback (2026-10-18) adds exactly its intended exports', () => {
    const api = adorn as Record<string, any>;
    it('exports constraintFromJSON — the rehydration half of the JSON round-trip (§8)', () => {
        expect(typeof api.constraintFromJSON).toBe('function');
        // Round-trips a serialised descriptor back to an enforceable one.
        const revived = api.constraintFromJSON(JSON.parse(JSON.stringify(adorn.NumberContracts.Between(1, 7))));
        expect(revived.predicate(5)).toBe(true);
        expect(revived.predicate(9)).toBe(false);
    });
    it('exports the BooleanContracts namespace with a Bool() primitive (§3)', () => {
        expect(typeof api.BooleanContracts).toBe('object');
        expect(typeof api.BooleanContracts.Bool).toBe('function');
        const bool = api.BooleanContracts.Bool();
        expect(bool.predicate(true)).toBe(true);
        expect(bool.predicate('true')).toBe(false);
    });
    it('adds the number/string primitives to the EXISTING namespaces (§3, count-neutral)', () => {
        expect(typeof adorn.NumberContracts.Finite).toBe('function');
        expect(typeof adorn.StringContracts.Str).toBe('function');
        expect(adorn.NumberContracts.Finite().predicate(1.5)).toBe(true);
        expect(adorn.NumberContracts.Finite().predicate(Infinity)).toBe(false);
        expect(adorn.StringContracts.Str().predicate('')).toBe(true);
        expect(adorn.StringContracts.Str().predicate(0)).toBe(false);
    });
    it('exposes contract.checked as a PROPERTY on contract, not a new root export (§1)', () => {
        expect(typeof (api.contract as Record<string, unknown>).checked).toBe('function');
        expect(Object.keys(adorn)).not.toContain('checked'); // rides `contract`; moves no count
    });
});

describe('the fluent facade adds exactly its intended public export (DEC-094)', () => {
    const api = adorn as Record<string, any>;
    it('exports the Contracts facade object', () => {
        expect(typeof api.Contracts).toBe('object');
    });
    it('maps grouped lowercase names to the SAME descriptor factories (no drift, only a second spelling)', () => {
        // Reference equality: every facade member IS the namespace factory, so there is no second
        // implementation that could drift — the facade is a re-spelling, not a reimplementation.
        expect(api.Contracts.number.between).toBe(adorn.NumberContracts.Between);
        expect(api.Contracts.number.finite).toBe(adorn.NumberContracts.Finite);
        expect(api.Contracts.string.notEmpty).toBe(adorn.StringContracts.NotEmpty);
        expect(api.Contracts.string.uuid).toBe(adorn.StringContracts.Uuid);
        expect(api.Contracts.bool).toBe(adorn.BooleanContracts.Bool);
        expect(api.Contracts.enum).toBe(adorn.EnumContracts.OneOf);
        expect(api.Contracts.const).toBe(adorn.EnumContracts.Const);
        expect(api.Contracts.array).toBe(adorn.ArrayContracts.ArrayOf);
        expect(api.Contracts.nullable).toBe(adorn.NullableContracts.Nullable);
        expect(api.Contracts.dictionary).toBe(adorn.ObjectContracts.Dictionary);
        expect(api.Contracts.object).toBe(adorn.ObjectContracts.Fields);
        expect(api.Contracts.shape).toBe(adorn.ObjectContracts.Shape);
    });
    it('produces working descriptors identical to the namespace factories', () => {
        const viaFacade = api.Contracts.number.between(1, 7);
        const viaNamespace = adorn.NumberContracts.Between(1, 7);
        expect(viaFacade.predicate(5)).toBe(true);
        expect(viaFacade.predicate(9)).toBe(false);
        expect(JSON.stringify(viaFacade)).toBe(JSON.stringify(viaNamespace));
    });
});

describe('voice-agent Round 3 adds exactly its intended functional-surface exports (DEC-074)', () => {
    it('exports violationFromCheck (L11)', () => {
        expect(typeof (observe as Record<string, unknown>).violationFromCheck).toBe('function');
    });
    it('exports createConsoleObservationSink (L12)', () => {
        expect(typeof (observe as Record<string, unknown>).createConsoleObservationSink).toBe('function');
    });
    it('exports the contract() functional wrapper (L9)', () => {
        expect(typeof (adorn as Record<string, unknown>).contract).toBe('function');
    });
    it('exports nextCallId — the shared correlation-id sequence for a consumer emitter (DEC-077)', () => {
        const nextCallId = (observe as Record<string, unknown>).nextCallId as () => number;
        expect(typeof nextCallId).toBe('function');
        // Monotonic: each call yields a strictly greater id (the property that prevents cross-emitter collision).
        expect(nextCallId()).toBeLessThan(nextCallId());
    });
    it('exports contractSpecOf — a contract() wrapper is now introspectable (DEC-084, L19)', () => {
        const {contract, contractSpecOf} = adorn as Record<string, unknown> as {
            contract: (spec: unknown, fn: unknown) => unknown;
            contractSpecOf: (fn: unknown) => unknown;
        };
        expect(typeof contractSpecOf).toBe('function');
        const spec = {};
        const wrapped = contract(spec, (x: unknown) => x);
        expect(contractSpecOf(wrapped)).toBe(spec); // the exact spec, read back off the wrapper
        expect(contractSpecOf((x: unknown) => x)).toBeUndefined(); // a plain function has none
    });
});

describe('the tool-schema wave adds exactly its intended public exports (DEC-048)', () => {
    // The other half of the deliberate-change signal: the count moved *because these three landed*,
    // not because something unrelated leaked. Each is asserted present and of the right runtime shape.
    it('exports the @OneOf parameter decorator (IDEA-21/GAP-14)', () => {
        expect(typeof (adorn as Record<string, unknown>).OneOf).toBe('function');
    });

    it('exports the toolSchemaForMethod projection (IDEA-20)', () => {
        expect(typeof (schema as Record<string, unknown>).toolSchemaForMethod).toBe('function');
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
        const nullableContracts = (adorn as Record<string, unknown>).NullableContracts as Record<
            string,
            unknown
        >;
        expect(typeof nullableContracts).toBe('object');
        expect(typeof nullableContracts.Nullable).toBe('function');
    });
});

describe('round-3 adds exactly its intended public exports (DEC-059/060/061)', () => {
    it('exports the descriptor-first toolSchemaFrom projection (IDEA-30/DEC-061) — the +1 to 95', () => {
        expect(typeof (schema as Record<string, unknown>).toolSchemaFrom).toBe('function');
    });
});

describe('@Requires cross-parameter preconditions add exactly their intended public exports (DEC-057)', () => {
    // The +3 (91→94): the @Requires decorator, the getEffectivePreconditions read, the evaluatePreconditions
    // oracle. The write surface (recordPrecondition) and *PreconditionKeys helpers stay internal (Q-6).
    it('exports the @Requires method decorator', () => {
        expect(typeof (adorn as Record<string, unknown>).Requires).toBe('function');
    });

    it('exports the evaluatePreconditions oracle (the fuzzer arg filter)', () => {
        expect(typeof (introspection as Record<string, unknown>).evaluatePreconditions).toBe('function');
    });

    it('keeps the precondition writer and key helpers OFF the root surface (Q-6)', () => {
        expect(adorn).not.toHaveProperty('recordPrecondition');
        expect(adorn).not.toHaveProperty('getPreconditionKeys');
        expect(adorn).not.toHaveProperty('getEffectivePreconditionKeys');
        expect(adorn).not.toHaveProperty('getPreconditions');
    });
});

describe('@EnabledWhen enabledness guards add exactly their intended public exports (DEC-089)', () => {
    // The +3 (101→104): the @EnabledWhen decorator, the getEffectiveEnablednessGuards read, the
    // evaluateEnabledness oracle. The write surface (recordEnablednessGuard) and *EnablednessKeys helpers
    // stay internal (Q-6), exactly as the @Requires band.
    it('exports the @EnabledWhen method decorator', () => {
        expect(typeof (adorn as Record<string, unknown>).EnabledWhen).toBe('function');
    });

    it('exports the evaluateEnabledness oracle (the sequence driver enabledness check)', () => {
        expect(typeof (introspection as Record<string, unknown>).evaluateEnabledness).toBe('function');
    });

    it('exports the getEffectiveEnablednessGuards inheritance-aware read', () => {
        expect(typeof (introspection as Record<string, unknown>).getEffectiveEnablednessGuards).toBe('function');
    });

    it('keeps the enabledness writer and key helpers OFF the root surface (Q-6)', () => {
        expect(adorn).not.toHaveProperty('recordEnablednessGuard');
        expect(adorn).not.toHaveProperty('getEnablednessKeys');
        expect(adorn).not.toHaveProperty('getEffectiveEnablednessKeys');
        expect(adorn).not.toHaveProperty('getEnablednessGuards');
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

describe('DEC-097 surface curation: the subpaths carry exactly what the root shed', () => {
    const notOnRoot = (name: string) => expect(adorn).not.toHaveProperty(name);

    it('adorn/schema exports the projections, and the root does not', () => {
        for (const name of [
            'documentClass', 'documentContracts', 'renderMarkdown', 'generateMarkdown',
            'schemaForClass', 'schemaForContracts', 'serializeSchema', 'generateSchema',
            'toolSchemaForMethod', 'toolSchemaFrom',
        ]) {
            expect(typeof (schema as Record<string, unknown>)[name]).toBe('function');
            notOnRoot(name);
        }
    });

    it('adorn/privacy exports the telemetry projection, and the root does not', () => {
        for (const name of ['telemetryForClass', 'telemetryForContracts', 'serializeTelemetry', 'generateTelemetryReport']) {
            expect(typeof (privacy as Record<string, unknown>)[name]).toBe('function');
            notOnRoot(name);
        }
    });

    it('adorn/introspection exports the reads + evaluators, and the root does not', () => {
        for (const name of ['evaluatePostconditions', 'evaluatePreconditions', 'evaluateEnabledness', 'getContractsForClass', 'getEffectiveContract']) {
            expect(typeof (introspection as Record<string, unknown>)[name]).toBe('function');
            notOnRoot(name);
        }
    });

    it('adorn/observe exports the observation plumbing, and the root does not', () => {
        for (const name of ['getObservationSink', 'nextCallId', 'settle', 'createConsoleObservationSink', 'violationFromCheck']) {
            expect(typeof (observe as Record<string, unknown>)[name]).toBe('function');
            notOnRoot(name);
        }
        // consoleObservationSink is a ready-made sink INSTANCE (an object), not a factory; RETURN_INDEX is a const.
        expect((observe as Record<string, unknown>).consoleObservationSink).toBeDefined();
        notOnRoot('consoleObservationSink');
        expect((observe as Record<string, unknown>).RETURN_INDEX).toBeDefined();
        notOnRoot('RETURN_INDEX');
    });

    it('setObservationSink stays on the root — a configuration verb, not observation plumbing', () => {
        expect(typeof (adorn as Record<string, unknown>).setObservationSink).toBe('function');
        // And it is NOT re-exported from adorn/observe (reading the sink is; installing it is a root config verb).
        expect(observe).not.toHaveProperty('setObservationSink');
    });
});
