import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_XLSX_COMPRESSED_BYTES,
  MAX_XLSX_ENTRY_EXPANDED_BYTES,
  MAX_XLSX_EXPANDED_BYTES,
  MAX_XLSX_ZIP_ENTRIES,
  XlsxPreflightError,
  inspectXlsxPackage,
  validateXlsxFileName
} from "../public/js/xlsx-preflight.js";

const REQUIRED_ENTRIES = Object.freeze([
  { name: "[Content_Types].xml" },
  { name: "_rels/.rels" },
  { name: "xl/workbook.xml" }
]);

function makeExtraField(id, data = Buffer.alloc(0)) {
  const extra = Buffer.alloc(4 + data.length);
  extra.writeUInt16LE(id, 0);
  extra.writeUInt16LE(data.length, 2);
  data.copy(extra, 4);
  return extra;
}

function makeZip(entries = REQUIRED_ENTRIES, options = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const flags = entry.flags ?? 0x0800;
    const method = entry.method ?? 0;
    const crc32 = entry.crc32 ?? 0;
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const localExtra = entry.localExtra ?? entry.extra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? entry.extra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(entry.localSignature ?? 0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.localFlags ?? flags, 6);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(entry.localCrc32 ?? crc32, 14);
    local.writeUInt32LE(entry.localCompressedSize ?? compressedSize, 18);
    local.writeUInt32LE(entry.localUncompressedSize ?? uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localParts.push(local, localName, localExtra, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(entry.centralSignature ?? 0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(entry.diskStart ?? 0, 34);
    central.writeUInt32LE(entry.localHeaderOffset ?? localOffset, 42);
    centralParts.push(central, name, centralExtra);

    localOffset += local.length + localName.length + localExtra.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const between = options.betweenCentralAndEocd ?? Buffer.alloc(0);
  const comment = Buffer.from(options.comment ?? "");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(options.eocdSignature ?? 0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options.centralDiskNumber ?? 0, 6);
  eocd.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8);
  eocd.writeUInt16LE(options.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(options.centralSize ?? centralDirectory.length, 12);
  eocd.writeUInt32LE(options.centralOffset ?? localOffset, 16);
  eocd.writeUInt16LE(options.commentLength ?? comment.length, 20);

  return Buffer.concat([...localParts, centralDirectory, between, eocd, comment]);
}

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function inspect(buffer) {
  return inspectXlsxPackage(asArrayBuffer(buffer));
}

function expectCode(run, code, messagePattern) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof XlsxPreflightError);
    assert.equal(error.code, code);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });
}

test("exports the fixed XLSX package limits", () => {
  assert.equal(MAX_XLSX_COMPRESSED_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_XLSX_ZIP_ENTRIES, 2_000);
  assert.equal(MAX_XLSX_EXPANDED_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_XLSX_ENTRY_EXPANDED_BYTES, 50 * 1024 * 1024);
});

test("accepts only .xlsx filenames and gives dedicated format guidance", () => {
  assert.equal(validateXlsxFileName("report.xlsx"), true);
  assert.equal(validateXlsxFileName("REPORT.XLSX"), true);

  const dedicated = new Map([
    ["legacy.xls", /\.xls files/i],
    ["macros.xlsm", /macro-enabled \.xlsm/i],
    ["sheet.ods", /\.ods files/i],
    ["sheet.numbers", /numbers files/i]
  ]);
  for (const [name, message] of dedicated) {
    expectCode(() => validateXlsxFileName(name), "unsupported_format", message);
  }

  for (const name of ["report", "report.csv", "report.xlsx.exe", "", null]) {
    expectCode(
      () => validateXlsxFileName(name),
      "unsupported_extension",
      /only \.xlsx files/i
    );
  }
});

test("inspects a minimal valid XLSX ZIP and returns bounded metadata", () => {
  const archive = makeZip([
    ...REQUIRED_ENTRIES,
    { name: "xl/worksheets/sheet1.xml", method: 8 }
  ]);
  const result = inspect(archive);

  assert.equal(result.compressedBytes, archive.length);
  assert.equal(result.entryCount, 4);
  assert.equal(result.expandedBytes, 0);
  assert.deepEqual(
    result.entries.map(({ name, method }) => ({ name, method })),
    [
      { name: "[Content_Types].xml", method: 0 },
      { name: "_rels/.rels", method: 0 },
      { name: "xl/workbook.xml", method: 0 },
      { name: "xl/worksheets/sheet1.xml", method: 8 }
    ]
  );
});

test("rejects input larger than the compressed file limit", () => {
  expectCode(
    () => inspectXlsxPackage(new ArrayBuffer(MAX_XLSX_COMPRESSED_BYTES + 1)),
    "compressed_limit",
    /10 MiB/i
  );
});

test("rejects too many ZIP entries without a large payload fixture", () => {
  const entries = [
    ...REQUIRED_ENTRIES,
    ...Array.from({ length: MAX_XLSX_ZIP_ENTRIES - 2 }, (_, index) => ({
      name: `xl/worksheets/empty-${index}.xml`
    }))
  ];
  expectCode(() => inspect(makeZip(entries)), "zip_entry_limit", /2,000/);
});

test("rejects single-entry and aggregate declared expanded-size limits", () => {
  expectCode(
    () =>
      inspect(
        makeZip([
          ...REQUIRED_ENTRIES,
          {
            name: "xl/worksheets/large.xml",
            uncompressedSize: MAX_XLSX_ENTRY_EXPANDED_BYTES + 1
          }
        ])
      ),
    "zip_expanded_limit",
    /50 MiB/i
  );

  expectCode(
    () =>
      inspect(
        makeZip(
          REQUIRED_ENTRIES.map((entry) => ({
            ...entry,
            uncompressedSize: 40 * 1024 * 1024
          }))
        )
      ),
    "zip_expanded_limit",
    /100 MiB/i
  );
});

test("maps OLE compound files and encrypted ZIP flags to encrypted", () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  expectCode(() => inspect(ole), "encrypted", /password-protected|encrypted/i);

  for (const flags of [0x0001, 0x0040, 0x0801, 0x0840]) {
    expectCode(
      () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], flags }, ...REQUIRED_ENTRIES.slice(1)])),
      "encrypted",
      /encrypted/i
    );
  }
});

test("rejects multi-volume ZIP metadata", () => {
  for (const options of [
    { diskNumber: 1 },
    { centralDiskNumber: 1 },
    { entriesOnDisk: 2 }
  ]) {
    expectCode(() => inspect(makeZip(REQUIRED_ENTRIES, options)), "invalid_package", /multi-volume/i);
  }

  expectCode(
    () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], diskStart: 1 }, ...REQUIRED_ENTRIES.slice(1)])),
    "invalid_package",
    /multi-volume/i
  );
});

test("rejects ZIP64 sentinels, locator records, and 0x0001 extra fields", () => {
  for (const options of [
    { totalEntries: 0xffff },
    { entriesOnDisk: 0xffff },
    { centralSize: 0xffffffff },
    { centralOffset: 0xffffffff }
  ]) {
    expectCode(() => inspect(makeZip(REQUIRED_ENTRIES, options)), "invalid_package", /ZIP64/i);
  }

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  expectCode(
    () => inspect(makeZip(REQUIRED_ENTRIES, { betweenCentralAndEocd: locator })),
    "invalid_package",
    /ZIP64/i
  );

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  expectCode(
    () => inspect(makeZip(REQUIRED_ENTRIES, { betweenCentralAndEocd: zip64Eocd })),
    "invalid_package",
    /ZIP64/i
  );

  const zip64Extra = makeExtraField(0x0001);
  expectCode(
    () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], centralExtra: zip64Extra }, ...REQUIRED_ENTRIES.slice(1)])),
    "invalid_package",
    /ZIP64/i
  );
  expectCode(
    () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], localExtra: zip64Extra }, ...REQUIRED_ENTRIES.slice(1)])),
    "invalid_package",
    /ZIP64/i
  );
});

test("rejects unsafe entry names and case-insensitive duplicates", () => {
  for (const name of [
    "../evil.xml",
    "safe/../evil.xml",
    "/absolute.xml",
    "C:/absolute.xml",
    "\\\\server\\share.xml",
    "safe\\evil.xml",
    "nul\0evil.xml"
  ]) {
    expectCode(
      () => inspect(makeZip([...REQUIRED_ENTRIES, { name }])),
      "invalid_package",
      /unsafe ZIP entry name/i
    );
  }

  expectCode(
    () => inspect(makeZip([...REQUIRED_ENTRIES, { name: "XL/WORKBOOK.XML" }])),
    "invalid_package",
    /duplicate ZIP entry/i
  );
});

test("rejects unsupported compression methods", () => {
  expectCode(
    () =>
      inspect(
        makeZip([{ ...REQUIRED_ENTRIES[0], method: 12 }, ...REQUIRED_ENTRIES.slice(1)])
      ),
    "unsupported_format",
    /compression method/i
  );
});

test("rejects malformed EOCD and central directory records", () => {
  expectCode(() => inspect(Buffer.from("not a zip")), "invalid_package", /XLSX package/i);
  expectCode(
    () => inspect(makeZip(REQUIRED_ENTRIES, { comment: "x", commentLength: 0 })),
    "invalid_package",
    /end of central directory/i
  );
  expectCode(
    () => inspect(makeZip(REQUIRED_ENTRIES, { centralSize: 1 })),
    "invalid_package",
    /central directory/i
  );
  expectCode(
    () =>
      inspect(
        makeZip([{ ...REQUIRED_ENTRIES[0], centralSignature: 0 }, ...REQUIRED_ENTRIES.slice(1)])
      ),
    "invalid_package",
    /central directory/i
  );
  expectCode(
    () => inspect(makeZip(REQUIRED_ENTRIES, { totalEntries: 4, entriesOnDisk: 4 })),
    "invalid_package",
    /central directory/i
  );
});

test("rejects malformed local headers and inconsistent local metadata", () => {
  const cases = [
    { localSignature: 0 },
    { localName: "different.xml" },
    { localMethod: 8 },
    { localFlags: 0 },
    { localCompressedSize: 1 },
    { localUncompressedSize: 1 },
    { localCrc32: 1 },
    { localHeaderOffset: 0xffffffff }
  ];

  for (const mutation of cases) {
    expectCode(
      () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], ...mutation }, ...REQUIRED_ENTRIES.slice(1)])),
      "invalid_package",
      /local ZIP header/i
    );
  }

  expectCode(
    () =>
      inspect(
        makeZip([
          { ...REQUIRED_ENTRIES[0], compressedSize: 16, localCompressedSize: 16 },
          ...REQUIRED_ENTRIES.slice(1)
        ])
      ),
    "invalid_package",
    /local ZIP data/i
  );
});

test("allows data-descriptor local size placeholders", () => {
  const archive = makeZip([
    {
      ...REQUIRED_ENTRIES[0],
      data: "x",
      flags: 0x0808,
      localCrc32: 0,
      localCompressedSize: 0,
      localUncompressedSize: 0
    },
    ...REQUIRED_ENTRIES.slice(1)
  ]);
  assert.equal(inspect(archive).entryCount, 3);
});

test("rejects malformed extra fields", () => {
  const malformed = Buffer.from([0x02, 0x00, 0x04, 0x00]);
  expectCode(
    () => inspect(makeZip([{ ...REQUIRED_ENTRIES[0], centralExtra: malformed }, ...REQUIRED_ENTRIES.slice(1)])),
    "invalid_package",
    /extra field/i
  );
});

test("requires the three core XLSX package entries", () => {
  for (const missing of REQUIRED_ENTRIES.map(({ name }) => name)) {
    const entries = REQUIRED_ENTRIES.filter(({ name }) => name !== missing);
    expectCode(() => inspect(makeZip(entries)), "invalid_package", /required XLSX package parts/i);
  }

  expectCode(
    () =>
      inspect(
        makeZip([
          REQUIRED_ENTRIES[0],
          REQUIRED_ENTRIES[1],
          { name: "XL/WORKBOOK.XML" }
        ])
      ),
    "invalid_package",
    /required XLSX package parts/i
  );
});

test("rejects macro-bearing package entries", () => {
  for (const name of ["xl/vbaProject.bin", "XL/VBAPROJECT.BIN", "xl/macrosheets/sheet1.xml"]) {
    expectCode(
      () => inspect(makeZip([...REQUIRED_ENTRIES, { name }])),
      "unsupported_format",
      /macro-enabled/i
    );
  }
});
