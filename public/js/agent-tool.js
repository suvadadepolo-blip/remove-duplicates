import {
  DedupeCompareError,
  dedupeInput,
  measureTextBytes
} from "./dedupe.js?v=20260923.1";

// One tool definition shared by the stateless /mcp endpoint (src/mcp.js) and
// the in-page WebMCP registration (webmcp.js), so both surfaces accept the
// same arguments and return the same result as the website engine.
//
// Known ceiling: 128 KiB per call keeps a worst-case sorted run near 20 ms of
// CPU on the measured engine. Raise it only after re-measuring Worker CPU time
// for the sorted-lines case at the new size.
export const AGENT_TEXT_LIMIT_BYTES = 128 * 1024;
export const REMOVE_DUPLICATES_TOOL_NAME = "remove_duplicates";

const OPTION_DEFAULTS = Object.freeze({
  format: "auto",
  ignoreCase: false,
  trim: false,
  removeEmpty: true,
  keep: "first",
  order: "preserve",
  compare: "row",
  header: false
});

export const REMOVE_DUPLICATES_TOOL = Object.freeze({
  name: REMOVE_DUPLICATES_TOOL_NAME,
  title: "Remove duplicates",
  description:
    "Remove duplicate lines from a text list, or duplicate rows from CSV/TSV text such as rows copied from Excel or Google Sheets. " +
    "Uses the same engine as removeduplicates.org and returns the cleaned text with counts. " +
    "Stateless: the text is processed in memory for this call only and is never stored.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: `The list or table text: one item per line, or CSV/tab-separated rows. Up to ${AGENT_TEXT_LIMIT_BYTES} UTF-8 bytes.`
      },
      format: {
        type: "string",
        enum: ["auto", "lines", "table"],
        default: OPTION_DEFAULTS.format,
        description: "auto detects CSV/TSV tables; lines compares whole lines; table forces CSV/TSV parsing."
      },
      ignoreCase: {
        type: "boolean",
        default: OPTION_DEFAULTS.ignoreCase,
        description: "Treat values such as Apple and apple as duplicates."
      },
      trim: {
        type: "boolean",
        default: OPTION_DEFAULTS.trim,
        description: "Ignore surrounding spaces when comparing and return trimmed values."
      },
      removeEmpty: {
        type: "boolean",
        default: OPTION_DEFAULTS.removeEmpty,
        description: "Drop blank lines or all-blank rows."
      },
      keep: {
        type: "string",
        enum: ["first", "last"],
        default: OPTION_DEFAULTS.keep,
        description: "Which occurrence of a duplicate survives."
      },
      order: {
        type: "string",
        enum: ["preserve", "sort"],
        default: OPTION_DEFAULTS.order,
        description: "preserve keeps the original order; sort returns a natural (numeric-aware) sort."
      },
      compare: {
        anyOf: [
          { type: "string", enum: ["row"] },
          { type: "integer", minimum: 0 },
          { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, uniqueItems: true }
        ],
        default: OPTION_DEFAULTS.compare,
        description: "Tables only: \"row\" compares entire rows; a zero-based column index or an array of indices compares only those columns."
      },
      header: {
        type: "boolean",
        default: OPTION_DEFAULTS.header,
        description: "Tables only: keep the first row as a header outside duplicate checks and counts."
      }
    },
    required: ["text"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The cleaned text, rows joined with \\n." },
      format: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["lines", "csv", "tsv"] },
          columns: { type: "integer" },
          header: { type: "boolean" }
        },
        required: ["kind", "columns", "header"]
      },
      stats: {
        type: "object",
        properties: {
          total: { type: "integer", description: "Input lines or data rows (header excluded)." },
          unique: { type: "integer", description: "Lines or data rows kept." },
          removed: { type: "integer", description: "duplicates + emptyRemoved." },
          duplicates: { type: "integer" },
          emptyRemoved: { type: "integer" },
          reduction: { type: "number", description: "Percent of input removed, one decimal." }
        },
        required: ["total", "unique", "removed", "duplicates", "emptyRemoved", "reduction"]
      }
    },
    required: ["text", "format", "stats"]
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
});

// Argument problems the caller can fix; the message is safe to show verbatim.
export class AgentToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentToolInputError";
  }
}

export function runRemoveDuplicates(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new AgentToolInputError("arguments must be an object.");
  }
  const unknown = Object.keys(args).filter(
    (key) => key !== "text" && !Object.hasOwn(OPTION_DEFAULTS, key)
  );
  if (unknown.length > 0) {
    throw new AgentToolInputError(`Unknown argument: ${unknown.join(", ")}.`);
  }
  if (typeof args.text !== "string") {
    throw new AgentToolInputError("text is required and must be a string.");
  }
  const bytes = measureTextBytes(args.text);
  if (bytes > AGENT_TEXT_LIMIT_BYTES) {
    throw new AgentToolInputError(
      `text is ${bytes} UTF-8 bytes; the limit per call is ${AGENT_TEXT_LIMIT_BYTES}. Splitting would miss duplicates across parts, so ask the user to open https://removeduplicates.org/ in a browser, which handles up to 5 MB locally.`
    );
  }

  const options = { ...OPTION_DEFAULTS, ...args };
  let result;
  try {
    result = dedupeInput(args.text, options);
  } catch (error) {
    if (error instanceof DedupeCompareError) {
      throw new AgentToolInputError("compare names a column that the table does not have.");
    }
    if (error instanceof TypeError) {
      throw new AgentToolInputError(error.message);
    }
    throw error;
  }

  return {
    text: result.text,
    format: result.table
      ? { kind: result.table.kind, columns: result.table.columns, header: result.table.header }
      : { kind: "lines", columns: 1, header: false },
    stats: result.stats
  };
}
