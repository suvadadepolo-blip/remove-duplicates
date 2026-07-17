import {
  MAX_TEXT_BYTES,
  WORKER_CHARACTER_THRESHOLD,
  dedupeInteractiveInput,
  measureTextBytes,
  shouldUseWorker
} from "./dedupe.js?v=20260716.2";
import { stripBom } from "./tabular.js?v=20260716.2";

const input = document.querySelector("[data-input]");
const output = document.querySelector("[data-output]");
const workspace = document.querySelector(".workspace");
const processButton = document.querySelector("[data-process]");
const status = document.querySelector("[data-status]");
const announcer = document.querySelector("[data-announcer]");
const copyButton = document.querySelector("[data-copy]");
const downloadButton = document.querySelector("[data-download]");
const fileInput = document.querySelector("[data-file-input]");
const dropZone = document.querySelector("[data-drop-zone]");
const legalDialog = document.querySelector("[data-legal-dialog]");
const legalCloseButton = document.querySelector("[data-dialog-close]");
const compareControl = document.querySelector("[data-compare]");
const headerControl = document.querySelector("[data-header]");
const tableOptions = document.querySelector("[data-table-options]");
const detectedFormat = document.querySelector("[data-detected-format]");
const undoButton = document.querySelector("[data-undo]");
const shortcutHint = document.querySelector("[data-shortcut-hint]");

const optionControls = {
  ignoreCase: document.querySelector("[data-ignore-case]"),
  trim: document.querySelector("[data-trim]"),
  removeEmpty: document.querySelector("[data-remove-empty]")
};

const statElements = Object.fromEntries(
  ["total", "unique", "removed", "reduction"].map((name) => [
    name,
    document.querySelector(`[data-stat="${name}"]`)
  ])
);
const statLabels = Object.fromEntries(
  ["total", "unique", "removed"].map((name) => [
    name,
    document.querySelector(`[data-stat-label="${name}"]`)
  ])
);

const SAMPLE = [
  "Orchid",
  "River stone",
  "Orchid",
  "  Paper plane  ",
  "river stone",
  "",
  "Paper plane",
  "Night train",
  "Night train"
].join("\n");

const numberFormat = new Intl.NumberFormat("en");
const mobileWorkspace = window.matchMedia("(max-width: 760px)");
const TEXT_FILE_PATTERN = /\.(txt|csv|tsv|log|md|list)$/i;
const SPREADSHEET_GUIDANCE = Object.freeze({
  xls: "Legacy .xls workbooks aren't supported. Open the file in Excel and save a copy as .xlsx before using the ",
  xlsm: "Macro-enabled .xlsm workbooks aren't supported because a cleaned copy could lose or change macros. Save a macro-free copy as .xlsx before using the ",
  ods: "OpenDocument .ods spreadsheets aren't supported. Export or save a copy as .xlsx before using the ",
  numbers: "Apple Numbers files aren't supported. In Numbers, export a copy as Excel (.xlsx) before using the "
});
let currentResult = dedupeInteractiveInput("", readOptions());
let processingWorker = null;
let processingSequence = 0;
let processingTimer = 0;
let pendingWorkerIntent = null;
let processing = false;
let lastMode = "main";
let lastDuration = 0;
let inputRevision = 0;
let legalTrigger = null;
let legalHistoryOpen = false;
let clearSnapshot = null;
let copyResetTimer = 0;
let compareResetPending = false;

function readOptions() {
  const compareValue = compareControl?.value ?? "row";
  return {
    ignoreCase: Boolean(optionControls.ignoreCase?.checked),
    trim: Boolean(optionControls.trim?.checked),
    removeEmpty: Boolean(optionControls.removeEmpty?.checked),
    keep: document.querySelector('input[name="keep"]:checked')?.value || "first",
    order: document.querySelector('input[name="order"]:checked')?.value || "preserve",
    format: document.querySelector('input[name="format"]:checked')?.value || "auto",
    compare: compareValue === "row" ? "row" : Number(compareValue),
    header: Boolean(headerControl?.checked)
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function setLinkedStatus({ before, href, label, after }, tone = "neutral") {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  status.replaceChildren(
    document.createTextNode(before),
    link,
    document.createTextNode(after)
  );
  status.dataset.tone = tone;
}

function announce(message) {
  announcer.textContent = "";
  window.setTimeout(() => {
    announcer.textContent = message;
  }, 20);
}

function setUndoAvailable(value) {
  if (undoButton) undoButton.hidden = !value;
}

function invalidateClearSnapshot() {
  clearSnapshot = null;
  setUndoAvailable(false);
}

function confirmCopy() {
  window.clearTimeout(copyResetTimer);
  copyButton.textContent = "Copied ✓";
  copyResetTimer = window.setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1_600);
}

function setProcessingState(value) {
  processing = value;
  processButton?.setAttribute("aria-busy", String(value));
  workspace?.setAttribute("data-processing", String(value));
  const toolShell = document.querySelector("[data-tool-state]");
  if (toolShell) toolShell.dataset.toolState = value ? "processing" : "ready";
}

function updateInputMeta({ bytes, lines, table } = {}) {
  const value = input.value;
  const measuredBytes = bytes ?? measureTextBytes(value);
  const measuredLines = lines ?? (value === "" ? 0 : value.replace(/\r\n?/g, "\n").split("\n").length);
  const itemName = table ? (measuredLines === 1 ? "row" : "rows") : (measuredLines === 1 ? "line" : "lines");
  const columns = table ? ` · ${numberFormat.format(table.columns)} ${table.columns === 1 ? "column" : "columns"}` : "";
  const itemLabel = `${numberFormat.format(measuredLines)} ${itemName}${columns}`;
  document.querySelectorAll("[data-input-lines]").forEach((count) => {
    count.textContent = value ? `${itemLabel} · ${formatBytes(measuredBytes)}` : itemLabel;
  });
  document.querySelectorAll("[data-mobile-input-count]").forEach((count) => {
    count.textContent = numberFormat.format(measuredLines);
  });
}

function columnLabel(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return `Column ${label}`;
}

function syncTableControls(result) {
  const table = result.table;
  if (tableOptions) tableOptions.hidden = !table;
  if (detectedFormat) {
    detectedFormat.hidden = !table;
    detectedFormat.textContent = table
      ? `Detected table · ${numberFormat.format(table.columns)} ${table.columns === 1 ? "column" : "columns"} · ${table.kind === "tsv" ? "tab-separated" : "comma-separated"}`
      : "";
  }

  statLabels.total.textContent = table ? "Total rows" : "Total lines";
  statLabels.unique.textContent = table ? "Unique rows" : "Unique lines";
  statLabels.removed.textContent = table ? "Rows removed" : "Lines removed";
  downloadButton.textContent = table ? `Download .${table.kind}` : "Download .txt";

  if (!table || !compareControl) return false;
  const previousValue = compareControl.value;
  compareControl.textContent = "";
  const rowOption = document.createElement("option");
  rowOption.value = "row";
  rowOption.textContent = "Entire row";
  compareControl.append(rowOption);

  for (let index = 0; index < table.columns; index += 1) {
    const option = document.createElement("option");
    const headerName = table.header ? table.headerCells[index]?.trim() : "";
    const fallback = columnLabel(index);
    const fullLabel = headerName || fallback;
    option.value = String(index);
    option.textContent = fullLabel.length > 28
      ? `${fullLabel.slice(0, 27)}…`
      : fullLabel;
    option.title = fullLabel;
    compareControl.append(option);
  }

  const previousIndex = Number(previousValue);
  const canPreserve =
    previousValue === "row" ||
    (Number.isInteger(previousIndex) && previousIndex >= 0 && previousIndex < table.columns);
  compareControl.value = canPreserve ? previousValue : "row";
  return !canPreserve;
}

function syncPanelVisibility() {
  document.querySelectorAll("[data-mobile-panel]").forEach((region) => {
    const active = region.dataset.mobilePanel === workspace?.dataset.mobileActive;
    region.hidden = mobileWorkspace.matches && !active;
  });
}

function setMobilePanel(panel) {
  if (!workspace || (panel !== "input" && panel !== "result")) return;
  workspace.dataset.mobileActive = panel;
  document.querySelectorAll("[data-mobile-tab]").forEach((tab) => {
    const selected = tab.dataset.mobileTab === panel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll("[data-mobile-panel]").forEach((region) => {
    region.classList.toggle("is-active", region.dataset.mobilePanel === panel);
  });
  syncPanelVisibility();
}

function renderResult(result, { mode, duration, shouldAnnounce = false, switchResult = false } = {}) {
  currentResult = result;
  lastMode = mode || lastMode;
  lastDuration = duration ?? lastDuration;
  const sourceItems = result.stats.total + (result.table?.headerCells.length ? 1 : 0);
  updateInputMeta({
    bytes: result.sourceBytes,
    lines: sourceItems,
    table: result.table
  });
  output.value = result.text;
  output.scrollTop = 0;
  const compareWasReset = syncTableControls(result);

  statElements.total.textContent = numberFormat.format(result.stats.total);
  statElements.unique.textContent = numberFormat.format(result.stats.unique);
  statElements.removed.textContent = numberFormat.format(result.stats.removed);
  statElements.reduction.textContent = `${result.stats.reduction}%`;

  const hasOutput = result.stats.unique > 0;
  const outputUnit = result.table
    ? (result.stats.unique === 1 ? "row" : "rows")
    : (result.stats.unique === 1 ? "line" : "lines");
  const outputLineLabel = `${numberFormat.format(result.stats.unique)} ${outputUnit}`;
  document.querySelectorAll("[data-output-lines]").forEach((count) => {
    count.textContent = outputLineLabel;
  });
  document.querySelectorAll("[data-mobile-result-count]").forEach((count) => {
    count.textContent = numberFormat.format(result.stats.unique);
  });
  copyButton.disabled = !hasOutput;
  downloadButton.disabled = !hasOutput;
  const emptyResult = document.querySelector("[data-empty-result]");
  if (emptyResult) emptyResult.hidden = hasOutput;

  const hasInput = input.value.length > 0;
  const timing = duration >= 10 ? ` in ${Math.round(duration)} ms` : "";
  const modeLabel = mode === "worker" ? " in a background thread" : "";
  const unit = result.table ? "rows" : "lines";
  let message = "Paste a list or drop a text/CSV file to begin.";
  if (hasInput) {
    message = `${numberFormat.format(result.stats.total)} ${unit} → ${numberFormat.format(result.stats.unique)} unique · ${numberFormat.format(result.stats.removed)} removed locally${modeLabel}${timing}.`;
  }
  setStatus(message, hasInput && result.stats.removed > 0 ? "success" : "neutral");
  setProcessingState(false);
  workspace?.setAttribute("data-has-result", String(hasOutput));

  if (switchResult && hasInput) setMobilePanel("result");
  if (compareWasReset && !compareResetPending) {
    compareResetPending = true;
    announce("The selected column is no longer available. Compare by was reset to Entire row.");
    window.setTimeout(() => {
      compareResetPending = false;
      processText();
    }, 0);
  } else if (shouldAnnounce && hasInput) {
    const detection = result.table
      ? `Table detected: ${numberFormat.format(result.table.columns)} columns. `
      : "";
    announce(`${detection}${message}`);
  }
}

function handleProcessingError(error, shouldAnnounce = true) {
  const message = error?.kind === "size"
    ? `That text is larger than the ${formatBytes(MAX_TEXT_BYTES)} local limit.`
    : "The text could not be processed. Please try again.";
  setStatus(message, "error");
  setProcessingState(false);
  if (shouldAnnounce) announce(message);
}

function ensureWorker() {
  if (processingWorker) return processingWorker;
  processingWorker = new Worker(new URL("./dedupe-worker.js?v=20260716.2", import.meta.url), {
    type: "module",
    name: "removeduplicates-local"
  });
  processingWorker.addEventListener("message", (event) => {
    const { id, result, error } = event.data ?? {};
    if (id !== processingSequence) return;
    const intent = pendingWorkerIntent;
    pendingWorkerIntent = null;
    if (!intent) return;
    if (error) {
      handleProcessingError(error, intent?.shouldAnnounce);
      return;
    }
    const duration = performance.now() - intent.startedAt;
    renderResult(result, {
      mode: "worker",
      duration,
      shouldAnnounce: intent.shouldAnnounce,
      switchResult: intent.switchResult
    });
  });
  processingWorker.addEventListener("error", () => {
    const intent = pendingWorkerIntent;
    processingWorker?.terminate();
    processingWorker = null;
    pendingWorkerIntent = null;
    if (intent) handleProcessingError({ kind: "worker" }, intent.shouldAnnounce);
  });
  return processingWorker;
}

function postWorkerRequest({ id, text, options }) {
  const worker = ensureWorker();
  worker.postMessage({ type: "start", id, options });
  let offset = 0;

  const postNextChunk = () => {
    if (id !== processingSequence) {
      worker.postMessage({ type: "cancel", id });
      return;
    }

    const nextOffset = Math.min(offset + WORKER_CHARACTER_THRESHOLD, text.length);
    const done = nextOffset === text.length;
    worker.postMessage({
      type: "chunk",
      id,
      chunk: text.slice(offset, nextOffset),
      done
    });
    offset = nextOffset;
    if (!done) window.setTimeout(postNextChunk, 0);
  };

  window.setTimeout(postNextChunk, 0);
}

function processText({ shouldAnnounce = false, switchResult = false } = {}) {
  window.clearTimeout(processingTimer);
  pendingWorkerIntent = null;
  const text = input.value;
  const options = readOptions();
  const requestId = ++processingSequence;
  const startedAt = performance.now();

  try {
    if (text !== "") setProcessingState(true);
    if (shouldUseWorker(text)) {
      lastMode = "worker";
      pendingWorkerIntent = { startedAt, shouldAnnounce, switchResult };
      setStatus("Processing large text locally in a background thread…");
      postWorkerRequest({ id: requestId, text, options });
      return;
    }

    const result = dedupeInteractiveInput(text, options);
    renderResult(result, {
      mode: "main",
      duration: performance.now() - startedAt,
      shouldAnnounce,
      switchResult
    });
  } catch (error) {
    handleProcessingError(error, shouldAnnounce);
  }
}

function scheduleProcessing() {
  ++processingSequence;
  pendingWorkerIntent = null;
  window.clearTimeout(processingTimer);
  if (input.value.length < WORKER_CHARACTER_THRESHOLD) {
    updateInputMeta();
  } else {
    document.querySelectorAll("[data-input-lines]").forEach((count) => {
      count.textContent = "Counting large paste…";
    });
    document.querySelectorAll("[data-mobile-input-count]").forEach((count) => {
      count.textContent = "…";
    });
  }
  setStatus(input.value ? "Updating locally…" : "Paste a list or drop a text/CSV file to begin.");
  processingTimer = window.setTimeout(() => processText(), 120);
}

async function copyResult() {
  if (currentResult.stats.unique === 0) {
    setStatus("There is no cleaned text to copy yet.", "error");
    announce("There is no cleaned text to copy yet.");
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(currentResult.text);
    } else {
      output.focus();
      output.select();
      if (!document.execCommand("copy")) throw new Error("Copy was not available.");
      output.setSelectionRange(0, 0);
    }
    confirmCopy();
    setStatus("Cleaned text copied to your clipboard.", "success");
    announce("Cleaned text copied.");
  } catch {
    setStatus("Copy was blocked by this browser. Select the result and copy it manually.", "error");
    announce("Copy was blocked by this browser.");
  }
}

function downloadResult() {
  if (currentResult.stats.unique === 0) {
    setStatus("There is no cleaned text to download yet.", "error");
    announce("There is no cleaned text to download yet.");
    return;
  }

  const extension = currentResult.table?.kind ?? "txt";
  const filename = currentResult.table
    ? `unique-rows.${extension}`
    : "unique-lines.txt";
  const type = extension === "csv"
    ? "text/csv;charset=utf-8"
    : "text/plain;charset=utf-8";
  const blob = new Blob([currentResult.text], { type });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
  setStatus(`Downloaded ${filename}.`, "success");
  announce("Cleaned text downloaded.");
}

function validateTextFile(file) {
  if (!file) return { message: "Choose a text file first." };
  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
  if (extension === "xlsx") {
    const before = "Open this XLSX file in the ";
    const label = "Excel duplicate remover";
    const after = " to choose a worksheet and comparison columns without uploading it.";
    return {
      message: `${before}${label}${after}`,
      linkedStatus: { before, href: "/excel", label, after }
    };
  }
  if (Object.hasOwn(SPREADSHEET_GUIDANCE, extension)) {
    const before = SPREADSHEET_GUIDANCE[extension];
    const label = "Excel duplicate remover";
    return {
      message: `${before}${label}.`,
      linkedStatus: { before, href: "/excel", label, after: "." }
    };
  }
  if (!TEXT_FILE_PATTERN.test(file.name)) {
    return { message: "Only plain-text files (.txt, .csv, .tsv, .log, .md, .list) are supported here." };
  }
  if (
    file.type &&
    !file.type.startsWith("text/") &&
    file.type !== "application/csv" &&
    file.type !== "application/vnd.ms-excel"
  ) {
    return { message: "Only plain-text files (.txt, .csv, .tsv, .log, .md, .list) are supported here." };
  }
  if (file.size > MAX_TEXT_BYTES) {
    return { message: `That file is larger than the ${formatBytes(MAX_TEXT_BYTES)} local limit.` };
  }
  return null;
}

async function readTextFile(file) {
  invalidateClearSnapshot();
  const revision = ++inputRevision;
  const problem = validateTextFile(file);
  if (problem) {
    if (problem.linkedStatus) {
      setLinkedStatus(problem.linkedStatus, "error");
    } else {
      setStatus(problem.message, "error");
    }
    announce(problem.message);
    return;
  }

  try {
    const text = stripBom(await file.text());
    if (revision !== inputRevision) return;
    input.value = text;
    setMobilePanel("input");
    setStatus(`${file.name} opened locally. Nothing was uploaded.`);
    processText({ shouldAnnounce: true, switchResult: true });
  } catch {
    if (revision !== inputRevision) return;
    setStatus("That file could not be read as plain text.", "error");
    announce("The text file could not be read.");
  }
}

function openLegal(type, { pushHistory = true, trigger = null } = {}) {
  if ((type !== "terms" && type !== "privacy") || typeof legalDialog?.showModal !== "function") return false;
  legalTrigger = trigger || legalTrigger;
  document.querySelectorAll("[data-legal-title]").forEach((title) => title.removeAttribute("id"));
  document.querySelectorAll("[data-legal-content]").forEach((content) => {
    content.hidden = content.dataset.legalContent !== type;
  });
  const title = legalDialog.querySelector(`[data-legal-content="${type}"] [data-legal-title]`);
  title.id = "active-legal-title";
  legalDialog.setAttribute("aria-labelledby", title.id);
  legalCloseButton.setAttribute("aria-label", `Close ${type === "terms" ? "Terms" : "Privacy"}`);
  if (!legalDialog.open) legalDialog.showModal();
  legalCloseButton.focus();

  if (pushHistory) {
    history.pushState({ legal: type }, "", `/${type}`);
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

input.addEventListener("input", () => {
  invalidateClearSnapshot();
  ++inputRevision;
  scheduleProcessing();
});
processButton.addEventListener("click", () => processText({ shouldAnnounce: true, switchResult: true }));
document.querySelector("[data-sample]").addEventListener("click", () => {
  invalidateClearSnapshot();
  ++inputRevision;
  input.value = SAMPLE;
  setMobilePanel("input");
  processText({ shouldAnnounce: true, switchResult: true });
});
document.querySelector("[data-clear]").addEventListener("click", () => {
  clearSnapshot = input.value || null;
  ++inputRevision;
  ++processingSequence;
  pendingWorkerIntent = null;
  input.value = "";
  setMobilePanel("input");
  processText();
  setStatus("Cleared.");
  setUndoAvailable(clearSnapshot !== null);
  input.focus();
  announce("Input and result cleared.");
});

undoButton?.addEventListener("click", () => {
  if (clearSnapshot === null) return;
  const restored = clearSnapshot;
  clearSnapshot = null;
  setUndoAvailable(false);
  ++inputRevision;
  ++processingSequence;
  pendingWorkerIntent = null;
  input.value = restored;
  setMobilePanel("input");
  processText({ shouldAnnounce: false });
  input.focus();
  announce("Cleared input restored.");
});

for (const control of [
  ...Object.values(optionControls),
  ...document.querySelectorAll('input[name="keep"], input[name="order"], input[name="format"]'),
  compareControl,
  headerControl
]) {
  control?.addEventListener("change", () => processText({ shouldAnnounce: true }));
}

copyButton.addEventListener("click", copyResult);
downloadButton.addEventListener("click", downloadResult);
document.querySelector("[data-file-trigger]").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  readTextFile(fileInput.files?.[0]);
  fileInput.value = "";
});

const isFileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    if (isFileDrag(event)) {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
      return;
    }
    if (event.target !== input) event.preventDefault();
  });
}
for (const eventName of ["dragleave", "dragend"]) {
  dropZone.addEventListener(eventName, (event) => {
    if (eventName === "dragleave" && dropZone.contains(event.relatedTarget)) return;
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    event.preventDefault();
    readTextFile(file);
    return;
  }
  if (event.target !== input) event.preventDefault();
});

for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (dropZone.contains(event.target)) return;
    if (!isFileDrag(event)) return;
    event.preventDefault();
  });
}

document.querySelectorAll("[data-mobile-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setMobilePanel(tab.dataset.mobileTab));
});

document.querySelector(".mobile-tabs")?.addEventListener("keydown", (event) => {
  let panel = null;
  if (event.key === "ArrowLeft" || event.key === "Home") panel = "input";
  else if (event.key === "ArrowRight" || event.key === "End") panel = "result";
  if (!panel) return;
  event.preventDefault();
  setMobilePanel(panel);
  document.querySelector(`[data-mobile-tab="${panel}"]`)?.focus();
});

document.addEventListener("keydown", (event) => {
  if (legalDialog?.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    processText({ shouldAnnounce: true, switchResult: true });
  }
});

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
  if (event.state?.legal) {
    openLegal(event.state.legal, { pushHistory: false });
    legalHistoryOpen = true;
  } else if (legalDialog?.open) {
    closeLegal({ viaHistory: false });
  }
});

mobileWorkspace.addEventListener("change", syncPanelVisibility);

const isApplePlatform = /Mac|iPhone|iPad/i.test(
  navigator.userAgentData?.platform ?? navigator.platform ?? ""
);
if (shortcutHint) shortcutHint.textContent = isApplePlatform ? "⌘ ↵" : "Ctrl ↵";

setMobilePanel("input");
updateInputMeta();
renderResult(currentResult, { mode: "main", duration: 0 });

window.__REMOVE_DUPLICATES_QA__ = Object.freeze({
  get result() { return currentResult; },
  get processing() { return processing; },
  get processingMode() { return lastMode; },
  get duration() { return lastDuration; },
  process() { processText({ shouldAnnounce: false }); }
});
