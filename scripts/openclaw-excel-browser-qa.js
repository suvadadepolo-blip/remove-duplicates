async (page) => {
  const base = page.url().match(/^https?:\/\/[^/]+/)?.[0] || "http://127.0.0.1:3630";
  const results = [];
  const failures = [];
  const consoleErrors = [];
  const externalOrigins = new Set();
  const requests = [];
  const privateMarker = "RDQA_PRIVATE_MARKER_71f3";
  const vendorPath = "/vendor/sheetjs-0.20.3/xlsx.mjs";

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const origin = request.url().match(/^https?:\/\/[^/]+/)?.[0];
    if (origin && origin !== base) externalOrigins.add(origin);
    requests.push({ url: request.url(), method: request.method(), body: request.postData() || "" });
  });

  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const step = async (label, task) => {
    try {
      await task();
      results.push(`${label}: pass`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${message}`);
      results.push(`${label}: fail`);
    }
  };

  const goto = async (path) => {
    const response = await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    check(response && response.status() < 400, `${path} returned ${response?.status()}`);
    return response;
  };

  const chooseFixture = async (targetPage, name) => {
    await targetPage.evaluate(() => {
      const input = document.querySelector("[data-excel-file-input]");
      window.__RDQA_SOURCE_BYTES__ = null;
      input.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        window.__RDQA_SOURCE_BYTES__ = [...new Uint8Array(await file.arrayBuffer())];
      }, { capture: true, once: true });
    });
    await targetPage.locator("[data-excel-file-input]").setInputFiles(`tests/fixtures/${name}`);
    await targetPage.waitForFunction(() => Boolean(window.__REMOVE_DUPLICATES_EXCEL_QA__?.inspection), null, {
      timeout: 15_000
    });
    await targetPage.waitForFunction(() => Array.isArray(window.__RDQA_SOURCE_BYTES__));
    return targetPage.evaluate(() => window.__RDQA_SOURCE_BYTES__);
  };

  const chooseBrowserFile = async (targetPage, { name, bytes, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) => {
    await targetPage.locator("[data-excel-file-input]").evaluate((element, payload) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.type }));
      element.files = transfer.files;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, { name, bytes, type });
  };

  const clearWorkbook = async (targetPage = page) => {
    const clear = targetPage.locator("[data-excel-clear]");
    if (await clear.isVisible()) await clear.click();
    await targetPage.waitForFunction(() => window.__REMOVE_DUPLICATES_EXCEL_QA__?.inspection === null);
  };

  const chooseColumns = async (indices, targetPage = page) => {
    await targetPage.locator('[name="excel-compare-mode"][value="columns"]').check();
    await targetPage.locator("[data-excel-clear-columns]").click();
    for (const index of indices) {
      await targetPage.locator(`[data-excel-columns] input[value="${index}"]`).check();
    }
  };

  const confirmWarnings = async (targetPage = page) => {
    const confirmation = targetPage.locator("[data-excel-confirm-warnings]");
    if (await confirmation.isVisible()) await confirmation.check();
  };

  const processWorkbook = async (targetPage = page) => {
    await targetPage.locator("[data-excel-process]").click();
    await targetPage.waitForFunction(() => Boolean(window.__REMOVE_DUPLICATES_EXCEL_QA__?.result), null, {
      timeout: 20_000
    });
  };

  const downloadWorkbook = async (targetPage = page) => {
    const downloadPromise = targetPage.waitForEvent("download");
    await targetPage.locator("[data-excel-download]").click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const bytes = [];
    for await (const chunk of stream) {
      for (const byte of chunk) bytes.push(byte);
    }
    return {
      name: download.suggestedFilename(),
      bytes
    };
  };

  const reopenDownload = async (bytes, targetPage = page) => targetPage.evaluate(async (sourceBytes) => {
    const XLSX = await import("/vendor/sheetjs-0.20.3/xlsx.mjs");
    const workbook = XLSX.read(Uint8Array.from(sourceBytes), {
      type: "array",
      cellFormula: true,
      cellStyles: true
    });
    const worksheet = workbook.Sheets.Data;
    return {
      sheetNames: workbook.SheetNames,
      sheetStates: workbook.Workbook?.Sheets?.map(({ name, Hidden = 0 }) => ({ name, Hidden })) ?? [],
      rows: XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: "" }),
      rowMetadata: worksheet?.["!rows"] ?? [],
      autoFilter: worksheet?.["!autofilter"]?.ref ?? null,
      range: worksheet?.["!ref"] ?? null
    };
  }, bytes);

  const auditExcel = async (label) => {
    const data = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
      const visibleControls = [...document.querySelectorAll("button, input:not([type=hidden]), select, a[href], summary")]
        .filter((node) => node.getClientRects().length > 0);
      const nameless = visibleControls.filter((node) => !(
        node.getAttribute("aria-label") ||
        node.getAttribute("aria-labelledby") ||
        node.textContent?.trim() ||
        node.labels?.[0]?.textContent?.trim()
      ));
      return {
        duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
        nameless: nameless.map((node) => node.outerHTML.slice(0, 120)),
        h1: document.querySelectorAll("h1").length,
        main: Boolean(document.querySelector("main")),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        dropVisible: Boolean(document.querySelector("[data-excel-drop-zone]")?.getClientRects().length),
        fileButtonVisible: Boolean(document.querySelector("[data-excel-file-trigger]")?.getClientRects().length)
      };
    });
    check(data.duplicateIds.length === 0, `${label} duplicate IDs: ${data.duplicateIds.join(", ")}`);
    check(data.nameless.length === 0, `${label} unnamed controls: ${data.nameless.join(" | ")}`);
    check(data.h1 === 1, `${label} has ${data.h1} h1 elements`);
    check(data.main, `${label} is missing main`);
    check(data.overflow <= 2, `${label} overflows horizontally by ${data.overflow}px`);
    check(data.dropVisible && data.fileButtonVisible, `${label} does not expose the file task immediately`);
  };

  const viewports = [
    { width: 1920, height: 993, name: "1920" },
    { width: 1440, height: 900, name: "1440" },
    { width: 1280, height: 720, name: "1280" },
    { width: 390, height: 844, name: "390" },
    { width: 320, height: 800, name: "320" }
  ];

  await step("Excel metadata, lazy parser, and five viewport layout", async () => {
    await goto("/");
    check(!requests.some(({ url }) => url.includes(vendorPath)), "homepage requested the XLSX parser");

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await goto("/excel");
      await auditExcel(`Excel ${viewport.name}`);
      check((await page.title()) === "Remove Duplicates from Excel Online — Free XLSX Tool", `${viewport.name} title is wrong`);
      check(
        (await page.locator('meta[name="description"]').getAttribute("content")) === "Remove duplicate rows from an Excel file. Pick the columns that define duplicates and download a cleaned XLSX—free, private, entirely in your browser.",
        `${viewport.name} description is wrong`
      );
      check((await page.locator("h1").textContent()).trim() === "Remove duplicates from Excel files online.", `${viewport.name} h1 is wrong`);
      await page.screenshot({ path: `output/playwright/excel-${viewport.name}.png`, fullPage: false });
    }
    check(!requests.some(({ url }) => url.includes(vendorPath)), "Excel page requested SheetJS before a valid workbook was selected");
  });

  let firstDownload;
  let basicSourceBytes;
  await step("file selection, hidden rows, multi-column keep-first, and downloaded workbook readback", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto("/excel");
    basicSourceBytes = await chooseFixture(page, "excel-basic.xlsx");
    const qa = await page.evaluate(() => window.__REMOVE_DUPLICATES_EXCEL_QA__);
    check(qa.inspection.visibleSheets === 1, "hidden worksheet appeared in the selector");
    check(qa.inspection.warningCodes.includes("styles"), "row/style risk was not surfaced");
    check((await page.locator("[data-excel-sheet] option").allTextContents()).join("|") === "Data", "visible sheet order is wrong");
    check((await page.locator("[data-excel-sheet-rows]").textContent()).trim() === "5", "declared sheet rows are wrong");
    check((await page.locator("[data-excel-columns] label").allTextContents()).join("|").includes("A — ID"), "header labels were not rendered");
    check((await page.locator(".inclusion-note").textContent()).includes("Hidden and filter-hidden rows"), "hidden-row disclosure is missing");
    check(requests.filter(({ url }) => url.includes(vendorPath)).length >= 1, "valid file did not lazy-load the XLSX parser");

    await chooseColumns([0, 1]);
    await page.locator("[data-excel-trim]").check();
    await page.locator("[data-excel-ignore-case]").check();
    await page.locator("[data-excel-remove-empty]").check();
    await confirmWarnings();
    await processWorkbook();

    const result = await page.evaluate(() => window.__REMOVE_DUPLICATES_EXCEL_QA__.result);
    check(result.total === 4 && result.unique === 2, "keep-first totals are wrong");
    check(result.duplicates === 1 && result.emptyRemoved === 1 && result.removed === 2, "duplicate/empty removal counts are wrong");
    check((await page.locator('[data-excel-stat="total"]').textContent()).trim() === "4", "visible total is wrong");

    firstDownload = await downloadWorkbook();
    check(firstDownload.name === "excel-basic-deduplicated.xlsx", "safe XLSX filename is wrong");
    const reopened = await reopenDownload(firstDownload.bytes);
    check(JSON.stringify(reopened.rows) === JSON.stringify([
      ["ID", "Region", "Note"],
      [" A ", "East", privateMarker],
      ["B", "West", "keep"]
    ]), "downloaded keep-first rows or original values are wrong");
    check(reopened.sheetNames.join("|") === "Data|Hidden", "non-selected worksheet was not preserved");
    check(reopened.sheetStates.find(({ name }) => name === "Hidden")?.Hidden === 1, "hidden sheet state was not preserved");
    check(reopened.rowMetadata[1]?.hidden === true, "hidden survivor row metadata was not preserved");
    check(reopened.autoFilter === "A1:C3", `auto-filter range is ${reopened.autoFilter}`);
    check(reopened.range === "A1:C3", `rewritten used range is ${reopened.range}`);
  });

  await step("setting invalidation, keep-last position, and Excel legal-dialog state", async () => {
    check(await page.locator("[data-excel-result]").isVisible(), "keep-first result is missing");
    check((await page.locator("[data-excel-download]").getAttribute("href"))?.startsWith("blob:"), "download URL is missing");
    await page.locator('[name="excel-keep"][value="last"]').check();
    check(await page.locator("[data-excel-result]").isHidden(), "setting change did not invalidate the result");
    check(
      (await page.locator("[data-excel-download]").getAttribute("href")) === "/excel#excel-tool",
      "setting change did not replace the old Blob URL with the safe static target"
    );
    check((await page.locator("[data-excel-status]").textContent()).includes("Settings changed"), "rerun guidance is missing");

    await processWorkbook();
    const lastDownload = await downloadWorkbook();
    const reopened = await reopenDownload(lastDownload.bytes);
    check(JSON.stringify(reopened.rows) === JSON.stringify([
      ["ID", "Region", "Note"],
      ["B", "West", "keep"],
      ["a", "east", "last duplicate"]
    ]), "keep-last did not retain the last value at its last position");

    const resultBefore = await page.evaluate(() => window.__REMOVE_DUPLICATES_EXCEL_QA__.result);
    await page.locator('footer [data-legal-link="terms"]').click();
    await page.locator("[data-legal-dialog]").waitFor({ state: "visible" });
    check(await page.evaluate(() => location.pathname) === "/terms", "Excel Terms did not create a history path");
    check((await page.locator(":focus").getAttribute("aria-label")) === "Close Terms", "Excel legal focus did not move to Close");
    await page.waitForTimeout(200);
    const dialogVisual = await page.locator("[data-legal-dialog]").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        opacity: Number.parseFloat(getComputedStyle(dialog).opacity),
        width: rect.width,
        height: rect.height,
        intersectsViewport: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
      };
    });
    check(dialogVisual.opacity > 0.99, `Excel legal dialog opacity is ${dialogVisual.opacity}`);
    check(dialogVisual.width >= 280 && dialogVisual.height >= 240, `Excel legal dialog is only ${dialogVisual.width}x${dialogVisual.height}`);
    check(dialogVisual.intersectsViewport, "Excel legal dialog does not intersect the viewport");
    await page.screenshot({ path: "output/playwright/excel-legal-dialog.png", fullPage: false });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-legal-dialog]")?.open);
    check(await page.evaluate(() => location.pathname) === "/excel", "Excel legal close did not restore /excel");
    const stateAfter = await page.evaluate(() => ({
      inspection: window.__REMOVE_DUPLICATES_EXCEL_QA__.inspection,
      result: window.__REMOVE_DUPLICATES_EXCEL_QA__.result
    }));
    check(stateAfter.inspection?.visibleSheets === 1, "legal dialog cleared workbook inspection state");
    check(JSON.stringify(stateAfter.result) === JSON.stringify(resultBefore), "legal dialog changed the workbook result");
  });

  await step("zero-removal formula-safe contract returns byte-identical input", async () => {
    await clearWorkbook();
    const original = await chooseFixture(page, "excel-typed-unique.xlsx");
    await confirmWarnings();
    await processWorkbook();
    const result = await page.evaluate(() => window.__REMOVE_DUPLICATES_EXCEL_QA__.result);
    check(result.unchanged === true && result.removed === 0, "unchanged workbook result is wrong");
    const downloaded = await downloadWorkbook();
    check(
      downloaded.bytes.length === original.length && downloaded.bytes.every((byte, index) => byte === original[index]),
      "zero-removal download is not byte-for-byte identical"
    );
  });

  await step("drag-and-drop path and advanced-feature confirmation gate", async () => {
    await clearWorkbook();
    await page.locator("[data-excel-drop-zone]").evaluate((element, payload) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(payload.bytes)], payload.name, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { name: "dragged.xlsx", bytes: firstDownload.bytes });
    await page.waitForFunction(() => Boolean(window.__REMOVE_DUPLICATES_EXCEL_QA__?.inspection));
    check((await page.locator("[data-excel-file-name]").textContent()).trim() === "dragged.xlsx", "drop path did not retain the file name");

    await clearWorkbook();
    await chooseFixture(page, "excel-warning.xlsx");
    const warningCodes = await page.evaluate(() => window.__REMOVE_DUPLICATES_EXCEL_QA__.inspection.warningCodes);
    check(warningCodes.includes("defined_names"), "named-range warning was not detected");
    await page.locator("[data-excel-process]").click();
    await page.locator("[data-excel-error]").waitFor({ state: "visible" });
    check((await page.locator("[data-excel-error]").textContent()).includes("confirm"), "warning confirmation error is missing");
    check((await page.locator(":focus").getAttribute("data-excel-confirm-warnings")) !== null, "warning confirmation did not receive focus");
    check(await page.locator("[data-excel-result]").isHidden(), "warning gate created a result without consent");
    await page.locator("[data-excel-confirm-warnings]").check();
    await processWorkbook();
  });

  await step("formula, missing-cache, and merge safety blocks recover cleanly", async () => {
    await clearWorkbook();
    await chooseFixture(page, "excel-formula.xlsx");
    check(await page.locator("[data-excel-formula-notice]").isVisible(), "formula safety notice is hidden");
    await confirmWarnings();
    await page.locator("[data-excel-process]").click();
    await page.locator("[data-excel-error]").waitFor({ state: "visible" });
    check((await page.locator("[data-excel-error]").textContent()).includes("contains formulas"), "formula_shift_unsafe message is wrong");
    check(await page.locator("[data-excel-result]").isHidden(), "formula block created a download");

    await clearWorkbook();
    await chooseFixture(page, "excel-missing-formula-cache.xlsx");
    await chooseColumns([1]);
    await confirmWarnings();
    await page.locator("[data-excel-process]").click();
    await page.locator("[data-excel-error]").waitFor({ state: "visible" });
    check((await page.locator("[data-excel-error]").textContent()).includes("no saved display value"), "missing_formula_cache message is wrong");

    await clearWorkbook();
    await chooseFixture(page, "excel-merge-conflict.xlsx");
    await chooseColumns([1]);
    await confirmWarnings();
    await page.locator("[data-excel-process]").click();
    await page.locator("[data-excel-error]").waitFor({ state: "visible" });
    check((await page.locator("[data-excel-error]").textContent()).includes("merged range intersects"), "merge_conflict message is wrong");
  });

  await step("unsupported formats, corrupt package recovery, and safe Clear cancellation", async () => {
    const basic = basicSourceBytes;
    const formats = [
      ["legacy.xls", "Legacy .xls files are not supported"],
      ["macros.xlsm", "Macro-enabled .xlsm files are not supported"],
      ["open.ods", "OpenDocument .ods files are not supported"],
      ["apple.numbers", "Apple Numbers files are not supported"],
      ["unknown.bin", "Only .xlsx files are supported"]
    ];
    for (const [name, expected] of formats) {
      await chooseBrowserFile(page, { name, bytes: basic, type: "application/octet-stream" });
      await page.locator("[data-excel-error]").waitFor({ state: "visible" });
      check((await page.locator("[data-excel-error]").textContent()).includes(expected), `${name} guidance is wrong`);
    }

    await chooseBrowserFile(page, {
      name: "corrupt.xlsx",
      bytes: [..."not a zip package"].map((character) => character.charCodeAt(0))
    });
    await page.locator("[data-excel-error]").waitFor({ state: "visible" });
    check(
      (await page.locator("[data-excel-error]").textContent()).includes("invalid ZIP end of central directory"),
      "corrupt package error is not specific"
    );
    await chooseFixture(page, "excel-basic.xlsx");
    check((await page.locator("[data-excel-status]").textContent()).includes("inspected locally"), "valid file did not recover after a corrupt file");

    await clearWorkbook();
    await chooseBrowserFile(page, { name: "cancelled.xlsx", bytes: basic });
    await page.locator("[data-excel-clear]").click();
    await page.waitForTimeout(750);
    const cleared = await page.evaluate(() => ({
      inspection: window.__REMOVE_DUPLICATES_EXCEL_QA__.inspection,
      result: window.__REMOVE_DUPLICATES_EXCEL_QA__.result,
      workerActive: window.__REMOVE_DUPLICATES_EXCEL_QA__.workerActive,
      state: window.__REMOVE_DUPLICATES_EXCEL_QA__.state
    }));
    check(cleared.inspection === null && cleared.result === null && !cleared.workerActive && cleared.state === "empty", "Clear allowed a stale Worker result to return");
  });

  await step("parser failure stays in the Worker with no main-thread fallback", async () => {
    const browser = page.context().browser();
    check(browser, "Playwright browser handle is unavailable");
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    let vendorAttempts = 0;
    try {
      await context.route(`**${vendorPath}`, async (route) => {
        vendorAttempts += 1;
        await route.abort("failed");
      });
      const isolated = await context.newPage();
      const response = await isolated.goto(`${base}/excel`, { waitUntil: "networkidle" });
      check(response?.status() === 200, `isolated Excel page returned ${response?.status()}`);
      await chooseBrowserFile(isolated, { name: "excel-basic.xlsx", bytes: basicSourceBytes });
      await isolated.locator("[data-excel-error]").waitFor({ state: "visible", timeout: 15_000 });
      check((await isolated.locator("[data-excel-error]").textContent()).includes("parser could not be loaded"), "parser_unavailable message is wrong");
      const state = await isolated.evaluate(() => ({
        inspection: window.__REMOVE_DUPLICATES_EXCEL_QA__.inspection,
        result: window.__REMOVE_DUPLICATES_EXCEL_QA__.result,
        workerActive: window.__REMOVE_DUPLICATES_EXCEL_QA__.workerActive
      }));
      check(vendorAttempts === 1, `parser URL was attempted ${vendorAttempts} times`);
      check(state.inspection === null && state.result === null && !state.workerActive, "parser failure fell back to main-thread processing");
    } finally {
      await context.close();
    }
  });

  await step("workbook privacy, storage, network, and runtime hygiene", async () => {
    const hygiene = await page.evaluate(async (marker) => {
      const attributeValues = [...document.querySelectorAll("*")]
        .flatMap((node) => [...node.attributes].map(({ value }) => value));
      const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      return {
        textLeak: document.body.textContent.includes(marker),
        attributeLeak: attributeValues.some((value) => value.includes(marker)),
        qaLeak: JSON.stringify(window.__REMOVE_DUPLICATES_EXCEL_QA__).includes(marker),
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        databases: databases.length
      };
    }, privateMarker);
    check(!hygiene.textLeak && !hygiene.attributeLeak && !hygiene.qaLeak, "workbook cell contents leaked into page text, attributes, or QA state");
    check(hygiene.localStorage === 0 && hygiene.sessionStorage === 0 && hygiene.databases === 0, "workbook processing wrote browser storage");
    check(!requests.some(({ body }) => body.includes(privateMarker)), "workbook contents appeared in an HTTP request body");
    check(!requests.some(({ method }) => method !== "GET" && method !== "HEAD"), "Excel flow made a non-read HTTP request");
    check(externalOrigins.size === 0, `external runtime origins: ${[...externalOrigins].join(", ")}`);
    check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
  });

  if (failures.length > 0) throw new Error(failures.join("\n"));
  return {
    ok: true,
    passed: results.length,
    failed: 0,
    summary: results,
    vendorRequests: requests.filter(({ url }) => url.includes(vendorPath)).length,
    externalOrigins: [...externalOrigins],
    consoleErrors
  };
}
