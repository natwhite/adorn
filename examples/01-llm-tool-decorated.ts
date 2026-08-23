/**
 * The flagship: a contracted method IS an LLM tool definition.
 *
 * One declaration on the signature becomes BOTH the JSON Schema the model reads (so it emits
 * well-formed arguments) AND the runtime validation the arguments face. They descend from one
 * source, so they can't drift.
 *
 *   Run:  npx ts-node examples/01-llm-tool-decorated.ts
 *   (In your own project the import is `from 'adorn'`.)
 */
import {
    Contract,
    Tool,
    Describe,
    NotEmpty,
    OneOf,
    GreaterThanEqual,
    LessThanEqual,
    toolSchemaForMethod,
} from '../index';

@Contract()
class WeatherTool {
    @Tool('Look up a weather forecast.')
    getWeather(
        @Describe('the city to look up') @NotEmpty() location: string,
        @OneOf(['celsius', 'fahrenheit']) unit: string,
        @GreaterThanEqual(1) @LessThanEqual(7) days: number,
    ): string {
        // @Contract() has already rejected any call whose arguments violate the same constraints
        // the schema advertises. If the model sends {days: 99}, this body never runs.
        return `forecast for ${location} in ${unit} over ${days} day(s)`;
    }
}

// 1. The `parameters` object you hand a function-calling API — read straight off the signature.
console.log('=== toolSchemaForMethod ===');
console.log(JSON.stringify(toolSchemaForMethod(WeatherTool, 'getWeather'), null, 2));

const tool = new WeatherTool();

// 2. A valid call runs.
console.log('\n=== a valid call ===');
console.log(tool.getWeather('Paris', 'celsius', 3));

// 3. The SAME constraints that shaped the schema reject a bad call — before the body runs.
console.log('\n=== the model sends days: 99 (schema said maximum 7) ===');
try {
    tool.getWeather('Paris', 'celsius', 99);
} catch (e) {
    console.log('rejected:', (e as Error).message);
}

console.log('\n=== the model sends an out-of-enum unit ===');
try {
    tool.getWeather('Paris', 'kelvin', 3);
} catch (e) {
    console.log('rejected:', (e as Error).message);
}
