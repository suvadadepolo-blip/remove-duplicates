export const stripBom = (text) =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

function assertDelimiter(delimiter) {
  if (delimiter !== "\t" && delimiter !== ",") {
    throw new TypeError('delimiter must be either "\\t" or ",".');
  }
}

export function parseRecords(text, delimiter) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string.");
  }
  assertDelimiter(delimiter);
  text = stripBom(text);

  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (char === "\n") {
      pushRecord();
      i += 1;
      continue;
    }
    if (char === "\r") {
      pushRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field !== "" || record.length > 0 || inQuotes) pushRecord();
  return records;
}

const QUOTE_TRIGGERS = Object.freeze({
  "\t": /[\t\n\r"]/,
  ",": /[,\n\r"]/
});

function serializeField(field, delimiter) {
  return QUOTE_TRIGGERS[delimiter].test(field)
    ? `"${field.replaceAll('"', '""')}"`
    : field;
}

export function serializeRecords(records, delimiter) {
  assertDelimiter(delimiter);
  if (!Array.isArray(records)) {
    throw new TypeError("Records must be an array.");
  }
  return records
    .map((cells) => {
      if (!Array.isArray(cells) || cells.some((field) => typeof field !== "string")) {
        throw new TypeError("Every record must be an array of strings.");
      }
      return cells.map((field) => serializeField(field, delimiter)).join(delimiter);
    })
    .join("\n");
}

function modalValue(values) {
  const frequencies = new Map();
  let modal = 0;
  let modalFrequency = 0;
  for (const value of values) {
    const frequency = (frequencies.get(value) ?? 0) + 1;
    frequencies.set(value, frequency);
    if (frequency > modalFrequency || (frequency === modalFrequency && value > modal)) {
      modal = value;
      modalFrequency = frequency;
    }
  }
  return modal;
}

export function detectFormat(
  text,
  { sampleChars = 262_144, sampleRecords = 200 } = {}
) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string.");
  }
  const sample = text.length > sampleChars ? text.slice(0, sampleChars) : text;
  for (const delimiter of ["\t", ","]) {
    const records = parseRecords(sample, delimiter).slice(0, sampleRecords);
    const counts = records
      .filter((cells) => cells.some((cell) => cell.trim() !== ""))
      .map((cells) => cells.length);
    if (counts.length < 2) continue;
    const modal = modalValue(counts);
    const multiShare = counts.filter((count) => count >= 2).length / counts.length;
    const modalShare = counts.filter((count) => count === modal).length / counts.length;
    if (modal >= 2 && multiShare >= 0.8 && modalShare >= 0.8) {
      return {
        kind: delimiter === "\t" ? "tsv" : "csv",
        delimiter,
        columns: modal
      };
    }
  }
  return { kind: "lines", delimiter: null, columns: 1 };
}

export function resolveFormat(text, options = {}) {
  if (typeof text !== "string") {
    throw new TypeError("Text must be a string.");
  }
  const format = options.format ?? "auto";
  if (format !== "auto" && format !== "lines" && format !== "table") {
    throw new TypeError('format must be either "auto", "lines", or "table".');
  }
  if (format === "lines") {
    return { kind: "lines", delimiter: null, columns: 1 };
  }
  const detected = detectFormat(text);
  if (format === "table" && detected.kind === "lines") {
    const delimiter = text.includes("\t") ? "\t" : ",";
    const records = parseRecords(text, delimiter);
    const columns = records.reduce(
      (maximum, cells) => Math.max(maximum, cells.length),
      1
    );
    return {
      kind: delimiter === "\t" ? "tsv" : "csv",
      delimiter,
      columns
    };
  }
  return detected;
}
