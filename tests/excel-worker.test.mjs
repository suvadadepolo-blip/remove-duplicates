import assert from "node:assert/strict";
import test from "node:test";

import * as XLSX from "../public/vendor/sheetjs-0.20.3/xlsx.mjs";
import { createExcelWorkerRuntime } from "../public/js/excel-worker.js";

function fixtureBuffer(rows = [["ID", "Value"], ["a", "first"], ["b", "keep"], ["a", "last"]]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Data");
  return XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    compression: true
  });
}

function captureRuntime(loadParser = async () => XLSX) {
  const messages = [];
  const runtime = createExcelWorkerRuntime({
    loadParser,
    postMessage(payload, transfer = []) {
      messages.push({ payload, transfer });
    }
  });
  return { runtime, messages };
}

function dedupeOptions(overrides = {}) {
  return {
    header: true,
    compare: [0],
    trim: false,
    ignoreCase: false,
    removeEmpty: false,
    keep: "first",
    confirmedWarningCodes: [],
    ...overrides
  };
}

function outputRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "array" });
  return XLSX.utils.sheet_to_json(workbook.Sheets.Data, {
    header: 1,
    raw: true,
    defval: ""
  });
}

test("inspect accepts a transferred ArrayBuffer and returns the matching request id", async () => {
  const source = fixtureBuffer();
  const transferred = structuredClone(
    { type: "inspect", id: 7, name: "records.xlsx", buffer: source },
    { transfer: [source] }
  );
  assert.equal(source.byteLength, 0);

  const { runtime, messages } = captureRuntime();
  await runtime.handle(transferred);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "inspected");
  assert.equal(messages[0].payload.id, 7);
  assert.equal(messages[0].payload.name, "records.xlsx");
  assert.deepEqual(messages[0].payload.sheets.map(({ name }) => name), ["Data"]);
  assert.deepEqual(messages[0].transfer, []);
});

test("dedupe reparses original bytes on every run and transfers result buffers", async () => {
  const { runtime, messages } = captureRuntime();
  await runtime.handle({ type: "inspect", id: 1, name: "records.xlsx", buffer: fixtureBuffer() });
  const sheetIndex = messages.at(-1).payload.sheets[0].index;

  await runtime.handle({
    type: "dedupe",
    id: 2,
    sheetIndex,
    options: dedupeOptions({ keep: "first" })
  });
  await runtime.handle({
    type: "dedupe",
    id: 3,
    sheetIndex,
    options: dedupeOptions({ keep: "last" })
  });

  const first = messages.find(({ payload }) => payload.id === 2);
  const last = messages.find(({ payload }) => payload.id === 3);
  assert.equal(first.payload.type, "result");
  assert.equal(last.payload.type, "result");
  assert.deepEqual(first.transfer, [first.payload.buffer]);
  assert.deepEqual(last.transfer, [last.payload.buffer]);
  assert.deepEqual(outputRows(first.payload.buffer), [
    ["ID", "Value"], ["a", "first"], ["b", "keep"]
  ]);
  assert.deepEqual(outputRows(last.payload.buffer), [
    ["ID", "Value"], ["b", "keep"], ["a", "last"]
  ]);
});

test("dispose clears workbook state and later work returns a stable error", async () => {
  const { runtime, messages } = captureRuntime();
  await runtime.handle({ type: "inspect", id: 1, name: "records.xlsx", buffer: fixtureBuffer() });
  await runtime.handle({ type: "dispose", id: 2 });
  await runtime.handle({ type: "dedupe", id: 3, sheetIndex: 0, options: dedupeOptions() });

  assert.deepEqual(messages.at(-1).payload, {
    type: "error",
    id: 3,
    error: {
      code: "invalid_package",
      message: "Choose an XLSX file before processing."
    }
  });
});

test("parser load failure is isolated as parser_unavailable", async () => {
  const { runtime, messages } = captureRuntime(async () => {
    throw new Error("network details must not escape");
  });
  await runtime.handle({ type: "inspect", id: 11, name: "records.xlsx", buffer: fixtureBuffer() });

  assert.deepEqual(messages[0].payload, {
    type: "error",
    id: 11,
    error: {
      code: "parser_unavailable",
      message: "The local XLSX parser could not be loaded."
    }
  });
});

test("extension and corrupt-package errors keep ids and fixed user-safe messages", async () => {
  const { runtime, messages } = captureRuntime();
  await runtime.handle({ type: "inspect", id: 21, name: "legacy.xls", buffer: new ArrayBuffer(4) });
  await runtime.handle({ type: "inspect", id: 22, name: "fake.xlsx", buffer: new Uint8Array([1, 2, 3, 4]).buffer });

  assert.equal(messages[0].payload.id, 21);
  assert.equal(messages[0].payload.error.code, "unsupported_format");
  assert.match(messages[0].payload.error.message, /\.xlsx/);
  assert.equal(messages[1].payload.id, 22);
  assert.equal(messages[1].payload.error.code, "invalid_package");
  assert.doesNotMatch(messages[1].payload.error.message, /1, 2, 3, 4/);
});
