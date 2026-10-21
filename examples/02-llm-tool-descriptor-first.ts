/**
 * LLM tools whose permitted values are known only at RUNTIME.
 *
 * A decorator is fixed when the module loads, so `@OneOf(['celsius','fahrenheit'])` only works for a
 * STATIC set. When the allowed values are per-call data — this session's available slots, this
 * household's ids — build the same tool schema from descriptors instead. One `const` feeds both the
 * schema the model reads and the validator its reply faces.
 *
 *   Run:  npx ts-node examples/02-llm-tool-descriptor-first.ts
 */
import {Verify, ObjectContracts, StringContracts, EnumContracts, NumberContracts, NullableContracts} from '../index';
import {toolSchemaFrom} from '../schema'; // in your own project: `from 'adorn/schema'`

// Per-session data — the slots THIS caller can book, known only now:
const availableSlots = ['fri-1000', 'fri-1400', 'thu-0900'];

// Declare the argument shape ONCE, as data:
const bookingArgs = {
    slotId: EnumContracts.OneOf(availableSlots), // a runtime enum no decorator could express
    partySize: NumberContracts.Between(1, 8),
    name: StringContracts.NotEmpty(),
};

// 1. The schema the model reads:
console.log('=== toolSchemaFrom (per-session) ===');
console.log(
    JSON.stringify(
        toolSchemaFrom({name: 'book', description: 'Book an available slot.', params: bookingArgs}),
        null,
        2,
    ),
);

// 2. Validate the model's reply against the SAME descriptors — one source, cannot drift:
console.log('\n=== the model replies with a real slot ===');
console.log(
    JSON.stringify(
        Verify.check(ObjectContracts.Fields(bookingArgs), 'args', {
            slotId: 'fri-1000',
            partySize: 2,
            name: 'Ada',
        }),
    ),
);

console.log('\n=== the model hallucinates a slot that was never offered ===');
console.log(
    JSON.stringify(
        Verify.check(ObjectContracts.Fields(bookingArgs), 'args', {
            slotId: 'mon-0800',
            partySize: 2,
            name: 'Ada',
        }),
    ),
);

// 3. OpenAI strict mode: every property required + closed at every level. An "optional" field is
// declared Nullable(...) (the model sends null), so schema and validator both accept it — no drift.
console.log('\n=== providerStrict: true ===');
const strict = toolSchemaFrom(
    {
        name: 'scheduleReminder',
        params: {
            patientId: StringContracts.Uuid(),
            note: NullableContracts.Nullable(StringContracts.NotEmpty()),
        },
    },
    {providerStrict: true},
);
console.log(JSON.stringify(strict, null, 2));
