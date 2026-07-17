import {
  parseRecords,
  resolveFormat,
  serializeRecords
} from "./tabular.js?v=20260716.2";

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const WORKER_CHARACTER_THRESHOLD = 64 * 1024;
export const WORKER_LINE_THRESHOLD = 10_000;

const UTF8_ENCODER = new TextEncoder();
const NATURAL_COLLATORS = Object.freeze({
  sensitive: new Intl.Collator("en", {
    usage: "sort",
    numeric: true,
    sensitivity: "variant"
  }),
  insensitive: new Intl.Collator("en", {
    usage: "sort",
    numeric: true,
    sensitivity: "base"
  })
});

export class DedupeLimitError extends RangeError {
  constructor(actual) {
    super(`Text must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes (received ${actual}).`);
    this.name = "DedupeLimitError";
    this.kind = "size";
    this.limit = MAX_TEXT_BYTES;
    this.actual = actual;
  }
}

export class DedupeCompareError extends RangeError {
  constructor() {
    super("A compare index is outside the available columns.");
    this.name = "DedupeCompareError";
    this.kind = "compare";
  }
}

function assertText(text) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string.");
  }
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function splitLines(text) {
  return text === "" ? [] : normalizeLineEndings(text).split("\n");
}

function readBooleanOption(options, name) {
  const value = options[name] ?? false;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean.`);
  }
  return value;
}

function normalizeOptions(options) {
  if (options === undefined) options = {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Dedupe options must be an object.");
  }

  const keep = options.keep ?? "first";
  if (keep !== "first" && keep !== "last") {
    throw new TypeError('keep must be either "first" or "last".');
  }

  const order = options.order ?? "preserve";
  if (order !== "preserve" && order !== "sort") {
    throw new TypeError('order must be either "preserve" or "sort".');
  }

  return {
    ignoreCase: readBooleanOption(options, "ignoreCase"),
    trim: readBooleanOption(options, "trim"),
    removeEmpty: readBooleanOption(options, "removeEmpty"),
    keep,
    order
  };
}

function normalizeRecordOptions(options) {
  const settings = normalizeOptions(options);
  const sourceCompare = options?.compare ?? "row";
  let compare;
  if (sourceCompare === "row") {
    compare = sourceCompare;
  } else if (Number.isInteger(sourceCompare) && sourceCompare >= 0) {
    compare = sourceCompare;
  } else if (Array.isArray(sourceCompare)) {
    if (sourceCompare.length === 0) {
      throw new TypeError("compare arrays must be non-empty.");
    }
    compare = sourceCompare.slice();
    if (compare.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new TypeError("Every compare index must be a non-negative integer.");
    }
    if (new Set(compare).size !== compare.length) {
      throw new TypeError("compare indices must be unique.");
    }
    compare.sort((left, right) => left - right);
  } else {
    throw new TypeError(
      'compare must be "row", a non-negative integer, or a non-empty array of unique indices.'
    );
  }
  return {
    ...settings,
    compare,
    header: readBooleanOption(options ?? {}, "header")
  };
}

function assertRecords(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("Records must be an array.");
  }
  if (
    records.some(
      (cells) =>
        !Array.isArray(cells) || cells.some((cell) => typeof cell !== "string")
    )
  ) {
    throw new TypeError("Every record must be an array of strings.");
  }
}

function selectedRecordCells(cells, compare) {
  if (compare === "row") return cells;
  const indices = Array.isArray(compare) ? compare : [compare];
  return indices.map((index) => cells[index] ?? "");
}

function normalizedRecordCells(cells, settings) {
  return selectedRecordCells(cells, settings.compare).map((cell) => {
    const value = settings.trim ? cell.trim() : cell;
    return settings.ignoreCase ? value.toLowerCase() : value;
  });
}

function recordKey(cells, settings) {
  return JSON.stringify(normalizedRecordCells(cells, settings));
}

function validateCompareBounds(compare, records) {
  if (compare === "row") return;
  const columnCount = records.reduce(
    (largest, cells) => Math.max(largest, cells.length),
    0
  );
  const indices = Array.isArray(compare) ? compare : [compare];
  if (columnCount > 0 && indices.some((index) => index >= columnCount)) {
    throw new DedupeCompareError();
  }
}

export function measureTextBytes(text) {
  assertText(text);
  return UTF8_ENCODER.encode(text).byteLength;
}

export function shouldUseWorker(text) {
  assertText(text);
  if (text.length >= WORKER_CHARACTER_THRESHOLD) return true;
  return splitLines(text).length >= WORKER_LINE_THRESHOLD;
}

export function dedupeText(text, options) {
  assertText(text);
  const bytes = measureTextBytes(text);
  if (bytes > MAX_TEXT_BYTES) {
    throw new DedupeLimitError(bytes);
  }

  const settings = normalizeOptions(options);
  const sourceLines = splitLines(text);
  const entriesByKey = new Map();
  let duplicates = 0;
  let emptyRemoved = 0;

  sourceLines.forEach((sourceValue, index) => {
    if (settings.removeEmpty && sourceValue.trim() === "") {
      emptyRemoved += 1;
      return;
    }

    const value = settings.trim ? sourceValue.trim() : sourceValue;
    const key = settings.ignoreCase ? value.toLowerCase() : value;
    const existing = entriesByKey.get(key);

    if (existing) {
      duplicates += 1;
      if (settings.keep === "last") {
        existing.value = value;
        existing.index = index;
      }
      return;
    }

    entriesByKey.set(key, { value, index });
  });

  const entries = Array.from(entriesByKey.values());
  if (settings.order === "sort") {
    const collator = settings.ignoreCase
      ? NATURAL_COLLATORS.insensitive
      : NATURAL_COLLATORS.sensitive;
    entries.sort((left, right) => {
      const comparison = collator.compare(left.value, right.value);
      return comparison || left.index - right.index;
    });
  } else {
    entries.sort((left, right) => left.index - right.index);
  }

  const lines = entries.map(({ value }) => value);
  const total = sourceLines.length;
  const unique = lines.length;
  const removed = duplicates + emptyRemoved;
  const reduction = total === 0 ? 0 : Number(((removed / total) * 100).toFixed(1));

  return {
    text: lines.join("\n"),
    lines,
    sourceBytes: bytes,
    stats: {
      total,
      unique,
      removed,
      duplicates,
      emptyRemoved,
      reduction
    }
  };
}

export function dedupeRecords(records, options) {
  assertRecords(records);
  const settings = normalizeRecordOptions(options);
  const selection = selectSurvivorRows(records, settings);
  const outputCells = (cells) =>
    settings.trim ? cells.map((cell) => cell.trim()) : cells;
  const outputRecords = selection.survivorIndices.map((index) =>
    outputCells(records[index])
  );
  if (settings.header && records.length > 0) {
    outputRecords.unshift(outputCells(records[0]));
  }

  return {
    records: outputRecords,
    stats: selection.stats
  };
}

export function selectSurvivorRows(records, options) {
  assertRecords(records);
  const settings = normalizeRecordOptions(options);
  validateCompareBounds(settings.compare, records);
  const dataStart = settings.header && records.length > 0 ? 1 : 0;
  const entriesByKey = new Map();
  let duplicates = 0;
  let emptyRemoved = 0;

  for (let index = dataStart; index < records.length; index += 1) {
    const sourceCells = records[index];
    if (
      settings.removeEmpty &&
      sourceCells.every((cell) => cell.trim() === "")
    ) {
      emptyRemoved += 1;
      continue;
    }

    const key = recordKey(sourceCells, settings);
    const existing = entriesByKey.get(key);
    if (existing) {
      duplicates += 1;
      if (settings.keep === "last") {
        existing.index = index;
      }
      continue;
    }
    entriesByKey.set(key, { index });
  }

  const entries = Array.from(entriesByKey.values());
  const sortValue = (entry) =>
    selectedRecordCells(records[entry.index], settings.compare)
      .map((cell) => (settings.trim ? cell.trim() : cell))
      .join(" ");
  if (settings.order === "sort") {
    const collator = settings.ignoreCase
      ? NATURAL_COLLATORS.insensitive
      : NATURAL_COLLATORS.sensitive;
    entries.sort(
      (left, right) =>
        collator.compare(sortValue(left), sortValue(right)) ||
        left.index - right.index
    );
  } else {
    entries.sort((left, right) => left.index - right.index);
  }

  const survivorIndices = entries.map((entry) => entry.index);
  const total = records.length - dataStart;
  const unique = entries.length;
  const removed = duplicates + emptyRemoved;
  const reduction =
    total === 0 ? 0 : Number(((removed / total) * 100).toFixed(1));

  return {
    survivorIndices,
    stats: {
      total,
      unique,
      removed,
      duplicates,
      emptyRemoved,
      reduction
    }
  };
}

export function dedupeInput(text, options) {
  assertText(text);
  if (options === undefined) options = {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Dedupe options must be an object.");
  }

  const bytes = measureTextBytes(text);
  if (bytes > MAX_TEXT_BYTES) {
    throw new DedupeLimitError(bytes);
  }

  const format = resolveFormat(text, options);
  if (format.kind === "lines") {
    return { ...dedupeText(text, options), table: null };
  }

  const records = parseRecords(text, format.delimiter);
  const result = dedupeRecords(records, options);
  const lines = result.records.map((cells) =>
    serializeRecords([cells], format.delimiter)
  );
  const header = options.header ?? false;
  const headerCells = header && result.records.length > 0
    ? result.records[0]
    : [];

  return {
    text: lines.join("\n"),
    lines,
    sourceBytes: bytes,
    table: {
      delimiter: format.delimiter,
      kind: format.kind,
      columns: format.columns,
      header,
      headerCells
    },
    stats: result.stats
  };
}

export function dedupeInteractiveInput(text, options) {
  try {
    return dedupeInput(text, options);
  } catch (error) {
    if (!(error instanceof DedupeCompareError)) throw error;
    return dedupeInput(text, { ...(options ?? {}), compare: "row" });
  }
}
