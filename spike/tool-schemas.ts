/**
 * SPIKE — does adorn's schema projection serve LLM tool-calling?  NOT SHIPPED.
 *
 * Empirically grounds docs/decision-tool-schemas.md. Proves three things against a realistic
 * tool-shaped contracted class:
 *   (1) the CURRENT schema projection emits a POSITIONAL tuple (`prefixItems`) for a method;
 *   (2) the parameter NAMES are already recorded in the registry (BUG-14/captureSignature);
 *   (3) therefore a tight `{type:'object', properties:{<name>: fragment}, required, additionalProperties:false}`
 *       tool view is MECHANICALLY constructible from what is already recorded — by re-keying the
 *       tuple the projection already emits by the names the registry already holds. No fragment
 *       logic is re-derived (the merge for `days` is inherited unchanged from schema.ts).
 *
 * Run (PowerShell):
 *   npx ts-node --skip-project --transpile-only `
 *     --compiler-options '{\"experimentalDecorators\":true,\"emitDecoratorMetadata\":true,\"target\":\"es2019\",\"module\":\"commonjs\",\"esModuleInterop\":true}' `
 *     spike/tool-schemas.ts
 */
import 'reflect-metadata';
import {
    Contract,
    NotEmpty,
    Matches,
    GreaterThanEqual,
    LessThanEqual,
    schemaForClass,
    getContractsForClass,
} from '../dist/index';

// --- A realistic LLM tool, authored exactly as a user would ----------------
// One structured object is what the model sends; adorn models it as a method's named parameter list.
// `unit` simulates an enum with @Matches, since adorn has no reified @OneOf yet (the gap the doc proposes).
@Contract()
class WeatherTool {
    getWeather(
        @NotEmpty() location: string,
        @Matches(/^(celsius|fahrenheit)$/) unit: string,
        @GreaterThanEqual(1) @LessThanEqual(7) days: number,
    ): string {
        return `weather for ${location} in ${unit} over ${days} day(s)`;
    }
}

function h(title: string): void {
    console.log('\n' + '='.repeat(78) + '\n' + title + '\n' + '='.repeat(78));
}

// === (1) What the CURRENT projection emits =================================
h('(1) CURRENT OUTPUT — schemaForClass(WeatherTool): a POSITIONAL prefixItems tuple');
const classSchema: any = schemaForClass(WeatherTool);
console.log(JSON.stringify(classSchema, null, 2));

// === (2) The parameter names ARE in the registry ==========================
h('(2) THE REGISTRY ALREADY CARRIES PARAMETER NAMES (getContractsForClass)');
const entry = getContractsForClass(WeatherTool).find(e => String(e.key) === 'getWeather')!;
const params = [...entry.contract.params].sort((a, b) => a.index - b.index);
console.log(
    JSON.stringify(
        params.map(p => ({
            index: p.index,
            name: p.name, // <- recovered name, not arg0/arg1/arg2
            constraints: p.constraints.map(c => c.constraint),
        })),
        null,
        2,
    ),
);

// === (3) The tight tool-object view is mechanically constructible =========
// Re-key the tuple the projection ALREADY emitted, by the names the registry ALREADY holds.
// The only NEW policy is `required` + `additionalProperties:false` (the tight tool posture).
h('(3) MECHANICALLY DERIVED tool schema — {type:object, properties:{<name>}, required, additionalProperties:false}');
const tuple: any[] = classSchema.methods.getWeather.prefixItems;
const properties: Record<string, unknown> = {};
const required: string[] = [];
for (const p of params) {
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : `arg${p.index}`;
    properties[name] = tuple[p.index]; // the SAME fragment schema.ts emits, incl. the days merge
    required.push(name); // "carries a constraint => required"
}
const toolSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'WeatherTool.getWeather',
    description: 'Look up a weather forecast.',
    type: 'object',
    properties,
    required,
    additionalProperties: false,
};
console.log(JSON.stringify(toolSchema, null, 2));

h('VERDICT');
console.log(
    'Names present: ' +
        params.every(p => typeof p.name === 'string' && p.name.length > 0) +
        '  |  positional tuple emitted today: ' +
        (classSchema.methods.getWeather.type === 'array') +
        '  |  object view built purely by re-keying + tightening: true',
);
