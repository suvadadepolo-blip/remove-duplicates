import assert from "node:assert/strict";
import test from "node:test";

import {
  DedupeCompareError,
  DedupeLimitError,
  MAX_TEXT_BYTES,
  WORKER_CHARACTER_THRESHOLD,
  WORKER_LINE_THRESHOLD,
  dedupeInput,
  dedupeInteractiveInput,
  dedupeRecords,
  dedupeText,
  measureTextBytes,
  selectSurvivorRows,
  shouldUseWorker
} from "../public/js/dedupe.js";

test("multi-column comparison is canonical, collision-free, and does not mutate its options", () => {
  const compare = [2, 0];
  const records = [
    ["A", "first", "X"],
    ["A", "second", "X"],
    ["A,X", "third", ""],
    ["A", "fourth", "X"]
  ];

  const forward = dedupeRecords(records, { compare, keep: "last" });
  const reverse = dedupeRecords(records, { compare: [0, 2], keep: "last" });

  assert.deepEqual(compare, [2, 0]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.records, [
    ["A,X", "third", ""],
    ["A", "fourth", "X"]
  ]);
  assert.equal(forward.stats.duplicates, 2);
});

test("multi-column comparison rejects empty, duplicate, invalid, and out-of-range indices", () => {
  const records = [["A", "B"]];
  assert.throws(() => dedupeRecords(records, { compare: [] }), /non-empty/);
  assert.throws(() => dedupeRecords(records, { compare: [0, 0] }), /unique/);
  assert.throws(() => dedupeRecords(records, { compare: [0, -1] }), /non-negative integer/);
  assert.throws(() => dedupeRecords(records, { compare: [0, 1.5] }), /non-negative integer/);
  assert.throws(() => dedupeRecords(records, { compare: [0, 2] }), /outside/);
});

test("survivor selection preserves source cells and applies trim only to comparison keys", () => {
  const records = [
    [" A ", " First "],
    ["a", " Latest "],
    [" ", "\t"],
    [" B ", " Keep "]
  ];
  const snapshot = structuredClone(records);

  const result = selectSurvivorRows(records, {
    compare: [0],
    trim: true,
    ignoreCase: true,
    removeEmpty: true,
    keep: "last"
  });

  assert.deepEqual(records, snapshot);
  assert.deepEqual(result.survivorIndices, [1, 3]);
  assert.deepEqual(result.stats, {
    total: 4,
    unique: 2,
    removed: 2,
    duplicates: 1,
    emptyRemoved: 1,
    reduction: 50
  });
});

test("survivor selection sorts by visible selected cell text rather than serialized keys", () => {
  const result = selectSurvivorRows(
    [["3", "item10"], ["1", "item2"], ["2", "item1"]],
    { compare: [1], order: "sort" }
  );
  assert.deepEqual(result.survivorIndices, [2, 1, 0]);
});

test("record row keys do not collide when delimiter placement differs", () => {
  const result = dedupeRecords([
    ["a,b", "c"],
    ["a", "b,c"],
    ["a,b", "c"]
  ]);

  assert.deepEqual(result.records, [
    ["a,b", "c"],
    ["a", "b,c"]
  ]);
  assert.equal(result.stats.duplicates, 1);
});

test("column comparison supports headers, ragged rows, and keep-last positioning", () => {
  const result = dedupeRecords(
    [
      ["ID", "Name"],
      ["1", "Alpha"],
      ["2", "Beta"],
      ["1", "ALPHA latest"],
      ["missing"],
      ["also missing"]
    ],
    { compare: 0, header: true, keep: "last" }
  );

  assert.deepEqual(result.records, [
    ["ID", "Name"],
    ["2", "Beta"],
    ["1", "ALPHA latest"],
    ["missing"],
    ["also missing"]
  ]);
  assert.deepEqual(result.stats, {
    total: 5,
    unique: 4,
    removed: 1,
    duplicates: 1,
    emptyRemoved: 0,
    reduction: 20
  });

  const ragged = dedupeRecords([["A"], ["B"], ["C", "value"]], { compare: 1 });
  assert.deepEqual(ragged.records, [["A"], ["C", "value"]]);
});

test("record trimming changes every output cell while case folding only compare keys", () => {
  const result = dedupeRecords(
    [
      ["  ID  ", "  Name  "],
      [" A ", " First "],
      ["a", " Latest "],
      ["  ", "\t"],
      [" B ", " Keep "]
    ],
    {
      compare: 0,
      header: true,
      trim: true,
      ignoreCase: true,
      removeEmpty: true,
      keep: "last"
    }
  );

  assert.deepEqual(result.records, [
    ["ID", "Name"],
    ["a", "Latest"],
    ["B", "Keep"]
  ]);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.emptyRemoved, 1);
});

test("headers stay first, stay out of stats, and header-only output has zero unique rows", () => {
  const sorted = dedupeRecords(
    [["Item"], ["item10"], ["item2"], ["item1"]],
    { header: true, order: "sort" }
  );
  assert.deepEqual(sorted.records, [["Item"], ["item1"], ["item2"], ["item10"]]);
  assert.equal(sorted.stats.total, 3);
  assert.equal(sorted.stats.unique, 3);

  const headerOnly = dedupeRecords([["Item"]], { header: true });
  assert.deepEqual(headerOnly.records, [["Item"]]);
  assert.equal(headerOnly.stats.total, 0);
  assert.equal(headerOnly.stats.unique, 0);
});

test("record sorting uses visible cell text rather than serialized JSON keys", () => {
  const byColumn = dedupeRecords(
    [["3", "item10"], ["1", "item2"], ["2", "item1"]],
    { compare: 1, order: "sort" }
  );
  assert.deepEqual(byColumn.records, [["2", "item1"], ["1", "item2"], ["3", "item10"]]);

  const byRow = dedupeRecords([["item10", "z"], ["item2", "a"], ["item1", "q"]], {
    order: "sort"
  });
  assert.deepEqual(byRow.records, [["item1", "q"], ["item2", "a"], ["item10", "z"]]);
});

test("the unified input path preserves line results and returns exact table metadata", () => {
  const lines = dedupeInput("a\na\nb", { format: "lines" });
  assert.equal(lines.text, "a\nb");
  assert.equal(lines.table, null);

  const table = dedupeInput("Name\tCity\nAda\tParis\nAda\tLondon", {
    format: "auto",
    compare: 0,
    header: true
  });
  assert.equal(table.text, "Name\tCity\nAda\tParis");
  assert.deepEqual(table.lines, ["Name\tCity", "Ada\tParis"]);
  assert.deepEqual(table.table, {
    delimiter: "\t",
    kind: "tsv",
    columns: 2,
    header: true,
    headerCells: ["Name", "City"]
  });
  assert.deepEqual(table.stats, {
    total: 2,
    unique: 1,
    removed: 1,
    duplicates: 1,
    emptyRemoved: 0,
    reduction: 50
  });

  const headerOnly = dedupeInput("Name,City", {
    format: "table",
    header: true
  });
  assert.deepEqual(headerOnly.lines, ["Name,City"]);
  assert.equal(headerOnly.stats.unique, 0);
});

test("interactive input falls back to entire-row comparison when a prior column disappears", () => {
  const options = { format: "auto", compare: 2, header: true };
  assert.throws(
    () => dedupeInput("Name\tCity\nA\tParis\nB\tRome", options),
    (error) => error instanceof DedupeCompareError && error.kind === "compare"
  );
  const result = dedupeInteractiveInput("Name\tCity\nA\tParis\nB\tRome", options);
  assert.equal(result.text, "Name\tCity\nA\tParis\nB\tRome");
  assert.equal(result.stats.unique, 2);
  assert.equal(options.compare, 2);
});

test("record and unified input options reject invalid shapes", () => {
  assert.throws(() => dedupeRecords([], { compare: -1 }), /compare/);
  assert.throws(() => dedupeRecords([], { compare: "0" }), /compare/);
  assert.throws(() => dedupeRecords([], { header: "yes" }), /header must be a boolean/);
  assert.throws(() => dedupeInput("a,b\nc,d", { format: "grid" }), /format/);
});

test("treats an empty string as zero lines", () => {
  assert.deepEqual(dedupeText(""), {
    text: "",
    lines: [],
    sourceBytes: 0,
    stats: {
      total: 0,
      unique: 0,
      removed: 0,
      duplicates: 0,
      emptyRemoved: 0,
      reduction: 0
    }
  });
});

test("keeps the first occurrence in source order by default", () => {
  const result = dedupeText("pear\napple\npear\nbanana\napple");

  assert.equal(result.text, "pear\napple\nbanana");
  assert.deepEqual(result.lines, ["pear", "apple", "banana"]);
  assert.deepEqual(result.stats, {
    total: 5,
    unique: 3,
    removed: 2,
    duplicates: 2,
    emptyRemoved: 0,
    reduction: 40
  });
});

test("applies trim before case-insensitive keys and reports empty removals separately", () => {
  const result = dedupeText("  Alpha  \nalpha\n \t \nBETA\n beta ", {
    ignoreCase: true,
    trim: true,
    removeEmpty: true
  });

  assert.deepEqual(result.lines, ["Alpha", "BETA"]);
  assert.deepEqual(result.stats, {
    total: 5,
    unique: 2,
    removed: 3,
    duplicates: 2,
    emptyRemoved: 1,
    reduction: 60
  });
});

test("removeEmpty checks trimmed whitespace without changing retained text", () => {
  const result = dedupeText("  keep me  \n   \n\t\nnext", {
    removeEmpty: true
  });

  assert.deepEqual(result.lines, ["  keep me  ", "next"]);
  assert.equal(result.stats.emptyRemoved, 2);
  assert.equal(result.stats.duplicates, 0);
});

test("keep last retains the final value and its original position", () => {
  const result = dedupeText("Alpha\nsecond\nalpha\nthird\nSECOND", {
    ignoreCase: true,
    keep: "last"
  });

  assert.deepEqual(result.lines, ["alpha", "third", "SECOND"]);
  assert.equal(result.stats.duplicates, 2);
});

test("sort uses stable English natural ordering after deduplication", () => {
  const source = "item10\nitem2\nBanana\nbanana\nitem1\nbanana";
  const sensitive = dedupeText(source, { order: "sort" });
  const insensitive = dedupeText(source, {
    ignoreCase: true,
    keep: "last",
    order: "sort"
  });

  assert.deepEqual(sensitive.lines, ["banana", "Banana", "item1", "item2", "item10"]);
  assert.deepEqual(insensitive.lines, ["banana", "item1", "item2", "item10"]);
});

test("normalizes LF, CRLF, and lone CR before deduplication", () => {
  const expected = dedupeText("one\ntwo\none\n");
  const crlf = dedupeText("one\r\ntwo\r\none\r\n");
  const cr = dedupeText("one\rtwo\rone\r");

  assert.deepEqual(crlf.lines, expected.lines);
  assert.deepEqual(crlf.stats, expected.stats);
  assert.deepEqual(cr.lines, expected.lines);
  assert.deepEqual(cr.stats, expected.stats);
  assert.deepEqual(expected.lines, ["one", "two", ""]);
  assert.equal(expected.text, "one\ntwo\n");
  assert.equal(expected.stats.total, 4);
});

test("handles repeated empty lines according to removeEmpty", () => {
  const retained = dedupeText("\n\n");
  const removed = dedupeText("\n\n", { removeEmpty: true });

  assert.deepEqual(retained.lines, [""]);
  assert.deepEqual(retained.stats, {
    total: 3,
    unique: 1,
    removed: 2,
    duplicates: 2,
    emptyRemoved: 0,
    reduction: 66.7
  });
  assert.deepEqual(removed.lines, []);
  assert.equal(removed.stats.emptyRemoved, 3);
  assert.equal(removed.stats.duplicates, 0);
});

test("preserves Unicode, emoji, Chinese, and canonically distinct text", () => {
  const result = dedupeText("你好\n👩‍💻\n你好\n👩‍💻\ncafé\ncafé");

  assert.deepEqual(result.lines, ["你好", "👩‍💻", "café", "café"]);
  assert.equal(result.stats.duplicates, 2);
  assert.equal(measureTextBytes("你好👩‍💻"), 17);
});

test("combines keep-last, trim, empty removal, case folding, and sorting", () => {
  const result = dedupeText(" Z10 \n\n z2\nZ10\n z1 \nZ2 ", {
    ignoreCase: true,
    trim: true,
    removeEmpty: true,
    keep: "last",
    order: "sort"
  });

  assert.deepEqual(result.lines, ["z1", "Z2", "Z10"]);
  assert.deepEqual(result.stats, {
    total: 6,
    unique: 3,
    removed: 3,
    duplicates: 2,
    emptyRemoved: 1,
    reduction: 50
  });
});

test("validates input and option types", () => {
  assert.throws(() => dedupeText(null), /Text must be a string/);
  assert.throws(() => dedupeText("text", null), /options must be an object/);
  assert.throws(() => dedupeText("text", { trim: "yes" }), /trim must be a boolean/);
  assert.throws(() => dedupeText("text", { keep: "middle" }), /keep must be either/);
  assert.throws(() => dedupeText("text", { order: "random" }), /order must be either/);
});

test("measures UTF-8 bytes and includes worker thresholds", () => {
  assert.equal(measureTextBytes("abc"), 3);
  assert.equal(measureTextBytes("😀"), 4);
  assert.equal(shouldUseWorker("x".repeat(WORKER_CHARACTER_THRESHOLD - 1)), false);
  assert.equal(shouldUseWorker("x".repeat(WORKER_CHARACTER_THRESHOLD)), true);

  const belowLineThreshold = Array(WORKER_LINE_THRESHOLD - 1).fill("x").join("\n");
  const atLineThreshold = Array(WORKER_LINE_THRESHOLD).fill("x").join("\n");
  assert.equal(shouldUseWorker(belowLineThreshold), false);
  assert.equal(shouldUseWorker(atLineThreshold), true);
});

test("allows exactly 5 MiB and rejects larger UTF-8 input with a size error", () => {
  const atLimit = "x".repeat(MAX_TEXT_BYTES);
  assert.equal(dedupeText(atLimit).stats.unique, 1);

  assert.throws(
    () => dedupeText(`${atLimit}😀`),
    (error) =>
      error instanceof DedupeLimitError &&
      error.kind === "size" &&
      error.limit === MAX_TEXT_BYTES &&
      error.actual === MAX_TEXT_BYTES + 4
  );
});

test("deduplicates an approximately 1 MiB input correctly", () => {
  const uniqueLines = Array.from(
    { length: 400 },
    (_, index) => `line-${String(index).padStart(3, "0")}-${"x".repeat(56)}`
  );
  const text = Array.from({ length: 40 }, () => uniqueLines).flat().join("\n");

  assert.ok(measureTextBytes(text) > 1_000_000);
  assert.ok(measureTextBytes(text) < 1_100_000);
  assert.equal(shouldUseWorker(text), true);

  const result = dedupeText(text);
  assert.equal(result.sourceBytes, measureTextBytes(text));
  assert.deepEqual(result.lines, uniqueLines);
  assert.equal(result.stats.total, 16_000);
  assert.equal(result.stats.unique, 400);
  assert.equal(result.stats.duplicates, 15_600);
  assert.equal(result.stats.emptyRemoved, 0);
});

test("worker messages preserve ids and return structured success or size errors", async () => {
  const posted = [];
  let messageHandler;
  globalThis.self = {
    addEventListener(type, handler) {
      assert.equal(type, "message");
      messageHandler = handler;
    },
    postMessage(message) {
      posted.push(message);
    }
  };

  try {
    await import(`../public/js/dedupe-worker.js?test=${Date.now()}`);
    assert.equal(typeof messageHandler, "function");

    messageHandler({
      data: {
        id: 7,
        text: "one\none\ntwo",
        options: { removeEmpty: true }
      }
    });
    assert.deepEqual(posted.shift(), {
      id: 7,
      result: {
        text: "one\ntwo",
        lines: ["one", "two"],
        sourceBytes: 11,
        stats: {
          total: 3,
          unique: 2,
          removed: 1,
          duplicates: 1,
          emptyRemoved: 0,
          reduction: 33.3
        },
        table: null
      }
    });

    messageHandler({
      data: {
        id: 8,
        text: "x".repeat(MAX_TEXT_BYTES + 1),
        options: {}
      }
    });
    assert.equal(posted[0].id, 8);
    assert.equal(posted[0].error.name, "DedupeLimitError");
    assert.equal(posted[0].error.kind, "size");
    assert.match(posted[0].error.message, /must not exceed/);

    messageHandler({
      data: { type: "start", id: 9, options: { ignoreCase: true } }
    });
    messageHandler({
      data: { type: "chunk", id: 9, chunk: "Chunked\nchunk", done: false }
    });
    messageHandler({
      data: { type: "chunk", id: 9, chunk: "ed\nkept", done: true }
    });
    assert.equal(posted[1].id, 9);
    assert.equal(posted[1].result.text, "Chunked\nkept");
    assert.equal(posted[1].result.sourceBytes, 20);

    messageHandler({
      data: {
        id: 10,
        text: "Name\tCity\nA\tParis\nB\tRome",
        options: { format: "auto", compare: 2, header: true }
      }
    });
    assert.equal(posted[2].id, 10);
    assert.equal(posted[2].result.stats.unique, 2);
    assert.equal(posted[2].result.table.columns, 2);

    messageHandler({
      data: {
        type: "start",
        id: 12,
        options: { format: "auto", compare: 0, header: true }
      }
    });
    messageHandler({
      data: {
        type: "chunk",
        id: 12,
        chunk: "Name\tNote\nAda\t\"two\n",
        done: false
      }
    });
    messageHandler({
      data: {
        type: "chunk",
        id: 12,
        chunk: "lines\"\nAda\tlatest",
        done: true
      }
    });
    assert.equal(posted[3].id, 12);
    assert.equal(posted[3].result.text, 'Name\tNote\nAda\t"two\nlines"');
    assert.deepEqual(posted[3].result.table, {
      delimiter: "\t",
      kind: "tsv",
      columns: 2,
      header: true,
      headerCells: ["Name", "Note"]
    });
    assert.equal(posted[3].result.stats.unique, 1);

    messageHandler({ data: { type: "start", id: 10, options: {} } });
    messageHandler({ data: { type: "cancel", id: 10 } });
    messageHandler({
      data: { type: "chunk", id: 10, chunk: "must not process", done: true }
    });
    assert.equal(posted.length, 4);
  } finally {
    delete globalThis.self;
  }
});

test("stats invariants hold across seeded randomized survivor selections", () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pool = ["a", "A", " a", "b", "", "c"];

  for (let round = 0; round < 1000; round += 1) {
    const rows = Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
      Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        pool[Math.floor(random() * pool.length)]
      )
    );
    const header = random() < 0.5;
    const { survivorIndices, stats } = selectSurvivorRows(rows, {
      compare: "row",
      trim: random() < 0.5,
      ignoreCase: random() < 0.5,
      removeEmpty: random() < 0.5,
      keep: random() < 0.5 ? "first" : "last",
      order: "preserve",
      header
    });

    assert.equal(stats.total, rows.length - (header && rows.length > 0 ? 1 : 0));
    assert.equal(stats.unique, survivorIndices.length);
    assert.equal(stats.removed, stats.duplicates + stats.emptyRemoved);
    assert.equal(stats.total, stats.unique + stats.removed);
    assert.deepEqual(survivorIndices, [...survivorIndices].sort((left, right) => left - right));
  }
});
