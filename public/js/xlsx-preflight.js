export const MAX_XLSX_COMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_ZIP_ENTRIES = 2_000;
export const MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_XLSX_ENTRY_EXPANDED_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const EOCD_SIZE = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAGS = 0x0001 | 0x0040;
const OLE_MAGIC = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const REQUIRED_PACKAGE_ENTRIES = Object.freeze([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml"
]);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LEGACY_DECODER = new TextDecoder("windows-1252");

export class XlsxPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XlsxPreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new XlsxPreflightError(code, message);
}

export function validateXlsxFileName(name) {
  const normalizedName = typeof name === "string" ? name : "";
  const extensionMatch = normalizedName.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1].toLowerCase() ?? "";

  if (extension === ".xlsx") return true;
  if (extension === ".xls") {
    fail(
      "unsupported_format",
      "Legacy .xls files are not supported. Save a copy as .xlsx and try again."
    );
  }
  if (extension === ".xlsm") {
    fail(
      "unsupported_format",
      "Macro-enabled .xlsm files are not supported. Save a macro-free .xlsx copy and try again."
    );
  }
  if (extension === ".ods") {
    fail(
      "unsupported_format",
      "OpenDocument .ods files are not supported. Export the workbook as .xlsx and try again."
    );
  }
  if (extension === ".numbers") {
    fail(
      "unsupported_format",
      "Apple Numbers files are not supported. Export the spreadsheet as .xlsx and try again."
    );
  }

  fail("unsupported_extension", "Only .xlsx files are supported.");
}

function toBytes(input) {
  try {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
  } catch {
    // Detached buffers and invalid views are rejected below.
  }
  fail("invalid_package", "That file is not a valid XLSX package.");
}

function startsWithOleMagic(bytes) {
  return (
    bytes.length >= OLE_MAGIC.length &&
    OLE_MAGIC.every((value, index) => bytes[index] === value)
  );
}

function findEndOfCentralDirectory(bytes, view) {
  if (bytes.length < EOCD_SIZE) return -1;
  const minimumOffset = Math.max(
    0,
    bytes.length - EOCD_SIZE - MAX_ZIP_COMMENT_BYTES
  );

  for (let offset = bytes.length - EOCD_SIZE; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength === bytes.length) return offset;
  }
  return -1;
}

function isZip64Sentinel(value) {
  return value === 0xffff || value === 0xffffffff;
}

function inspectExtraFields(bytes, view, start, length) {
  const end = start + length;
  let cursor = start;

  while (cursor < end) {
    if (cursor + 4 > end) {
      fail("invalid_package", "The XLSX package has an invalid ZIP extra field.");
    }
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    cursor += 4;
    if (cursor + size > end) {
      fail("invalid_package", "The XLSX package has an invalid ZIP extra field.");
    }
    if (id === ZIP64_EXTRA_FIELD) {
      fail("invalid_package", "ZIP64 XLSX packages are not supported.");
    }
    cursor += size;
  }

  if (end > bytes.length) {
    fail("invalid_package", "The XLSX package has an invalid ZIP extra field.");
  }
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeAndValidateEntryName(nameBytes, flags) {
  if (nameBytes.length === 0) {
    fail("invalid_package", "The XLSX package has an unsafe ZIP entry name.");
  }
  for (const byte of nameBytes) {
    if (byte === 0 || byte === 0x5c) {
      fail("invalid_package", "The XLSX package has an unsafe ZIP entry name.");
    }
  }

  let name;
  try {
    name = (flags & UTF8_FLAG ? UTF8_DECODER : LEGACY_DECODER).decode(nameBytes);
  } catch {
    fail("invalid_package", "The XLSX package has an unsafe ZIP entry name.");
  }

  if (
    name.startsWith("/") ||
    /^[A-Za-z]:\//.test(name) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    fail("invalid_package", "The XLSX package has an unsafe ZIP entry name.");
  }
  return name;
}

function isMacroEntry(name) {
  const lowerName = name.toLowerCase();
  return (
    lowerName === "xl/vbaproject.bin" ||
    lowerName.endsWith("/vbaproject.bin") ||
    lowerName.startsWith("xl/macrosheets/")
  );
}

function validateLocalEntries(bytes, view, entries, centralOffset) {
  const ranges = [];

  for (const entry of entries) {
    const offset = entry.localHeaderOffset;
    if (offset + LOCAL_FILE_HEADER_SIZE > centralOffset) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }
    if (view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }

    const localFlags = view.getUint16(offset + 6, true);
    const localMethod = view.getUint16(offset + 8, true);
    const localCrc32 = view.getUint32(offset + 14, true);
    const localCompressedSize = view.getUint32(offset + 18, true);
    const localUncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + LOCAL_FILE_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const dataStart = extraStart + extraLength;

    if (dataStart > centralOffset || dataStart > bytes.length) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }
    if (localFlags & ENCRYPTED_FLAGS) {
      fail("encrypted", "Encrypted XLSX entries are not supported.");
    }
    if (localFlags !== entry.flags || localMethod !== entry.method) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }

    const localNameBytes = bytes.subarray(nameStart, extraStart);
    if (!equalBytes(localNameBytes, entry.nameBytes)) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }
    inspectExtraFields(bytes, view, extraStart, extraLength);

    if (localFlags & DATA_DESCRIPTOR_FLAG) {
      if (
        (localCrc32 !== 0 && localCrc32 !== entry.crc32) ||
        (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize) ||
        (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
      ) {
        fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
      }
    } else if (
      localCrc32 !== entry.crc32 ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      fail("invalid_package", "The XLSX package has an invalid local ZIP header.");
    }

    const dataEnd = dataStart + entry.compressedSize;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > centralOffset) {
      fail("invalid_package", "The XLSX package has invalid local ZIP data ranges.");
    }
    entry.dataOffset = dataStart;
    ranges.push({ start: offset, end: dataEnd });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      fail("invalid_package", "The XLSX package has invalid local ZIP data ranges.");
    }
  }
}

export function inspectXlsxPackage(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength > MAX_XLSX_COMPRESSED_BYTES) {
    fail("compressed_limit", "XLSX files must not exceed the 10 MiB compressed limit.");
  }
  if (startsWithOleMagic(bytes)) {
    fail(
      "encrypted",
      "Encrypted or password-protected Excel workbooks are not supported."
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset < 0) {
    fail(
      "invalid_package",
      "The XLSX package has an invalid ZIP end of central directory."
    );
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDiskNumber = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (
    isZip64Sentinel(entriesOnDisk) ||
    isZip64Sentinel(totalEntries) ||
    isZip64Sentinel(centralSize) ||
    isZip64Sentinel(centralOffset)
  ) {
    fail("invalid_package", "ZIP64 XLSX packages are not supported.");
  }
  if (
    eocdOffset >= 20 &&
    view.getUint32(eocdOffset - 20, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    fail("invalid_package", "ZIP64 XLSX packages are not supported.");
  }
  if (diskNumber !== 0 || centralDiskNumber !== 0 || entriesOnDisk !== totalEntries) {
    fail("invalid_package", "Multi-volume XLSX ZIP packages are not supported.");
  }
  if (totalEntries > MAX_XLSX_ZIP_ENTRIES) {
    fail("zip_entry_limit", "XLSX packages must not contain more than 2,000 ZIP entries.");
  }

  const centralEnd = centralOffset + centralSize;
  if (
    !Number.isSafeInteger(centralEnd) ||
    centralOffset > eocdOffset ||
    centralEnd !== eocdOffset
  ) {
    if (
      Number.isSafeInteger(centralEnd) &&
      centralEnd <= bytes.length - 4 &&
      view.getUint32(centralEnd, true) === ZIP64_EOCD_SIGNATURE
    ) {
      fail("invalid_package", "ZIP64 XLSX packages are not supported.");
    }
    fail("invalid_package", "The XLSX package has an invalid ZIP central directory.");
  }

  const entries = [];
  const seenNames = new Set();
  const exactNames = new Set();
  let expandedBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + CENTRAL_DIRECTORY_HEADER_SIZE > centralEnd ||
      view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      fail("invalid_package", "The XLSX package has an invalid ZIP central directory.");
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    const nextCursor = commentStart + commentLength;

    if (nextCursor > centralEnd) {
      fail("invalid_package", "The XLSX package has an invalid ZIP central directory.");
    }
    if (diskStart !== 0) {
      fail("invalid_package", "Multi-volume XLSX ZIP packages are not supported.");
    }
    if (flags & ENCRYPTED_FLAGS) {
      fail("encrypted", "Encrypted XLSX entries are not supported.");
    }
    if (method !== 0 && method !== 8) {
      fail(
        "unsupported_format",
        "That XLSX package uses an unsupported ZIP compression method."
      );
    }
    if (uncompressedSize > MAX_XLSX_ENTRY_EXPANDED_BYTES) {
      fail(
        "zip_expanded_limit",
        "A ZIP entry exceeds the 50 MiB declared expanded-size limit."
      );
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) {
      fail(
        "zip_expanded_limit",
        "The XLSX package exceeds the 100 MiB declared expanded-size limit."
      );
    }

    const nameBytes = bytes.subarray(nameStart, extraStart);
    const name = decodeAndValidateEntryName(nameBytes, flags);
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      fail("invalid_package", "The XLSX package contains a duplicate ZIP entry.");
    }
    seenNames.add(nameKey);
    exactNames.add(name);
    if (isMacroEntry(name)) {
      fail(
        "unsupported_format",
        "Macro-enabled Excel workbooks are not supported. Save a macro-free .xlsx copy."
      );
    }
    inspectExtraFields(bytes, view, extraStart, extraLength);

    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: 0
    });
    cursor = nextCursor;
  }

  if (cursor !== centralEnd) {
    fail("invalid_package", "The XLSX package has an invalid ZIP central directory.");
  }

  for (const requiredName of REQUIRED_PACKAGE_ENTRIES) {
    if (!exactNames.has(requiredName)) {
      fail(
        "invalid_package",
        "The XLSX package is missing required XLSX package parts."
      );
    }
  }

  validateLocalEntries(bytes, view, entries, centralOffset);

  return {
    compressedBytes: bytes.byteLength,
    entryCount: entries.length,
    expandedBytes,
    entries: entries.map(
      ({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset, dataOffset }) => ({
        name,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dataOffset
      })
    )
  };
}
