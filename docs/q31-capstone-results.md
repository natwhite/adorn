# Q-31 / Q-32 capstone — real generated schemas round-tripped through OpenAI

**Provider:** OpenAI `gpt-4o-mini` · **temperature:** 0. Schemas emitted by the REAL round-4 code
(`Fields`, `Nullable`, `toolSchemaFrom({providerStrict})`) and validated by the SAME descriptors.

| Case | HTTP | Schema accepted | Tool call | Args valid | Verdict |
| --- | --- | --- | --- | --- | --- |
| reminder — providerStrict + Nullable optional (the Slice-D headline) | 200 | yes | yes | true | ROUND-TRIP OK |
| book — a Fields param with an optional field (non-strict) | 200 | yes | yes | true | ROUND-TRIP OK |
| bookStrict — a Fields param, ALL fields required (providerStrict) | 200 | yes | yes | true | ROUND-TRIP OK |
| bookStrictOpt — a Fields param with an OPTIONAL field (providerStrict) — the KNOWN BOUNDARY | 400 | NO | no | n/a | SCHEMA REJECTED |

### Detail
- **reminder — providerStrict + Nullable optional (the Slice-D headline)**
  - expectation: accepted under strict; model sends note:null; the Nullable validator ACCEPTS null → no drift
  - result: ROUND-TRIP OK (HTTP 200) — args={"note":null,"patientId":"3f7c1e94-2a8b-4d6f-9c11-5b0e2a7d8f34"}
- **book — a Fields param with an optional field (non-strict)**
  - expectation: Fields schema accepted; model fills the nested object; the Fields validator accepts it
  - result: ROUND-TRIP OK (HTTP 200) — args={"slot":{"when":"2026-08-15T09:00:00Z"}}
- **bookStrict — a Fields param, ALL fields required (providerStrict)**
  - expectation: accepted under strict (the nested object is fully closed); validator accepts
  - result: ROUND-TRIP OK (HTTP 200) — args={"slot":{"duration":30,"when":"2026-08-15T09:00:00Z"}}
- **bookStrictOpt — a Fields param with an OPTIONAL field (providerStrict) — the KNOWN BOUNDARY**
  - expectation: EXPECTED REJECTED: providerStrict keeps top-level params in `required`, but a nested Fields still drops its optional field from the nested `required`, which strict forbids (deferred in DEC-068). Evidence for whether the deferred nested-nullable work is needed.
  - result: SCHEMA REJECTED (HTTP 400) — Invalid schema for function 'bookStrictOpt': In context=('properties', 'slot'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'label'.

## Local negative — the validator is the real guard (no network)

- bad nested value `{when:'not-a-datetime'}` → REJECTED @["when"], expected: an RFC 3339 date-time
- missing required `when` → REJECTED @["when"], expected: an RFC 3339 date-time
- Nullable(NotEmpty()) on `null` → ACCEPTS (as designed — no drift)
- Nullable(NotEmpty()) on `""` → REJECTS (still enforces non-empty)

## The generated schemas (verbatim, from the real code)

### reminder — providerStrict + Nullable optional (the Slice-D headline)
```json
{
  "title": "scheduleReminder",
  "description": "Schedule a reminder for a patient, optionally with a free-text note.",
  "type": "object",
  "properties": {
    "note": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1
    },
    "patientId": {
      "type": "string",
      "format": "uuid"
    }
  },
  "required": [
    "patientId",
    "note"
  ],
  "additionalProperties": false
}
```

### book — a Fields param with an optional field (non-strict)
```json
{
  "title": "book",
  "description": "Book a slot.",
  "type": "object",
  "properties": {
    "slot": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string",
          "minLength": 1
        },
        "when": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "when"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "slot"
  ],
  "additionalProperties": false
}
```

### bookStrict — a Fields param, ALL fields required (providerStrict)
```json
{
  "title": "bookStrict",
  "description": "Book a slot with a duration in minutes.",
  "type": "object",
  "properties": {
    "slot": {
      "type": "object",
      "properties": {
        "duration": {
          "type": "integer"
        },
        "when": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "when",
        "duration"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "slot"
  ],
  "additionalProperties": false
}
```

### bookStrictOpt — a Fields param with an OPTIONAL field (providerStrict) — the KNOWN BOUNDARY
```json
{
  "title": "bookStrictOpt",
  "description": "Book a slot, optional label.",
  "type": "object",
  "properties": {
    "slot": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string",
          "minLength": 1
        },
        "when": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "when"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "slot"
  ],
  "additionalProperties": false
}
```