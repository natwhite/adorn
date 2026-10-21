/**
 * `adorn/schema` — the projection surface (DEC-097).
 *
 * The artifact-generating projections: Markdown documentation, descriptive JSON Schema, and the prescriptive
 * LLM tool schemas. Moved off the package root in the DEC-097 surface curation so a consumer that only
 * ENFORCES contracts never pulls the projection code, and the root reads as the authoring surface it is.
 * Import from `adorn/schema`.
 */

// prettier-ignore
export {
    documentClass, documentContracts, renderMarkdown, generateMarkdown,
} from './src/Projections/docs';
export type {ClassDoc, MethodDoc, ParameterDoc, ConstraintDoc, FieldDoc, MarkdownOptions} from './src/Projections/docs';

// prettier-ignore
export {
    schemaForClass, schemaForContracts, serializeSchema, generateSchema, toolSchemaForMethod, toolSchemaFrom,
} from './src/Projections/schema';
export type {
    ClassSchema,
    SchemaOptions,
    ToolSchema,
    ToolSchemaOptions,
    ToolSchemaProvider,
    ProviderProfileOptions,
    ToolSchemaFromInput,
    ToolParamSpec,
} from './src/Projections/schema';
