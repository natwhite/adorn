/**
 * `adorn/observe` — the observation plumbing (DEC-097).
 *
 * Reading the installed sink, the shared settlement classifier `settle`, the correlation-id sequence
 * `nextCallId`, a ready-made zero-dependency console sink, the check-failure → `ViolationFacts` translator, and
 * the `ObservationSink` model a sink author binds to. INSTALLING a sink stays on the package root
 * (`setObservationSink`, a configuration verb like `setViolationPolicy`); constructing and reading observation
 * data lives here. Moved off root in the DEC-097 curation. Import from `adorn/observe`.
 */

export {getObservationSink, RETURN_INDEX, nextCallId} from './src/Core/Observation';
// prettier-ignore
export type {
    ObservationSink, Observation, ObservedParameter, ParameterDisclosure,
    ObservationEvent, ViolationFacts, EmittedValue, ErrorFacts,
    Attributes, AttributeValue, LogLevel, ObservationDetail, ObservationCall, SpanKind,
} from './src/Core/Observation';

export {settle} from './src/Core/settle';
export type {Settlement, SettleKind} from './src/Core/settle';

export {
    consoleObservationSink,
    createConsoleObservationSink,
} from './src/Adapters/legacy/ObservationBehavior';

// Translate a functional `Verify.check` failure into `ViolationFacts` for the observation stream (DEC-074), so
// a non-decorator refusal emits as a `violation` event on the same stream the decorator weave feeds.
export {violationFromCheck} from './src/Validation/Verify';
