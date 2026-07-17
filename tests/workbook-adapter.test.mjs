import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as XLSX from "../public/vendor/sheetjs-0.20.3/xlsx.mjs";
import {
  WorkbookProcessingError,
  dedupeWorkbook,
  inspectWorkbook
} from "../public/js/workbook-adapter.js";

function workbookBuffer(sheets, configure) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  configure?.(workbook);
  return XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    cellStyles: true,
    compression: true
  });
}

function rowsFrom(buffer, sheetName = "Data") {
  const workbook = XLSX.read(buffer, { type: "array", cellFormula: true });
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: ""
  });
}

function processOptions(inspection, overrides = {}) {
  return {
    sheetIndex: inspection.sheets[0].index,
    header: true,
    compare: "row",
    trim: false,
    ignoreCase: false,
    removeEmpty: false,
    keep: "first",
    confirmedWarningCodes: inspection.warnings.map(({ code }) => code),
    ...overrides
  };
}

function expectCode(code) {
  return (error) => error instanceof WorkbookProcessingError && error.code === code;
}

test("inspection lists only visible worksheets in source order and reports rectangular cell area", () => {
  const buffer = workbookBuffer([
    ["Data", [["ID", "Name"], [1, "Ada"], [2, "Grace"]]],
    ["Hidden", [["secret"]]],
    ["Other", [["value"]]]
  ], (workbook) => {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = [
      { name: "Data", Hidden: 0 },
      { name: "Hidden", Hidden: 1 },
      { name: "Other", Hidden: 0 }
    ];
  });

  const inspection = inspectWorkbook(XLSX, buffer);
  assert.deepEqual(inspection.sheets.map(({ name }) => name), ["Data", "Other"]);
  assert.deepEqual(inspection.sheets[0], {
    index: 0,
    name: "Data",
    rows: 3,
    columns: 2,
    cellArea: 6,
    headerCells: ["ID", "Name"]
  });
  assert.equal(inspection.workbookCellArea, 8);
});

test("multi-column dedupe uses displayed text, preserves original cells, and keeps the last position", () => {
  const buffer = workbookBuffer([["Data", [
    ["ID", "Group", "Note"],
    [" A ", "X", "first"],
    ["B", "Y", "keep"],
    ["a", "x", "last"]
  ]]]);
  const inspection = inspectWorkbook(XLSX, buffer);

  const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection, {
    compare: [1, 0],
    trim: true,
    ignoreCase: true,
    keep: "last"
  }));

  assert.equal(result.unchanged, false);
  assert.deepEqual(result.stats, {
    total: 3,
    unique: 2,
    removed: 1,
    duplicates: 1,
    emptyRemoved: 0,
    reduction: 33.3
  });
  assert.deepEqual(rowsFrom(result.buffer), [
    ["ID", "Group", "Note"],
    ["B", "Y", "keep"],
    ["a", "x", "last"]
  ]);
});

test("formatted date and number fixture compares saved display text", () => {
  const source = readFileSync(new URL("./fixtures/excel-typed-unique.xlsx", import.meta.url));
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const inspection = inspectWorkbook(XLSX, buffer);
  const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection, {
    compare: [1, 2]
  }));

  assert.equal(result.stats.removed, 1);
  assert.deepEqual(rowsFrom(result.buffer), [
    ["ID", "Date", "Amount", "Active"],
    [1, 45292, 1234.501, true],
    [2, 45293, 98.25, false]
  ]);
});

test("zero removals return byte-identical original data without serialization", () => {
  const buffer = workbookBuffer([["Data", [["ID"], [1], [2]]]]);
  const inspection = inspectWorkbook(XLSX, buffer);
  const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection));

  assert.equal(result.unchanged, true);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(buffer));
});

test("hidden rows participate in dedupe and row metadata moves with survivors", () => {
  const buffer = workbookBuffer([["Data", [["ID"], ["same"], ["same"], ["keep"]]]], (workbook) => {
    workbook.Sheets.Data["!rows"] = [undefined, { hidden: true }, undefined, { hpt: 27 }];
  });
  const inspection = inspectWorkbook(XLSX, buffer);
  const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection));
  const reopened = XLSX.read(result.buffer, { type: "array", cellStyles: true });

  assert.deepEqual(rowsFrom(result.buffer), [["ID"], ["same"], ["keep"]]);
  assert.equal(reopened.Sheets.Data["!rows"]?.[1]?.hidden, true);
  assert.equal(reopened.Sheets.Data["!rows"]?.[2]?.hpt, 27);
});

test("formula workbooks block every actual row deletion but allow unchanged byte copies", () => {
  const duplicateBuffer = workbookBuffer([["Data", [["ID", "Calc"], ["x", 2], ["x", 2]]]], (workbook) => {
    workbook.Sheets.Data.B2 = { t: "n", f: "1+1", v: 2 };
  });
  const duplicateInspection = inspectWorkbook(XLSX, duplicateBuffer);
  assert.throws(
    () => dedupeWorkbook(XLSX, duplicateBuffer, processOptions(duplicateInspection, { compare: [0] })),
    expectCode("formula_shift_unsafe")
  );

  const uniqueBuffer = workbookBuffer([["Data", [["ID", "Calc"], ["x", 2], ["y", 3]]]], (workbook) => {
    workbook.Sheets.Data.B2 = { t: "n", f: "1+1", v: 2 };
  });
  const uniqueInspection = inspectWorkbook(XLSX, uniqueBuffer);
  const result = dedupeWorkbook(XLSX, uniqueBuffer, processOptions(uniqueInspection, { compare: [0] }));
  assert.equal(result.unchanged, true);
  assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(uniqueBuffer));
});

test("a compared formula without a cached display value returns missing_formula_cache", () => {
  const buffer = workbookBuffer([["Data", [["ID", "Calc"], ["a", ""], ["b", ""]]]], (workbook) => {
    workbook.Sheets.Data.B2 = { t: "n", f: "1+1" };
  });
  const inspection = inspectWorkbook(XLSX, buffer);
  assert.throws(
    () => dedupeWorkbook(XLSX, buffer, processOptions(inspection, { compare: [1] })),
    expectCode("missing_formula_cache")
  );
});

test("merges intersecting deleted rows block while unaffected merges shift with rows", () => {
  const conflict = workbookBuffer([["Data", [
    ["Name", "Key"], ["one", "dup"], ["two", "dup"], ["three", "keep"]
  ]]], (workbook) => {
    workbook.Sheets.Data["!merges"] = [XLSX.utils.decode_range("A2:A3")];
  });
  const conflictInspection = inspectWorkbook(XLSX, conflict);
  assert.throws(
    () => dedupeWorkbook(XLSX, conflict, processOptions(conflictInspection, { compare: [1] })),
    expectCode("merge_conflict")
  );

  const safe = workbookBuffer([["Data", [
    ["Name", "Key"], ["one", "dup"], ["two", "dup"], ["three", "x"], ["", "y"]
  ]]], (workbook) => {
    workbook.Sheets.Data["!merges"] = [XLSX.utils.decode_range("A4:A5")];
  });
  const safeInspection = inspectWorkbook(XLSX, safe);
  const result = dedupeWorkbook(XLSX, safe, processOptions(safeInspection, { compare: [1] }));
  const reopened = XLSX.read(result.buffer, { type: "array" });
  assert.deepEqual(reopened.Sheets.Data["!merges"], [XLSX.utils.decode_range("A3:A4")]);
});

test("advanced workbook warnings require confirmation only when rows will be rewritten", () => {
  const buffer = workbookBuffer([["Data", [["ID"], ["x"], ["x"]]]], (workbook) => {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Names = [{ Name: "TrackedRange", Ref: "Data!$A$1:$A$3" }];
  });
  const inspection = inspectWorkbook(XLSX, buffer);
  assert(inspection.warnings.some(({ code }) => code === "defined_names"));
  assert.throws(
    () => dedupeWorkbook(XLSX, buffer, processOptions(inspection, { confirmedWarningCodes: [] })),
    expectCode("warning_confirmation_required")
  );
  assert.equal(dedupeWorkbook(XLSX, buffer, processOptions(inspection)).stats.removed, 1);
});

test("empty data, invalid comparisons, and declared cell budgets use stable error codes", () => {
  const headerOnly = workbookBuffer([["Data", [["ID"]]]]);
  const inspection = inspectWorkbook(XLSX, headerOnly);
  assert.throws(
    () => dedupeWorkbook(XLSX, headerOnly, processOptions(inspection)),
    expectCode("no_data_rows")
  );

  const data = workbookBuffer([["Data", [["ID"], ["x"]]]]);
  const dataInspection = inspectWorkbook(XLSX, data);
  assert.throws(
    () => dedupeWorkbook(XLSX, data, processOptions(dataInspection, { compare: [] })),
    expectCode("comparison_required")
  );

  const hugeXlsx = {
    version: "0.20.3",
    read() {
      return {
        SheetNames: ["Huge"],
        Sheets: { Huge: { "!ref": "A1:XFD1048576" } },
        Workbook: { Sheets: [{ name: "Huge", Hidden: 0 }] }
      };
    },
    utils: XLSX.utils
  };
  assert.throws(() => inspectWorkbook(hugeXlsx, new ArrayBuffer(1)), expectCode("workbook_cell_limit"));
});

test("scattered duplicate deletions compact remaining rows in original order", () => {
  const buffer = workbookBuffer([["Data", [
    ["ID"],
    ["r0"], ["r1"], ["r0"], ["r3"], ["r4"], ["r3"], ["r6"], ["r4"], ["r8"]
  ]]]);
  const inspection = inspectWorkbook(XLSX, buffer);
  const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection));

  assert.deepEqual(result.stats, {
    total: 9,
    unique: 6,
    removed: 3,
    duplicates: 3,
    emptyRemoved: 0,
    reduction: 33.3
  });
  assert.deepEqual(rowsFrom(result.buffer), [
    ["ID"], ["r0"], ["r1"], ["r3"], ["r4"], ["r6"], ["r8"]
  ]);
});

test("seeded randomized workbooks match an independent survivor reference after rebuild", () => {
  let seed = 0xd00d;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pool = ["a", "b", "c", "d"];
  const referenceSurvivors = (rows, keep) => {
    const byKey = new Map();
    rows.forEach((cells, index) => {
      const key = JSON.stringify(cells);
      if (!byKey.has(key) || keep === "last") byKey.set(key, index);
    });
    return [...byKey.values()]
      .sort((left, right) => left - right)
      .map((index) => rows[index]);
  };

  for (let round = 0; round < 60; round += 1) {
    const columns = 1 + Math.floor(random() * 3);
    const header = Array.from({ length: columns }, (_, index) => `H${index}`);
    const dataRows = Array.from({ length: 2 + Math.floor(random() * 12) }, () =>
      Array.from({ length: columns }, () => pool[Math.floor(random() * pool.length)])
    );
    const keep = random() < 0.5 ? "first" : "last";
    const buffer = workbookBuffer([["Data", [header, ...dataRows]]]);
    const inspection = inspectWorkbook(XLSX, buffer);
    const result = dedupeWorkbook(XLSX, buffer, processOptions(inspection, { keep }));
    const expected = referenceSurvivors(dataRows, keep);

    assert.deepEqual(rowsFrom(result.buffer), [header, ...expected]);
    assert.equal(result.stats.total, dataRows.length);
    assert.equal(result.stats.unique, expected.length);
    assert.equal(result.stats.total, result.stats.unique + result.stats.removed);
    assert.equal(result.unchanged, expected.length === dataRows.length);
  }
});
