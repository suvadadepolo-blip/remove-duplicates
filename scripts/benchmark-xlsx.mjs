import { performance } from "node:perf_hooks";

import * as XLSX from "../public/vendor/sheetjs-0.20.3/xlsx.mjs";
import { dedupeWorkbook, inspectWorkbook } from "../public/js/workbook-adapter.js";
import { inspectXlsxPackage } from "../public/js/xlsx-preflight.js";

const MAIN_THREAD_PREFLIGHT_LIMIT_MS = 500;
const TOTAL_PROCESSING_LIMIT_MS = 30_000;
const COLUMNS = 10;
const tiers = [
  { workbookCells: 500_000, selectedSheetCells: 250_000 },
  { workbookCells: 250_000, selectedSheetCells: 125_000 },
  { workbookCells: 100_000, selectedSheetCells: 50_000 }
];

function rowsFor(cellCount) {
  if (cellCount % COLUMNS !== 0) throw new Error("Benchmark tier is not divisible by the fixed column count.");
  return cellCount / COLUMNS;
}

function sheetRows(rowCount, { duplicates }) {
  const rows = new Array(rowCount);
  rows[0] = Array.from({ length: COLUMNS }, (_, column) => column === 0 ? "Key" : `Value ${column}`);
  for (let row = 1; row < rowCount; row += 1) {
    const key = duplicates ? Math.floor((row - 1) / 2) : row;
    rows[row] = Array.from({ length: COLUMNS }, (_, column) =>
      column === 0 ? `key-${key}` : `r${row}-c${column}`
    );
  }
  return rows;
}

function buildWorkbook(tier) {
  const selectedRows = rowsFor(tier.selectedSheetCells);
  const otherCells = tier.workbookCells - tier.selectedSheetCells;
  const otherRows = rowsFor(otherCells);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(sheetRows(selectedRows, { duplicates: true })),
    "Data"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(sheetRows(otherRows, { duplicates: false })),
    "Unchanged"
  );
  return {
    selectedRows,
    otherRows,
    buffer: XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      compression: true
    })
  };
}

async function benchmarkTier(tier) {
  const generationStarted = performance.now();
  const built = buildWorkbook(tier);
  const generationMs = performance.now() - generationStarted;

  const preflightStarted = performance.now();
  const packageInfo = inspectXlsxPackage(built.buffer);
  const mainThreadPreflightMs = performance.now() - preflightStarted;

  const processingStarted = performance.now();
  const inspection = inspectWorkbook(XLSX, built.buffer, packageInfo);
  const inspectedAt = performance.now();
  const result = dedupeWorkbook(XLSX, built.buffer, {
    sheetIndex: inspection.sheets[0].index,
    header: true,
    compare: [0],
    trim: false,
    ignoreCase: false,
    removeEmpty: false,
    keep: "first",
    confirmedWarningCodes: inspection.warnings.map(({ code }) => code)
  }, packageInfo);
  const processingFinished = performance.now();
  const processingMs = processingFinished - processingStarted;

  const expectedDataRows = built.selectedRows - 1;
  const expectedUnique = Math.ceil(expectedDataRows / 2);
  const expectedRemoved = expectedDataRows - expectedUnique;
  if (
    inspection.workbookCellArea !== tier.workbookCells ||
    inspection.sheets[0].cellArea !== tier.selectedSheetCells ||
    result.stats.total !== expectedDataRows ||
    result.stats.unique !== expectedUnique ||
    result.stats.removed !== expectedRemoved
  ) {
    throw new Error("Benchmark output failed its row and cell-count integrity checks.");
  }

  const reopened = XLSX.read(result.buffer, { type: "array" });
  if (
    reopened.SheetNames.join("|") !== "Data|Unchanged" ||
    reopened.Sheets.Unchanged?.["!ref"] !== `A1:J${built.otherRows}` ||
    reopened.Sheets.Data?.["!ref"] !== `A1:J${expectedUnique + 1}`
  ) {
    throw new Error("Benchmark output failed its workbook round-trip integrity checks.");
  }

  return {
    ...tier,
    compressedBytes: built.buffer.byteLength,
    outputBytes: result.buffer.byteLength,
    generationMs: Number(generationMs.toFixed(1)),
    mainThreadPreflightMs: Number(mainThreadPreflightMs.toFixed(1)),
    workerInspectMs: Number((inspectedAt - processingStarted).toFixed(1)),
    workerDedupeAndWriteMs: Number((processingFinished - inspectedAt).toFixed(1)),
    processingMs: Number(processingMs.toFixed(1)),
    removedRows: result.stats.removed,
    passed:
      mainThreadPreflightMs <= MAIN_THREAD_PREFLIGHT_LIMIT_MS &&
      processingMs <= TOTAL_PROCESSING_LIMIT_MS
  };
}

const receipts = [];
let selectedTier = null;
for (const tier of tiers) {
  try {
    const receipt = await benchmarkTier(tier);
    receipts.push(receipt);
    if (receipt.passed) {
      selectedTier = tier;
      break;
    }
  } catch (error) {
    receipts.push({
      ...tier,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const output = {
  ok: Boolean(selectedTier),
  runtime: { node: process.version, sheetjs: XLSX.version },
  gates: {
    mainThreadSingleTaskMs: MAIN_THREAD_PREFLIGHT_LIMIT_MS,
    totalProcessingMs: TOTAL_PROCESSING_LIMIT_MS
  },
  selectedTier,
  receipts
};
console.log(JSON.stringify(output, null, 2));
if (!selectedTier) process.exitCode = 1;
