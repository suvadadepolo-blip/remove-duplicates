import { selectSurvivorRows } from "./dedupe.js?v=20260716.2";

export const SHEETJS_VERSION = "0.20.3";
export const WORKBOOK_CELL_LIMIT = 500_000;
export const SHEET_CELL_LIMIT = 250_000;

const ERROR_MESSAGES = Object.freeze({
  invalid_package: "That file is not a valid XLSX workbook.",
  unsupported_format: "Only macro-free .xlsx workbooks are supported.",
  workbook_cell_limit: "That workbook declares more cells than the local safety limit.",
  sheet_cell_limit: "That worksheet declares more cells than the local safety limit.",
  no_visible_sheet: "The workbook does not contain a visible worksheet.",
  no_data_rows: "The selected worksheet does not contain any data rows.",
  comparison_required: "Choose at least one valid comparison column.",
  missing_formula_cache: "A compared formula has no saved display value. Open and save the workbook in Excel, then try again.",
  formula_shift_unsafe: "Rows cannot be removed safely because this workbook contains formulas.",
  merge_conflict: "A merged range intersects a row that would be removed.",
  warning_confirmation_required: "Review and confirm the workbook feature warnings before continuing.",
  parser_unavailable: "The local XLSX parser is unavailable.",
  serialization_failed: "The cleaned workbook could not be created safely."
});

const WARNING_DEFINITIONS = Object.freeze({
  styles: {
    title: "Styles or layout metadata",
    message: "Cell styles, custom number formats, row heights, or column widths may change when the workbook is rewritten."
  },
  drawings: {
    title: "Images, drawings, or charts",
    message: "Images, drawings, and charts are not guaranteed to survive the browser-side rewrite."
  },
  data_validation: {
    title: "Data validation",
    message: "Data-validation rules may be lost or keep outdated row references."
  },
  conditional_formatting: {
    title: "Conditional formatting",
    message: "Conditional-formatting rules may be lost or keep outdated row references."
  },
  comments: {
    title: "Comments or notes",
    message: "Comments, notes, and threaded comments may not survive the rewrite."
  },
  tables_or_pivots: {
    title: "Tables or pivot tables",
    message: "Table and pivot-table ranges may not be updated safely after rows move."
  },
  defined_names: {
    title: "Named ranges",
    message: "Named ranges may keep their original row references after rows move."
  },
  external_links: {
    title: "External links or connections",
    message: "External links, queries, and connections may change or retain outdated references."
  },
  protection: {
    title: "Workbook or sheet protection",
    message: "Protection metadata is not guaranteed to survive the rewrite unchanged."
  },
  non_worksheet_sheets: {
    title: "Non-worksheet sheets",
    message: "Chart, dialog, or other non-worksheet sheets are preserved only on a best-effort basis."
  },
  custom_xml: {
    title: "Custom XML",
    message: "Custom XML parts are not guaranteed to survive the rewrite."
  },
  embedded_objects: {
    title: "Embedded objects",
    message: "Embedded files and OLE objects are not guaranteed to survive the rewrite."
  },
  digital_signatures: {
    title: "Digital signatures",
    message: "Rewriting the workbook will invalidate or remove digital signatures."
  }
});

export class WorkbookProcessingError extends Error {
  constructor(code, details = undefined) {
    super(ERROR_MESSAGES[code] ?? "The workbook could not be processed.");
    this.name = "WorkbookProcessingError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) {
  throw new WorkbookProcessingError(code, details);
}

function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail("invalid_package");
}

function copyBuffer(value) {
  const source = byteView(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

function readWorkbook(XLSX, originalBuffer) {
  if (
    !XLSX ||
    XLSX.version !== SHEETJS_VERSION ||
    typeof XLSX.read !== "function"
  ) {
    fail("parser_unavailable");
  }

  try {
    return XLSX.read(byteView(originalBuffer), {
      type: "array",
      cellFormula: true,
      cellText: true,
      cellNF: true,
      cellStyles: true,
      cellDates: false,
      sheetStubs: true,
      xlfn: true,
      bookVBA: true,
      bookFiles: true
    });
  } catch (error) {
    if (error instanceof WorkbookProcessingError) throw error;
    fail("invalid_package");
  }
}

function decodeSheetRange(XLSX, worksheet) {
  if (!worksheet?.["!ref"]) return null;
  try {
    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    if (
      !Number.isSafeInteger(range.s.r) ||
      !Number.isSafeInteger(range.s.c) ||
      !Number.isSafeInteger(range.e.r) ||
      !Number.isSafeInteger(range.e.c) ||
      range.s.r < 0 ||
      range.s.c < 0 ||
      range.e.r < range.s.r ||
      range.e.c < range.s.c
    ) {
      fail("invalid_package");
    }
    return range;
  } catch (error) {
    if (error instanceof WorkbookProcessingError) throw error;
    fail("invalid_package");
  }
}

function rangeArea(range) {
  if (!range) return 0;
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  const area = rows * columns;
  return Number.isSafeInteger(area) ? area : Number.MAX_SAFE_INTEGER;
}

function cellEntries(worksheet) {
  return Object.entries(worksheet ?? {}).filter(([address]) => !address.startsWith("!"));
}

function hasFormula(workbook) {
  return Object.values(workbook.Sheets ?? {}).some((worksheet) =>
    cellEntries(worksheet).some(([, cell]) => Boolean(cell?.f))
  );
}

function hasMeaningfulStyle(cell) {
  if (!cell || typeof cell !== "object") return false;
  if (typeof cell.z === "string" && cell.z !== "General") return true;
  if (!cell.s || typeof cell.s !== "object") return false;
  return Object.entries(cell.s).some(
    ([name, value]) => !(name === "patternType" && value === "none")
  );
}

function packageNames(workbook, packageInfo) {
  const names = new Set();
  for (const key of workbook.keys ?? []) {
    if (typeof key === "string") names.add(key.replace(/^\/+/, ""));
  }
  for (const entry of packageInfo?.entries ?? []) {
    if (typeof entry?.name === "string") names.add(entry.name);
  }
  return [...names];
}

const XML_DECODER = new TextDecoder("utf-8");

function xmlText(workbook, key) {
  const content = workbook.files?.[key]?.content;
  if (!content || !ArrayBuffer.isView(content)) return "";
  try {
    return XML_DECODER.decode(content);
  } catch {
    return "";
  }
}

function detectWarnings(workbook, packageInfo) {
  const codes = new Set();
  const names = packageNames(workbook, packageInfo);
  const lowerNames = names.map((name) => name.toLowerCase());
  const worksheets = Object.values(workbook.Sheets ?? {});

  if (
    worksheets.some((worksheet) =>
      Boolean(worksheet?.["!rows"] || worksheet?.["!cols"]) ||
      cellEntries(worksheet).some(([, cell]) => hasMeaningfulStyle(cell))
    )
  ) codes.add("styles");
  if (lowerNames.some((name) => /^(?:xl\/(?:media|drawings|charts)\/)/.test(name))) codes.add("drawings");
  if (
    lowerNames.some((name) => /^(?:xl\/(?:comments|threadedcomments|persons)\/|xl\/comments)/.test(name)) ||
    worksheets.some((worksheet) => cellEntries(worksheet).some(([, cell]) => Array.isArray(cell?.c) && cell.c.length > 0))
  ) codes.add("comments");
  if (lowerNames.some((name) => /^xl\/(?:tables|pivottables|pivotcache)\//.test(name))) codes.add("tables_or_pivots");
  if (Array.isArray(workbook.Workbook?.Names) && workbook.Workbook.Names.length > 0) codes.add("defined_names");
  if (lowerNames.some((name) => /^xl\/(?:externallinks|querytables)\//.test(name) || name === "xl/connections.xml")) codes.add("external_links");
  if (
    worksheets.some((worksheet) => Boolean(worksheet?.["!protect"])) ||
    Boolean(workbook.Workbook?.WBProps?.lockStructure)
  ) codes.add("protection");
  if (
    lowerNames.some((name) => /^xl\/(?:chartsheets|dialogsheets|macrosheets)\//.test(name)) ||
    (workbook.SheetNames ?? []).some((name) => !workbook.Sheets?.[name] || workbook.Sheets[name]?.["!type"])
  ) codes.add("non_worksheet_sheets");
  if (lowerNames.some((name) => name.startsWith("customxml/"))) codes.add("custom_xml");
  if (lowerNames.some((name) => name.startsWith("xl/embeddings/"))) codes.add("embedded_objects");
  if (lowerNames.some((name) => name.startsWith("_xmlsignatures/"))) codes.add("digital_signatures");

  for (const key of names) {
    const lower = key.toLowerCase();
    if (!/^xl\/worksheets\/.*\.xml$/.test(lower) && !lower.endsWith(".rels") && lower !== "xl/workbook.xml") continue;
    const xml = xmlText(workbook, key);
    if (!xml) continue;
    if (/<dataValidations\b/i.test(xml)) codes.add("data_validation");
    if (/<conditionalFormatting\b/i.test(xml)) codes.add("conditional_formatting");
    if (/<(?:sheet|workbook)Protection\b/i.test(xml)) codes.add("protection");
    if (/TargetMode=["']External["']/i.test(xml)) codes.add("external_links");
  }

  return Object.keys(WARNING_DEFINITIONS)
    .filter((code) => codes.has(code))
    .map((code) => ({ code, ...WARNING_DEFINITIONS[code] }));
}

function visibleCellText(XLSX, cell, { requireFormulaCache = false } = {}) {
  if (!cell) return "";
  if (cell.f && (!Object.hasOwn(cell, "v") || cell.v === undefined)) {
    if (requireFormulaCache) fail("missing_formula_cache");
    return "\u0000formula";
  }
  if (typeof cell.w === "string") return cell.w;
  try {
    const formatted = XLSX.utils.format_cell(cell);
    return formatted == null ? "" : String(formatted);
  } catch {
    return cell.v == null ? "" : String(cell.v);
  }
}

function summarizeWorkbook(XLSX, workbook, packageInfo) {
  if (workbook.vbaraw) fail("unsupported_format");
  const names = workbook.SheetNames ?? [];
  const sheetState = workbook.Workbook?.Sheets ?? [];
  const sheets = [];
  let workbookCellArea = 0;

  names.forEach((name, index) => {
    const worksheet = workbook.Sheets?.[name];
    const range = worksheet ? decodeSheetRange(XLSX, worksheet) : null;
    const cellArea = rangeArea(range);
    workbookCellArea += cellArea;
    if (!Number.isSafeInteger(workbookCellArea) || workbookCellArea > WORKBOOK_CELL_LIMIT) {
      fail("workbook_cell_limit");
    }

    const hidden = Number(sheetState[index]?.Hidden ?? 0);
    if (!worksheet || worksheet["!type"] || hidden !== 0) return;
    const rows = range ? range.e.r - range.s.r + 1 : 0;
    const columns = range ? range.e.c - range.s.c + 1 : 0;
    const headerCells = [];
    if (range) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: range.s.r, c: column });
        const value = visibleCellText(XLSX, worksheet[address]);
        headerCells.push(value === "\u0000formula" ? "" : value);
      }
    }
    sheets.push({ index, name, rows, columns, cellArea, headerCells });
  });

  if (sheets.length === 0) fail("no_visible_sheet");
  return {
    sheets,
    warnings: detectWarnings(workbook, packageInfo),
    hasFormulas: hasFormula(workbook),
    workbookCellArea
  };
}

export function inspectWorkbook(XLSX, originalBuffer, packageInfo = undefined) {
  return summarizeWorkbook(XLSX, readWorkbook(XLSX, originalBuffer), packageInfo);
}

function selectedSheet(summary, workbook, sheetIndex) {
  if (!Number.isInteger(sheetIndex)) fail("no_visible_sheet");
  const metadata = summary.sheets.find((sheet) => sheet.index === sheetIndex);
  if (!metadata) fail("no_visible_sheet");
  return { metadata, worksheet: workbook.Sheets[metadata.name] };
}

function validateDedupeSettings(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("comparison_required");
  for (const name of ["header", "trim", "ignoreCase", "removeEmpty"]) {
    if (typeof options[name] !== "boolean") fail("comparison_required");
  }
  if (options.keep !== "first" && options.keep !== "last") fail("comparison_required");
  if (
    options.compare !== "row" &&
    !Number.isInteger(options.compare) &&
    !Array.isArray(options.compare)
  ) fail("comparison_required");
  if (!Array.isArray(options.confirmedWarningCodes)) fail("warning_confirmation_required");
}

function countDeletedBefore(sortedDeletedRows, row) {
  let low = 0;
  let high = sortedDeletedRows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedDeletedRows[middle] < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mappedRow(sortedDeletedRows, deletedSet, row) {
  if (deletedSet.has(row)) return null;
  return row - countDeletedBefore(sortedDeletedRows, row);
}

function shiftedFilterRef(XLSX, ref, sortedDeletedRows, deletedSet) {
  if (typeof ref !== "string") return ref;
  try {
    const range = XLSX.utils.decode_range(ref);
    const mappedStart = mappedRow(sortedDeletedRows, deletedSet, range.s.r);
    const mappedEnd = mappedRow(sortedDeletedRows, deletedSet, range.e.r);
    range.s.r = mappedStart ?? range.s.r - countDeletedBefore(sortedDeletedRows, range.s.r);
    range.e.r = mappedEnd ?? range.e.r - countDeletedBefore(sortedDeletedRows, range.e.r + 1);
    if (range.e.r < range.s.r) range.e.r = range.s.r;
    return XLSX.utils.encode_range(range);
  } catch {
    return ref;
  }
}

function assertMergeSafety(worksheet, deletedSet) {
  for (const merge of worksheet["!merges"] ?? []) {
    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      if (deletedSet.has(row)) fail("merge_conflict");
    }
  }
}

function rebuildWorksheet(XLSX, worksheet, sortedDeletedRows) {
  const deletedSet = new Set(sortedDeletedRows);
  const rebuilt = {};

  for (const [key, value] of Object.entries(worksheet)) {
    if (key.startsWith("!")) continue;
    try {
      const cell = XLSX.utils.decode_cell(key);
      const row = mappedRow(sortedDeletedRows, deletedSet, cell.r);
      if (row === null) continue;
      rebuilt[XLSX.utils.encode_cell({ r: row, c: cell.c })] = value;
    } catch {
      rebuilt[key] = value;
    }
  }

  for (const [key, value] of Object.entries(worksheet)) {
    if (!key.startsWith("!") || ["!ref", "!rows", "!merges", "!autofilter"].includes(key)) continue;
    rebuilt[key] = value;
  }

  if (Array.isArray(worksheet["!rows"])) {
    const rows = [];
    worksheet["!rows"].forEach((metadata, row) => {
      if (metadata === undefined) return;
      const target = mappedRow(sortedDeletedRows, deletedSet, row);
      if (target !== null) rows[target] = metadata;
    });
    if (rows.some((value) => value !== undefined)) rebuilt["!rows"] = rows;
  }

  if (Array.isArray(worksheet["!merges"])) {
    rebuilt["!merges"] = worksheet["!merges"].map((merge) => ({
      s: {
        r: mappedRow(sortedDeletedRows, deletedSet, merge.s.r),
        c: merge.s.c
      },
      e: {
        r: mappedRow(sortedDeletedRows, deletedSet, merge.e.r),
        c: merge.e.c
      }
    }));
  }

  if (worksheet["!autofilter"] && typeof worksheet["!autofilter"] === "object") {
    rebuilt["!autofilter"] = {
      ...worksheet["!autofilter"],
      ref: shiftedFilterRef(
        XLSX,
        worksheet["!autofilter"].ref,
        sortedDeletedRows,
        deletedSet
      )
    };
  }

  const originalRange = decodeSheetRange(XLSX, worksheet);
  if (originalRange) {
    const hasCells = Object.keys(rebuilt).some((key) => !key.startsWith("!"));
    if (hasCells) {
      originalRange.e.r -= sortedDeletedRows.length;
      if (originalRange.e.r < originalRange.s.r) originalRange.e.r = originalRange.s.r;
      rebuilt["!ref"] = XLSX.utils.encode_range(originalRange);
    }
  }
  return rebuilt;
}

function warningGate(warnings, confirmedWarningCodes) {
  const confirmed = new Set(
    confirmedWarningCodes.filter((code) => typeof code === "string")
  );
  const missing = warnings
    .map(({ code }) => code)
    .filter((code) => !confirmed.has(code));
  if (missing.length > 0) fail("warning_confirmation_required", { warningCodes: missing });
}

export function dedupeWorkbook(XLSX, originalBuffer, options, packageInfo = undefined) {
  validateDedupeSettings(options);
  const workbook = readWorkbook(XLSX, originalBuffer);
  const summary = summarizeWorkbook(XLSX, workbook, packageInfo);
  const { metadata, worksheet } = selectedSheet(summary, workbook, options.sheetIndex);
  if (metadata.cellArea > SHEET_CELL_LIMIT) fail("sheet_cell_limit");
  const range = decodeSheetRange(XLSX, worksheet);
  const dataStart = (range?.s.r ?? 0) + (options.header ? 1 : 0);
  if (!range || dataStart > range.e.r) fail("no_data_rows");

  const selectedColumns = options.compare === "row"
    ? null
    : new Set(Array.isArray(options.compare) ? options.compare : [options.compare]);
  const records = [];
  for (let row = dataStart; row <= range.e.r; row += 1) {
    const cells = [];
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const relativeColumn = column - range.s.c;
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      cells.push(visibleCellText(XLSX, worksheet[address], {
        requireFormulaCache: selectedColumns === null || selectedColumns.has(relativeColumn)
      }));
    }
    records.push(cells);
  }

  let selection;
  try {
    selection = selectSurvivorRows(records, {
      compare: options.compare,
      trim: options.trim,
      ignoreCase: options.ignoreCase,
      removeEmpty: options.removeEmpty,
      keep: options.keep,
      order: "preserve"
    });
  } catch {
    fail("comparison_required");
  }

  if (selection.stats.removed === 0) {
    return {
      buffer: copyBuffer(originalBuffer),
      unchanged: true,
      stats: selection.stats,
      warnings: summary.warnings,
      sheetName: metadata.name
    };
  }

  const survivorRows = new Set(
    selection.survivorIndices.map((index) => dataStart + index)
  );
  const deletedRows = [];
  for (let row = dataStart; row <= range.e.r; row += 1) {
    if (!survivorRows.has(row)) deletedRows.push(row);
  }
  const deletedSet = new Set(deletedRows);

  if (summary.hasFormulas) fail("formula_shift_unsafe");
  assertMergeSafety(worksheet, deletedSet);
  warningGate(summary.warnings, options.confirmedWarningCodes);
  workbook.Sheets[metadata.name] = rebuildWorksheet(XLSX, worksheet, deletedRows);
  delete workbook.keys;
  delete workbook.files;
  delete workbook.Directory;

  let output;
  if (typeof XLSX.write !== "function") fail("parser_unavailable");
  try {
    output = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      cellStyles: true,
      compression: true
    });
  } catch {
    fail("serialization_failed");
  }

  return {
    buffer: copyBuffer(output),
    unchanged: false,
    stats: selection.stats,
    warnings: summary.warnings,
    sheetName: metadata.name
  };
}
