import {
  MAX_XLSX_COMPRESSED_BYTES,
  XlsxPreflightError,
  inspectXlsxPackage,
  validateXlsxFileName
} from "./xlsx-preflight.js?v=20260923.1";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_SELECTED_SHEET_CELLS = 250_000;
const numberFormat = new Intl.NumberFormat("en-US");

const workspace = document.querySelector("[data-excel-workspace]");
const fileInput = document.querySelector("[data-excel-file-input]");
const fileTrigger = document.querySelector("[data-excel-file-trigger]");
const dropZone = document.querySelector("[data-excel-drop-zone]");
const clearButton = document.querySelector("[data-excel-clear]");
const fileSummary = document.querySelector("[data-excel-file-summary]");
const fileName = document.querySelector("[data-excel-file-name]");
const fileSize = document.querySelector("[data-excel-file-size]");
const settingsForm = document.querySelector("[data-excel-settings]");
const sheetSelect = document.querySelector("[data-excel-sheet]");
const sheetRows = document.querySelector("[data-excel-sheet-rows]");
const sheetColumns = document.querySelector("[data-excel-sheet-columns]");
const sheetCells = document.querySelector("[data-excel-sheet-cells]");
const headerControl = document.querySelector("[data-excel-header]");
const columnPicker = document.querySelector("[data-excel-column-picker]");
const columnsContainer = document.querySelector("[data-excel-columns]");
const columnCount = document.querySelector("[data-excel-column-count]");
const selectAllButton = document.querySelector("[data-excel-select-all]");
const clearColumnsButton = document.querySelector("[data-excel-clear-columns]");
const warningPanel = document.querySelector("[data-excel-warning-panel]");
const warningList = document.querySelector("[data-excel-warnings]");
const warningConfirmation = document.querySelector("[data-excel-confirm-warnings]");
const formulaNotice = document.querySelector("[data-excel-formula-notice]");
const processButton = document.querySelector("[data-excel-process]");
const status = document.querySelector("[data-excel-status]");
const errorBox = document.querySelector("[data-excel-error]");
const resultPanel = document.querySelector("[data-excel-result]");
const resultNote = document.querySelector("[data-excel-result-note]");
const downloadLink = document.querySelector("[data-excel-download]");
const announcer = document.querySelector("[data-excel-announcer]");
const legalDialog = document.querySelector("[data-legal-dialog]");
const legalCloseButton = document.querySelector("[data-dialog-close]");

let excelWorker = null;
let requestSequence = 0;
let activeRequest = 0;
let fileRevision = 0;
let inspection = null;
let selectedFileName = "";
let downloadUrl = "";
let resultStats = null;
let legalTrigger = null;
let legalHistoryOpen = false;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function setStatus(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function announce(message) {
  announcer.textContent = "";
  window.setTimeout(() => {
    announcer.textContent = message;
  }, 20);
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function showError(message, { focus = true, statusMessage = "Processing stopped safely." } = {}) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  setStatus(statusMessage);
  if (focus) errorBox.focus();
  announce(message);
}

function showLinkedError({ before, href, label, after }) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  errorBox.replaceChildren(
    document.createTextNode(before),
    link,
    document.createTextNode(after)
  );
  errorBox.hidden = false;
  setStatus("Choose an XLSX workbook to begin.");
  errorBox.focus();
  announce(`${before}${label}${after}`);
}

function revokeDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = "";
  downloadLink.href = "/excel#excel-tool";
  downloadLink.removeAttribute("download");
  resultPanel.hidden = true;
  resultStats = null;
}

function invalidateResult({ message = false } = {}) {
  const hadResult = Boolean(downloadUrl);
  revokeDownload();
  if (message && hadResult) {
    setStatus("Settings changed. Run the workbook again to create a new download.");
    announce("The previous download was cleared because the settings changed.");
  }
}

function terminateWorker() {
  if (!excelWorker) return;
  const disposeId = ++requestSequence;
  activeRequest = disposeId;
  try {
    excelWorker.postMessage({ type: "dispose", id: disposeId });
  } catch {
    // terminate() below remains the authoritative cancellation path.
  }
  excelWorker.terminate();
  excelWorker = null;
}

function resetWorkbook({ keepStatus = false } = {}) {
  fileRevision += 1;
  terminateWorker();
  revokeDownload();
  inspection = null;
  selectedFileName = "";
  fileInput.value = "";
  fileName.textContent = "";
  fileSize.textContent = "";
  sheetSelect.replaceChildren();
  columnsContainer.replaceChildren();
  warningList.replaceChildren();
  warningConfirmation.checked = false;
  fileSummary.hidden = true;
  settingsForm.hidden = true;
  clearButton.hidden = true;
  dropZone.hidden = false;
  formulaNotice.hidden = true;
  warningPanel.hidden = true;
  workspace.dataset.state = "empty";
  settingsForm.removeAttribute("aria-busy");
  processButton.disabled = false;
  clearError();
  if (!keepStatus) setStatus("Choose an XLSX workbook to begin.");
}

function safeDownloadName(name) {
  const source = typeof name === "string" ? name.replace(/\.xlsx$/i, "") : "";
  const base = source
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 96);
  return base ? `${base}-deduplicated.xlsx` : "deduplicated.xlsx";
}

function columnLetter(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function selectedSheet() {
  if (!inspection) return null;
  const index = Number(sheetSelect.value);
  return inspection.sheets.find((sheet) => sheet.index === index) ?? null;
}

function selectedColumnIndices() {
  return [...columnsContainer.querySelectorAll('input[type="checkbox"]:checked')]
    .map((control) => Number(control.value))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
}

function updateColumnCount() {
  const selected = selectedColumnIndices().length;
  columnCount.textContent = `${numberFormat.format(selected)} ${selected === 1 ? "column" : "columns"} selected`;
}

function compareMode() {
  return settingsForm.querySelector('input[name="excel-compare-mode"]:checked')?.value ?? "row";
}

function syncColumnMode() {
  const enabled = compareMode() === "columns";
  columnPicker.classList.toggle("is-disabled", !enabled);
  columnsContainer.querySelectorAll("input").forEach((control) => {
    control.disabled = !enabled;
  });
  selectAllButton.disabled = !enabled;
  clearColumnsButton.disabled = !enabled;
}

function renderColumns({ preserveSelection = false } = {}) {
  const sheet = selectedSheet();
  if (!sheet) return;
  const previous = preserveSelection ? new Set(selectedColumnIndices()) : null;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < sheet.columns; index += 1) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");
    checkbox.type = "checkbox";
    checkbox.value = String(index);
    checkbox.checked = previous ? previous.has(index) : true;
    const header = headerControl.checked ? sheet.headerCells[index]?.trim() : "";
    text.textContent = header ? `${columnLetter(index)} — ${header}` : `Column ${columnLetter(index)}`;
    label.append(checkbox, text);
    fragment.append(label);
  }
  columnsContainer.replaceChildren(fragment);
  syncColumnMode();
  updateColumnCount();
}

function renderSelectedSheet({ preserveColumns = false } = {}) {
  const sheet = selectedSheet();
  if (!sheet) return;
  sheetRows.textContent = numberFormat.format(sheet.rows);
  sheetColumns.textContent = numberFormat.format(sheet.columns);
  sheetCells.textContent = numberFormat.format(sheet.cellArea);
  renderColumns({ preserveSelection: preserveColumns });
  if (sheet.cellArea > MAX_SELECTED_SHEET_CELLS) {
    showError("That worksheet declares more than 250,000 cells. Choose a smaller worksheet, or split the data into a smaller file.", { focus: false });
    processButton.disabled = true;
  } else {
    clearError();
    processButton.disabled = false;
  }
}

function renderWarnings() {
  warningList.replaceChildren();
  for (const warning of inspection.warnings) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${warning.title}: `;
    item.append(title, document.createTextNode(warning.message));
    warningList.append(item);
  }
  warningConfirmation.checked = false;
  warningPanel.hidden = inspection.warnings.length === 0;
  formulaNotice.hidden = !inspection.hasFormulas;
}

function finishInspection(message) {
  inspection = message;
  fileName.textContent = message.name;
  fileSize.textContent = `${formatBytes(message.size)} · ${numberFormat.format(message.workbookCellArea)} declared workbook cells`;
  const options = message.sheets.map((sheet) => {
    const option = document.createElement("option");
    option.value = String(sheet.index);
    option.textContent = sheet.name;
    return option;
  });
  sheetSelect.replaceChildren(...options);
  fileSummary.hidden = false;
  settingsForm.hidden = false;
  clearButton.hidden = false;
  dropZone.hidden = true;
  workspace.dataset.state = "ready";
  renderWarnings();
  clearError();
  renderSelectedSheet();
  if (!processButton.disabled) {
    setStatus(`${message.sheets.length} visible ${message.sheets.length === 1 ? "worksheet" : "worksheets"} inspected locally. Choose matching rules and run the tool.`, "success");
    announce("Workbook ready. Choose a worksheet and duplicate matching rules.");
  }
}

function renderResult(message) {
  revokeDownload();
  const blob = new Blob([message.buffer], { type: XLSX_MIME });
  downloadUrl = URL.createObjectURL(blob);
  downloadLink.href = downloadUrl;
  downloadLink.download = safeDownloadName(selectedFileName);
  document.querySelector('[data-excel-stat="total"]').textContent = numberFormat.format(message.stats.total);
  document.querySelector('[data-excel-stat="unique"]').textContent = numberFormat.format(message.stats.unique);
  document.querySelector('[data-excel-stat="duplicates"]').textContent = numberFormat.format(message.stats.duplicates);
  document.querySelector('[data-excel-stat="empty"]').textContent = numberFormat.format(message.stats.emptyRemoved);
  resultNote.textContent = message.unchanged
    ? "No rows needed removal. The download is byte-for-byte identical to the selected file."
    : `${numberFormat.format(message.stats.removed)} ${message.stats.removed === 1 ? "row was" : "rows were"} removed from the selected worksheet.`;
  resultStats = { ...message.stats, unchanged: message.unchanged };
  resultPanel.hidden = false;
  settingsForm.removeAttribute("aria-busy");
  processButton.disabled = false;
  workspace.dataset.state = "ready";
  clearError();
  setStatus("Cleaned workbook created locally. Review the statistics, then download the copy.", "success");
  announce(`Workbook ready. ${message.stats.removed} rows removed.`);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  resultPanel.scrollIntoView({
    block: "nearest",
    behavior: reducedMotion ? "auto" : "smooth"
  });
}

function handleWorkerError(message) {
  settingsForm.removeAttribute("aria-busy");
  processButton.disabled = false;
  workspace.dataset.state = inspection ? "ready" : "empty";
  if (!inspection) terminateWorker();
  showError(message.error?.message ?? "The workbook could not be processed safely.");
}

function createWorker() {
  let worker;
  try {
    worker = new Worker(new URL("./excel-worker.js?v=20260923.1", import.meta.url), {
      type: "module",
      name: "removeduplicates-excel-local"
    });
  } catch {
    throw new Error("worker_unavailable");
  }
  worker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    if (worker !== excelWorker || message.id !== activeRequest) return;
    if (message.type === "inspected") finishInspection(message);
    else if (message.type === "result") renderResult(message);
    else if (message.type === "error") handleWorkerError(message);
  });
  worker.addEventListener("error", () => {
    if (worker !== excelWorker) return;
    terminateWorker();
    settingsForm.removeAttribute("aria-busy");
    processButton.disabled = false;
    workspace.dataset.state = "empty";
    showError("The local workbook Worker could not start. Try a current browser or reload the page.");
  });
  return worker;
}

const TEXT_LIST_PATTERN = /\.(txt|csv|tsv|log|md|list)$/i;

async function openWorkbook(file) {
  resetWorkbook({ keepStatus: true });
  const revision = ++fileRevision;
  selectedFileName = file?.name ?? "";
  if (TEXT_LIST_PATTERN.test(selectedFileName)) {
    showLinkedError({
      before: "That looks like a plain-text list. Open it in the ",
      href: "/",
      label: "text duplicate remover",
      after: ", which cleans TXT, CSV, and TSV files locally too."
    });
    return;
  }
  try {
    validateXlsxFileName(selectedFileName);
    if (file.size > MAX_XLSX_COMPRESSED_BYTES) {
      throw new XlsxPreflightError(
        "compressed_limit",
        "XLSX files must not exceed the 10 MiB compressed limit."
      );
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "Only .xlsx files are supported.");
    return;
  }

  workspace.dataset.state = "reading";
  clearButton.hidden = false;
  setStatus(`Reading ${selectedFileName} locally…`);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
    if (revision !== fileRevision) return;
    inspectXlsxPackage(buffer);
  } catch (error) {
    if (revision !== fileRevision) return;
    workspace.dataset.state = "empty";
    showError(error instanceof Error ? error.message : "That XLSX file could not be read.");
    return;
  }

  try {
    excelWorker = createWorker();
  } catch {
    workspace.dataset.state = "empty";
    showError("The local workbook Worker is unavailable. Try a current browser or reload the page.");
    return;
  }
  const id = ++requestSequence;
  activeRequest = id;
  setStatus("Inspecting workbook structure in a background thread…");
  try {
    excelWorker.postMessage(
      { type: "inspect", id, name: selectedFileName, buffer },
      [buffer]
    );
  } catch {
    terminateWorker();
    workspace.dataset.state = "empty";
    showError("The workbook could not be transferred to the local Worker.");
  }
}

function readProcessingOptions() {
  const mode = compareMode();
  const compare = mode === "row" ? "row" : selectedColumnIndices();
  if (Array.isArray(compare) && compare.length === 0) {
    showError("Choose at least one comparison column.", { statusMessage: "Adjust the matching rules to continue." });
    return null;
  }
  if (inspection.warnings.length > 0 && !warningConfirmation.checked) {
    showError("Review the workbook feature warnings and confirm them before continuing.", { statusMessage: "Confirm the workbook warnings to continue." });
    warningConfirmation.focus();
    return null;
  }
  return {
    header: headerControl.checked,
    compare,
    trim: document.querySelector("[data-excel-trim]").checked,
    ignoreCase: document.querySelector("[data-excel-ignore-case]").checked,
    removeEmpty: document.querySelector("[data-excel-remove-empty]").checked,
    keep: settingsForm.querySelector('input[name="excel-keep"]:checked')?.value ?? "first",
    confirmedWarningCodes: warningConfirmation.checked
      ? inspection.warnings.map(({ code }) => code)
      : []
  };
}

function processWorkbook() {
  if (!excelWorker || !inspection) {
    showError("Choose an XLSX workbook before processing.");
    return;
  }
  const sheet = selectedSheet();
  if (!sheet) {
    showError("Choose a visible worksheet.");
    return;
  }
  if (sheet.cellArea > MAX_SELECTED_SHEET_CELLS) {
    showError("That worksheet declares more than 250,000 cells. Choose a smaller worksheet, or split the data into a smaller file.");
    return;
  }
  const options = readProcessingOptions();
  if (!options) return;
  invalidateResult();
  clearError();
  settingsForm.setAttribute("aria-busy", "true");
  processButton.disabled = true;
  workspace.dataset.state = "processing";
  setStatus("Removing duplicate rows in a background thread…");
  const id = ++requestSequence;
  activeRequest = id;
  excelWorker.postMessage({
    type: "dedupe",
    id,
    sheetIndex: sheet.index,
    options
  });
}

fileTrigger.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openWorkbook(file);
});
clearButton.addEventListener("click", () => {
  resetWorkbook();
  fileTrigger.focus();
  announce("Workbook cleared from this tab.");
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "dragend"]) {
  dropZone.addEventListener(eventName, (event) => {
    if (eventName === "dragleave" && dropZone.contains(event.relatedTarget)) return;
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) void openWorkbook(file);
});

for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (dropZone.contains(event.target)) return;
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
  });
}

sheetSelect.addEventListener("change", () => {
  invalidateResult({ message: true });
  warningConfirmation.checked = false;
  renderSelectedSheet();
});
headerControl.addEventListener("change", () => {
  invalidateResult({ message: true });
  renderColumns({ preserveSelection: true });
});
settingsForm.addEventListener("change", (event) => {
  if (event.target === headerControl || event.target === sheetSelect) return;
  invalidateResult({ message: true });
  if (event.target.name === "excel-compare-mode") syncColumnMode();
  if (event.target.closest("[data-excel-columns]")) updateColumnCount();
  clearError();
});
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  processWorkbook();
});
selectAllButton.addEventListener("click", () => {
  columnsContainer.querySelectorAll("input").forEach((control) => {
    control.checked = true;
  });
  updateColumnCount();
  invalidateResult({ message: true });
});
clearColumnsButton.addEventListener("click", () => {
  columnsContainer.querySelectorAll("input").forEach((control) => {
    control.checked = false;
  });
  updateColumnCount();
  invalidateResult({ message: true });
});
downloadLink.addEventListener("click", () => {
  setStatus(`Downloading ${downloadLink.download}.`, "success");
  announce("Cleaned XLSX download started.");
});

function openLegal(type, { pushHistory = true, trigger = null } = {}) {
  if ((type !== "terms" && type !== "privacy") || typeof legalDialog?.showModal !== "function") return false;
  legalTrigger = trigger || legalTrigger;
  document.querySelectorAll("[data-legal-title]").forEach((title) => title.removeAttribute("id"));
  document.querySelectorAll("[data-legal-content]").forEach((content) => {
    content.hidden = content.dataset.legalContent !== type;
  });
  const title = legalDialog.querySelector(`[data-legal-content="${type}"] [data-legal-title]`);
  title.id = "active-excel-legal-title";
  legalDialog.setAttribute("aria-labelledby", title.id);
  legalCloseButton.setAttribute("aria-label", `Close ${type === "terms" ? "Terms" : "Privacy"}`);
  if (!legalDialog.open) legalDialog.showModal();
  legalCloseButton.focus();
  if (pushHistory) {
    history.pushState({ legal: type, excel: true }, "", `/${type}`);
    legalHistoryOpen = true;
  }
  return true;
}

function closeLegal({ viaHistory = true } = {}) {
  if (!legalDialog?.open) return;
  if (viaHistory && legalHistoryOpen) {
    history.back();
    return;
  }
  legalHistoryOpen = false;
  legalDialog.close();
}

document.querySelectorAll("[data-legal-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openLegal(link.dataset.legalLink, { trigger: link })) event.preventDefault();
  });
});
legalCloseButton?.addEventListener("click", () => closeLegal());
legalDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLegal();
});
legalDialog?.addEventListener("click", (event) => {
  if (event.target === legalDialog) closeLegal();
});
legalDialog?.addEventListener("close", () => {
  legalDialog.removeAttribute("aria-labelledby");
  document.querySelectorAll("[data-legal-title]").forEach((title) => title.removeAttribute("id"));
  legalTrigger?.focus();
  legalTrigger = null;
});
window.addEventListener("popstate", (event) => {
  if (event.state?.legal && event.state?.excel) {
    openLegal(event.state.legal, { pushHistory: false });
    legalHistoryOpen = true;
  } else if (legalDialog?.open) {
    closeLegal({ viaHistory: false });
  }
});
window.addEventListener("beforeunload", () => {
  terminateWorker();
  revokeDownload();
});

resetWorkbook();

window.__REMOVE_DUPLICATES_EXCEL_QA__ = Object.freeze({
  get state() { return workspace.dataset.state; },
  get workerActive() { return Boolean(excelWorker); },
  get inspection() {
    return inspection
      ? {
          visibleSheets: inspection.sheets.length,
          workbookCellArea: inspection.workbookCellArea,
          warningCodes: inspection.warnings.map(({ code }) => code),
          hasFormulas: inspection.hasFormulas
        }
      : null;
  },
  get result() { return resultStats ? { ...resultStats } : null; }
});
