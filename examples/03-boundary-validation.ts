/**
 * Boundary validation without decorators — `Verify.check` / `Verify.that`.
 *
 * The non-decorator half of adorn: a plain function call that validates an `unknown` against a
 * descriptor and hands back a typed value or a localized failure — no class, no decoration point.
 * This is what an HTTP handler or an LLM tool-call boundary uses.
 *
 *   Run:  npx ts-node examples/03-boundary-validation.ts
 *   (In your own project the import is `from 'adorn'`.)
 */
import {Verify, ObjectContracts, ArrayContracts, StringContracts, NullableContracts, EnumContracts} from '../index';

// A compositional descriptor: an object with a required non-empty name, a list of at-least-one
// role (each from a fixed set), and an optional (nullable) note.
const memberShape = ObjectContracts.Fields({
    name: StringContracts.NotEmpty(),
    roles: ArrayContracts.ArrayOf(EnumContracts.OneOf(['admin', 'editor', 'viewer']), {minItems: 1}),
    note: NullableContracts.Nullable(StringContracts.NotEmpty()),
});

console.log('=== Verify.check — a valid value ===');
const ok = Verify.check(memberShape, 'member', {name: 'Ada', roles: ['admin', 'viewer'], note: null});
console.log(JSON.stringify(ok)); // { ok: true, value: {...} }  — `value` is typed to the exact shape

console.log('\n=== Verify.check — a bad *element* is localized (path + expected) ===');
const bad = Verify.check(memberShape, 'member', {name: 'Ada', roles: ['admin', 'wizard'], note: null});
console.log(JSON.stringify(bad));
// { ok:false, path:['roles',1], expected:'one of "admin", "editor", "viewer"', message:... }
// The failing ELEMENT is named — not a container-level "expected an array".

console.log('\n=== Verify.check — a missing required field ===');
console.log(JSON.stringify(Verify.check(memberShape, 'member', {roles: ['admin']})));

console.log('\n=== Verify.that — throw instead of returning a result ===');
try {
    Verify.that(StringContracts.NotEmpty(), 'apiKey', '');
} catch (e) {
    console.log('threw:', (e as Error).message);
}

// The SAME descriptor drives a JSON Schema and (via toolSchemaFrom) an LLM tool schema — one
// declaration, every artifact. See examples 01 and 02.
