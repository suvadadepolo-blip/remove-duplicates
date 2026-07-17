import {
  WorkbookProcessingError,
  dedupeWorkbook,
  inspectWorkbook
} from "./workbook-adapter.js?v=20260716.2";
import {
  XlsxPreflightError,
  inspectXlsxPackage,
  validateXlsxFileName
} from "./xlsx-preflight.js?v=20260716.2";

const FIXED_ERRORS = Object.freeze({
  invalid_package: "Choose an XLSX file before processing.",
  parser_unavailable: "The local XLSX parser could not be loaded.",
  serialization_failed: "The cleaned workbook could not be created safely."
});

function normalizedError(error, fallbackCode) {
  if (
    (error instanceof XlsxPreflightError || error instanceof WorkbookProcessingError) &&
    typeof error.code === "string"
  ) {
    return { code: error.code, message: error.message };
  }
  const code = fallbackCode;
  return { code, message: FIXED_ERRORS[code] };
}

async function defaultParserLoader() {
  return import("../vendor/sheetjs-0.20.3/xlsx.mjs");
}

export function createExcelWorkerRuntime({
  loadParser = defaultParserLoader,
  postMessage
} = {}) {
  if (typeof postMessage !== "function") {
    throw new TypeError("A postMessage function is required.");
  }

  let originalBuffer = null;
  let packageInfo = null;
  let parser = null;

  const respondError = (id, error, fallbackCode) => {
    postMessage({
      type: "error",
      id,
      error: normalizedError(error, fallbackCode)
    });
  };

  const inspect = async ({ id, name, buffer }) => {
    originalBuffer = null;
    packageInfo = null;
    parser = null;

    try {
      validateXlsxFileName(name);
      if (!(buffer instanceof ArrayBuffer)) {
        throw new XlsxPreflightError("invalid_package", "That file is not a valid XLSX package.");
      }
      const inspectedPackage = inspectXlsxPackage(buffer);
      let loaded;
      try {
        loaded = await loadParser();
      } catch {
        respondError(id, null, "parser_unavailable");
        return;
      }
      const workbook = inspectWorkbook(loaded, buffer, inspectedPackage);
      originalBuffer = buffer;
      packageInfo = inspectedPackage;
      parser = loaded;
      postMessage({
        type: "inspected",
        id,
        name,
        size: buffer.byteLength,
        sheets: workbook.sheets,
        warnings: workbook.warnings,
        hasFormulas: workbook.hasFormulas,
        workbookCellArea: workbook.workbookCellArea
      });
    } catch (error) {
      respondError(id, error, "invalid_package");
    }
  };

  const dedupe = ({ id, sheetIndex, options }) => {
    if (!originalBuffer || !parser || !packageInfo) {
      respondError(id, null, "invalid_package");
      return;
    }
    try {
      const result = dedupeWorkbook(
        parser,
        originalBuffer,
        { ...options, sheetIndex },
        packageInfo
      );
      const payload = {
        type: "result",
        id,
        buffer: result.buffer,
        unchanged: result.unchanged,
        stats: result.stats,
        warnings: result.warnings,
        sheetName: result.sheetName
      };
      postMessage(payload, [result.buffer]);
    } catch (error) {
      respondError(id, error, "serialization_failed");
    }
  };

  return Object.freeze({
    async handle(message) {
      const data = message ?? {};
      if (!Number.isInteger(data.id)) return;
      if (data.type === "dispose") {
        originalBuffer = null;
        packageInfo = null;
        parser = null;
        return;
      }
      if (data.type === "inspect") {
        await inspect(data);
        return;
      }
      if (data.type === "dedupe") {
        dedupe(data);
      }
    }
  });
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  const runtime = createExcelWorkerRuntime({
    postMessage(payload, transfer) {
      self.postMessage(payload, transfer ?? []);
    }
  });
  self.addEventListener("message", (event) => {
    void runtime.handle(event.data);
  });
}
