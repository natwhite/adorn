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
    // Postcondition + reified-return bands
    'recordPostcondition',
    'recordReturnConstraint',
    // Sensitivity band (DEC-PII-1/2)
    'recordFieldSensitivity',
    'recordParameterSensitivity',
    'recordClassSensitivity',
    // Telemetry-disclosure band (O1c, DEC-036)
    'recordParameterTelemetry',
    'recordReturnTelemetry',
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
    const PINNED_VALUE_EXPORT_COUNT = 77;

    it('the root index exposes exactly the frozen number of value exports', () => {
        expect(Object.keys(adorn)).toHaveLength(PINNED_VALUE_EXPORT_COUNT);
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
