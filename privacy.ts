/**
 * `adorn/privacy` — the telemetry-disclosure (privacy-review) projection (DEC-097).
 *
 * The "what leaves the process" table: a pure registry read (DEC-012) reporting the disclosure each
 * parameter/return carries, rendering its own scanned denominator (a clean table is never a clean bill of
 * health). Moved off the package root in the DEC-097 curation with the other projections. Import from
 * `adorn/privacy`.
 */

// prettier-ignore
export {
    telemetryForClass, telemetryForContracts, serializeTelemetry, generateTelemetryReport,
} from './src/Projections/telemetry';
export type {TelemetryReport} from './src/Projections/telemetry';
