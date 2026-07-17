import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import * as XLSX from "../public/vendor/sheetjs-0.20.3/xlsx.mjs";

const output = path.join(process.cwd(), "tests/fixtures");
await mkdir(output, { recursive: true });

async function save(name, workbook) {
  workbook.Props = {
    ...(workbook.Props ?? {}),
    Author: "RemoveDuplicates.org QA",
    CreatedDate: new Date("2026-07-16T00:00:00.000Z")
  };
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    cellStyles: true,
    compression: true
  });
  await writeFile(path.join(output, name), buffer);
}

function workbookWithData(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Data");
  return workbook;
}

const basic = workbookWithData([
  ["ID", "Region", "Note"],
  [" A ", "East", "first hidden row"],
  ["B", "West", "keep"],
  ["a", "east", "last duplicate"],
  ["", "", ""]
]);
basic.Sheets.Data["!rows"] = [undefined, { hidden: true }, undefined, undefined, { hidden: true }];
basic.Sheets.Data["!autofilter"] = { ref: "A1:C5" };
basic.Sheets.Data.C2.v = "RDQA_PRIVATE_MARKER_71f3";
basic.Sheets.Data.C2.w = "RDQA_PRIVATE_MARKER_71f3";
XLSX.utils.book_append_sheet(basic, XLSX.utils.aoa_to_sheet([["Hidden fixture"]]), "Hidden");
basic.Workbook = { Sheets: [
  { name: "Data", Hidden: 0 },
  { name: "Hidden", Hidden: 1 }
] };
await save("excel-basic.xlsx", basic);

const warning = workbookWithData([["ID"], ["x"], ["x"]]);
warning.Workbook = {
  Names: [{ Name: "TrackedRange", Ref: "Data!$A$1:$A$3" }],
  Sheets: [{ name: "Data", Hidden: 0 }]
};
await save("excel-warning.xlsx", warning);

const formula = workbookWithData([["ID", "Calc"], ["x", 2], ["x", 2]]);
formula.Sheets.Data.B2 = { t: "n", f: "1+1", v: 2 };
await save("excel-formula.xlsx", formula);

const missingFormula = workbookWithData([["ID", "Calc"], ["x", ""], ["y", ""]]);
missingFormula.Sheets.Data.B2 = { t: "n", f: "1+1" };
await save("excel-missing-formula-cache.xlsx", missingFormula);

const merge = workbookWithData([
  ["Name", "Key"],
  ["one", "duplicate"],
  ["two", "duplicate"],
  ["three", "keep"]
]);
merge.Sheets.Data["!merges"] = [XLSX.utils.decode_range("A2:A3")];
await save("excel-merge-conflict.xlsx", merge);

const typed = workbookWithData([
  ["ID", "Date", "Amount", "Active"],
  [1, 45292, 1234.501, true],
  [2, 45293, 98.25, false],
  [3, 45292.25, 1234.504, false]
]);
typed.Sheets.Data.B2.z = "yyyy-mm-dd";
typed.Sheets.Data.B3.z = "yyyy-mm-dd";
typed.Sheets.Data.B4.z = "yyyy-mm-dd";
typed.Sheets.Data.C2.z = "$#,##0.00";
typed.Sheets.Data.C3.z = "$#,##0.00";
typed.Sheets.Data.C4.z = "$#,##0.00";
await save("excel-typed-unique.xlsx", typed);

console.log("Generated 6 sanitized XLSX fixtures in tests/fixtures.");
