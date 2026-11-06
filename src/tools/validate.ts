import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { Tool } from "./types.js";

const provider = new AjvJsonSchemaValidator();
const validators = new WeakMap<Tool, JsonSchemaValidator<unknown>>();
export function validateToolInput(tool: Tool, input: unknown): string | undefined {
  try {
    let validate = validators.get(tool);
    if (!validate) {
      const schema = tool.schema().input_schema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "Tool has no valid input schema";
      validate = provider.getValidator(schema);
      validators.set(tool, validate);
    }
    const result = validate(input);
    return result.valid ? undefined : result.errorMessage;
  } catch { return "Tool input schema could not be validated"; }
}
