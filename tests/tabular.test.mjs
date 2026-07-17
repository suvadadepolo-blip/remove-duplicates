import assert from "node:assert/strict";
import test from "node:test";

import {
  detectFormat,
  parseRecords,
  resolveFormat,
  serializeRecords,
  stripBom
} from "../public/js/tabular.js";

test("strips a leading UTF-8 BOM at both public parse entry points", () => {
  assert.equal(stripBom("\ufeffname,email"), "name,email");
  assert.equal(stripBom("name,email"), "name,email");
  assert.deepEqual(parseRecords("\ufeffname,email\nAda,ada@example.com", ","), [
    ["name", "email"],
    ["Ada", "ada@example.com"]
  ]);
});

test("parses quoted CSV and TSV fields, escapes, and embedded newlines", () => {
  assert.deepEqual(
    parseRecords('name,note\r\n"Ada, A.","line 1\nline 2"\rGrace,"said ""hello"""', ","),
    [
      ["name", "note"],
      ["Ada, A.", "line 1\nline 2"],
      ["Grace", 'said "hello"']
    ]
  );
  assert.deepEqual(parseRecords('A\t"tab\tinside"\rB\t"two\nlines"', "\t"), [
    ["A", "tab\tinside"],
    ["B", "two\nlines"]
  ]);
});

test("keeps mid-field quotes literal and accepts CRLF, LF, and lone CR", () => {
  assert.deepEqual(parseRecords('a"b,c\r\nd,e\rf,g\n', ","), [
    ['a"b', "c"],
    ["d", "e"],
    ["f", "g"]
  ]);
});

test("empty text and a single trailing newline do not create empty records", () => {
  assert.deepEqual(parseRecords("", ","), []);
  assert.deepEqual(parseRecords("a,b\n", ","), [["a", "b"]]);
});

test("serializes only fields that require quoting and round-trips semantic records", () => {
  const csv = [
    ["name", "note"],
    ["Ada, A.", 'said "hello"'],
    ["Grace", "two\nlines"]
  ];
  const tsv = [
    ["name", "note"],
    ["Ada", "tab\tinside"],
    ["Grace", "two\rparts"]
  ];

  assert.equal(
    serializeRecords(csv, ","),
    'name,note\n"Ada, A.","said ""hello"""\nGrace,"two\nlines"'
  );
  assert.deepEqual(parseRecords(serializeRecords(csv, ","), ","), csv);
  assert.deepEqual(parseRecords(serializeRecords(tsv, "\t"), "\t"), tsv);
});

test("detects tab-separated data before comma-separated data", () => {
  assert.deepEqual(detectFormat("name\tcity,note\nAda\tParis,FR"), {
    kind: "tsv",
    delimiter: "\t",
    columns: 2
  });
  assert.deepEqual(detectFormat("name,email\nAda,ada@example.com"), {
    kind: "csv",
    delimiter: ",",
    columns: 2
  });
});

test("keeps ambiguous and inconsistent comma prose in lines mode", () => {
  assert.deepEqual(detectFormat("A sentence, with a comma."), {
    kind: "lines",
    delimiter: null,
    columns: 1
  });
  assert.deepEqual(detectFormat("one,two\nthree,four,five\nplain"), {
    kind: "lines",
    delimiter: null,
    columns: 1
  });
});

test("uses the modal column count with an eighty-percent threshold", () => {
  const text = ["a,b,c", "d,e,f", "g,h", "i,j,k", "l,m,n"].join("\n");
  assert.deepEqual(detectFormat(text), {
    kind: "csv",
    delimiter: ",",
    columns: 3
  });
});

test("forced table mode prefers tabs and otherwise falls back to comma", () => {
  assert.deepEqual(resolveFormat("left\tright\nsingle", { format: "table" }), {
    kind: "tsv",
    delimiter: "\t",
    columns: 2
  });
  assert.deepEqual(resolveFormat("one\ntwo", { format: "table" }), {
    kind: "csv",
    delimiter: ",",
    columns: 1
  });
  assert.deepEqual(resolveFormat("a,b,c\nd,e", { format: "table" }), {
    kind: "csv",
    delimiter: ",",
    columns: 3
  });
});

test("manual lines mode always wins over detection", () => {
  assert.deepEqual(resolveFormat("a\tb\nc\td", { format: "lines" }), {
    kind: "lines",
    delimiter: null,
    columns: 1
  });
});

