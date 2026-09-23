async (page) => {
  const base = page.url().match(/^https?:\/\/[^/]+/)?.[0] || "http://127.0.0.1:3630";
  const results = [];
  const failures = [];
  const consoleErrors = [];
  const externalOrigins = new Set();
  const requestPayloads = [];
  const privateMarker = "RDQA_PRIVATE_MARKER_71f3";

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          window.__RDQA_COPIED_TEXT__ = value;
        }
      }
    });
  });

  page.on("console", (message) => {
    const sourceUrl = message.location().url || "";
    if (message.type() === "error" && !sourceUrl.includes("/missing-rdqa")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const origin = request.url().match(/^https?:\/\/[^/]+/)?.[0];
    if (origin && origin !== base) externalOrigins.add(origin);
    requestPayloads.push(`${request.url()}\n${request.postData() || ""}`);
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

  const waitForTableState = async (label, predicate, argument = undefined) => {
    try {
      await page.waitForFunction(predicate, argument, { timeout: 30_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        input: document.querySelector("[data-input]")?.value,
        output: document.querySelector("[data-output]")?.value,
        compare: document.querySelector("[data-compare]")?.value,
        compareLabels: [...(document.querySelector("[data-compare]")?.options ?? [])].map((option) => option.textContent),
        announcer: document.querySelector("[data-announcer]")?.textContent,
        qa: window.__REMOVE_DUPLICATES_QA__
          ? {
              processing: window.__REMOVE_DUPLICATES_QA__.processing,
              mode: window.__REMOVE_DUPLICATES_QA__.processingMode,
              table: window.__REMOVE_DUPLICATES_QA__.result?.table,
              stats: window.__REMOVE_DUPLICATES_QA__.result?.stats,
              text: window.__REMOVE_DUPLICATES_QA__.result?.text
            }
          : null
      }));
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}`);
    }
  };

  const audit = async (label) => {
    const data = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const controls = [...document.querySelectorAll("button, input:not([type=file]):not([type=hidden]), select, textarea, a[href], summary")];
      const visible = controls.filter((node) => node.getClientRects().length > 0);
      const nameless = visible.filter((node) => {
        const labelText = node.getAttribute("aria-label")
          || node.getAttribute("aria-labelledby")
          || node.textContent?.trim()
          || node.labels?.[0]?.textContent?.trim()
          || (node.id && document.querySelector(`label[for="${node.id}"]`)?.textContent?.trim());
        return !labelText;
      });
      const tiny = visible.filter((node) => {
        if (node.matches("textarea, input[type=checkbox], input[type=radio]")) return false;
        const rect = node.getBoundingClientRect();
        return rect.width < 40 || rect.height < 40;
      });
      return {
        duplicateIds,
        nameless: nameless.map((node) => node.outerHTML.slice(0, 120)),
        tiny: tiny.map((node) => `${node.tagName}:${node.textContent?.trim().slice(0, 30)} ${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`),
        h1: document.querySelectorAll("h1").length,
        main: Boolean(document.querySelector("main")),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });
    check(data.duplicateIds.length === 0, `${label} duplicate IDs: ${data.duplicateIds.join(", ")}`);
    check(data.nameless.length === 0, `${label} unnamed controls: ${data.nameless.join(" | ")}`);
    check(data.tiny.length === 0, `${label} undersized controls: ${data.tiny.join(" | ")}`);
    check(data.h1 === 1, `${label} has ${data.h1} h1 elements`);
    check(data.main, `${label} is missing main`);
    check(data.overflow <= 2, `${label} overflows horizontally by ${data.overflow}px`);
  };

  const viewports = [
    { width: 1920, height: 993, name: "1920" },
    { width: 1440, height: 900, name: "1440" },
    { width: 1280, height: 720, name: "1280" },
    { width: 390, height: 844, name: "390" },
    { width: 320, height: 800, name: "320" }
  ];

  await step("five viewport layout and first-task visibility", async () => {
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await goto("/");
      await audit(`home ${viewport.name}`);
      check((await page.locator("h1").textContent()).includes("Remove duplicates from lines and lists"), `${viewport.name} heading is not task-specific`);
      check((await page.title()) === "Remove Duplicates Online — Lines & Text Lists", `${viewport.name} document title is wrong`);
      check(
        (await page.locator('meta[name="description"]').getAttribute("content"))?.startsWith("Effortlessly remove duplicate lines from your text lists."),
        `${viewport.name} meta description is wrong`
      );
      const inputBox = await page.locator("[data-input]").boundingBox();
      const processBox = await page.locator("[data-process]").boundingBox();
      check(inputBox && inputBox.y < viewport.height, `${viewport.name} input starts below the first viewport`);
      if (viewport.width >= 1280) {
        check(processBox && processBox.y < viewport.height, `${viewport.name} process action starts below the first viewport`);
      }
      if (viewport.width <= 390) {
        check((await page.locator('[data-mobile-tab="input"]').getAttribute("aria-selected")) === "true", `${viewport.name} mobile input tab is not active`);
        check(await page.locator('[data-mobile-panel="result"]').isHidden(), `${viewport.name} inactive result panel remains visible`);
      }
      await page.screenshot({
        path: `output/playwright/home-${viewport.name}.png`,
        fullPage: false
      });
    }
  });

  await step("dedupe defaults and live statistics", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto("/");
    await page.locator("[data-input]").fill("Apple\nBanana\nApple\n apple \n\nBanana");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.stats?.total === 6 && !window.__REMOVE_DUPLICATES_QA__.processing);
    check((await page.locator("[data-output]").inputValue()) === "Apple\nBanana\n apple ", "default cleaned text is wrong");
    check((await page.locator('[data-stat="unique"]').textContent()).trim() === "3", "default unique count is wrong");
    check((await page.locator('[data-stat="removed"]').textContent()).trim() === "3", "default removed count is wrong");

    await page.locator("[data-ignore-case]").check();
    await page.locator("[data-trim]").check();
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 2);
    check((await page.locator("[data-output]").inputValue()) === "Apple\nBanana", "case-insensitive trimmed result is wrong");
    check((await page.locator('[data-stat="reduction"]').textContent()).trim() === "66.7%", "reduction is wrong");
  });

  await step("keep-last, stable order, natural sort, and keyboard action", async () => {
    await page.locator('[name="keep"][value="last"]').check();
    await page.locator('[name="order"][value="preserve"]').check();
    await page.locator("[data-input]").fill("A\nB\n a \nC\nb");
    await page.locator("[data-input]").press("Control+Enter");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.text === "a\nC\nb");
    check((await page.locator("[data-output]").inputValue()) === "a\nC\nb", "keep-last source order is wrong");

    await page.locator("[data-ignore-case]").uncheck();
    await page.locator("[data-trim]").uncheck();
    await page.locator('[name="keep"][value="first"]').check();
    await page.locator('[name="order"][value="sort"]').check();
    await page.locator("[data-input]").fill("item10\nitem2\nitem1\nitem2");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.text === "item1\nitem2\nitem10");
    check((await page.locator("[data-output]").inputValue()) === "item1\nitem2\nitem10", "natural sort is wrong");
  });

  await step("copy and TXT download", async () => {
    const expected = await page.locator("[data-output]").inputValue();
    const copyBefore = await page.locator("[data-copy]").boundingBox();
    const downloadBefore = await page.locator("[data-download]").boundingBox();
    await page.locator("[data-copy]").click();
    await page.waitForFunction(() => window.__RDQA_COPIED_TEXT__ === "item1\nitem2\nitem10");
    check((await page.locator("[data-status]").textContent()).includes("copied"), "copy success feedback is missing");
    check((await page.locator("[data-copy]").textContent()).trim() === "Copied ✓", "copy button did not show transient feedback");
    const copyAfter = await page.locator("[data-copy]").boundingBox();
    const downloadAfter = await page.locator("[data-download]").boundingBox();
    check(copyBefore && copyAfter && Math.abs(copyBefore.width - copyAfter.width) < 1, "copy feedback changed button width");
    check(downloadBefore && downloadAfter && Math.abs(downloadBefore.x - downloadAfter.x) < 1, "copy feedback shifted the download action");
    await page.waitForFunction(() => document.querySelector("[data-copy]")?.textContent.trim() === "Copy", null, { timeout: 3_000 });

    const downloadPromise = page.waitForEvent("download");
    await page.locator("[data-download]").click();
    const download = await downloadPromise;
    check(download.suggestedFilename() === "unique-lines.txt", "download filename is wrong");
    const stream = await download.createReadStream();
    let downloadedText = "";
    for await (const chunk of stream) downloadedText += chunk.toString();
    check(downloadedText === expected, "downloaded text content is wrong");
    check(
      !(await page.evaluate(() => Object.hasOwn(window.__REMOVE_DUPLICATES_QA__, "lastDownloadedText"))),
      "production QA surface retains downloaded text"
    );
  });

  await step("Clear Undo restores once and input mutation invalidates it", async () => {
    await page.locator('[name="order"][value="preserve"]').check();
    await page.locator("[data-input]").fill("restore me\nrestore me\nkeep me");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.text === "restore me\nkeep me");
    await page.locator("[data-clear]").click();
    check((await page.locator("[data-input]").inputValue()) === "", "Clear did not empty the input");
    check((await page.locator("[data-output]").inputValue()) === "", "Clear did not empty the result");
    check((await page.locator("[data-status]").textContent()).trim() === "Cleared.", "Clear status is wrong");
    check((await page.locator("[data-undo]").evaluate((node) => node.tagName)) === "BUTTON", "Undo is not a real button");
    check(await page.locator("[data-undo]").isVisible(), "Undo is not visible after Clear");
    await page.locator("[data-undo]").click();
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.text === "restore me\nkeep me");
    check((await page.locator("[data-input]").inputValue()) === "restore me\nrestore me\nkeep me", "Undo did not restore input");
    check(await page.locator("[data-undo]").isHidden(), "Undo remained available after use");

    await page.locator("[data-clear]").click();
    await page.locator("[data-input]").fill("new input");
    check(await page.locator("[data-undo]").isHidden(), "manual input did not invalidate Undo");
    await page.locator("[data-clear]").click();
    await page.locator("[data-sample]").click();
    check(await page.locator("[data-undo]").isHidden(), "sample replacement did not invalidate Undo");
  });

  await step("local text and CSV files, spreadsheet guidance, and stale-read protection", async () => {
    await page.locator('[name="order"][value="preserve"]').check();
    await page.locator("[data-file-input]").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["file line\nfile line\nother"], "local-list.txt", { type: "text/plain" }));
      element.files = transfer.files;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector("[data-output]")?.value === "file line\nother");
    check((await page.locator("[data-status]").textContent()).includes("locally"), "local file feedback is missing");

    await page.locator("[data-file-input]").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["\ufeffname,email\nAda,ada@example.com\nAda,ada@example.com"], "windows.csv", { type: "application/vnd.ms-excel" }));
      element.files = transfer.files;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.table?.kind === "csv" && window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 2);
    check(!(await page.locator("[data-input]").inputValue()).startsWith("\ufeff"), "CSV BOM remained in the editor");
    check((await page.locator("[data-output]").inputValue()) === "name,email\nAda,ada@example.com", "Windows CSV result is wrong");

    await page.locator("[data-file-input]").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["log line\nlog line\nkeep"], "events.log", { type: "text/plain" }));
      element.files = transfer.files;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector("[data-output]")?.value === "log line\nkeep");

    const beforeSpreadsheetDrop = await page.locator("[data-input]").inputValue();
    await page.locator("[data-drop-zone]").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["binary placeholder"], "book.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    check(
      (await page.locator("[data-status]").textContent()).trim() === "Open this XLSX file in the Excel duplicate remover to choose a worksheet and comparison columns without uploading it.",
      "spreadsheet drop did not show dedicated Excel-tool guidance"
    );
    check((await page.locator('[data-status] a[href="/excel"]').textContent()).trim() === "Excel duplicate remover", "spreadsheet guidance does not link to /excel");
    check((await page.locator("[data-input]").inputValue()) === beforeSpreadsheetDrop, "rejected spreadsheet replaced input");

    await page.locator("[data-drop-zone]").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["drop\ndrop\nkept"], "dropped.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector("[data-output]")?.value === "drop\nkept");

    await page.locator("[data-drop-zone]").evaluate((element) => {
      const slowFile = {
        name: "slow.txt",
        size: 32,
        text: () => new Promise((resolve) => {
          window.__RDQA_RESOLVE_SLOW_FILE__ = resolve;
        })
      };
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [slowFile] } });
      element.dispatchEvent(event);
    });
    await page.locator("[data-input]").fill("newer manual line\nnewer manual line\nkeep newer");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.text === "newer manual line\nkeep newer");
    await page.evaluate(() => window.__RDQA_RESOLVE_SLOW_FILE__("stale file\nstale file\noverwrite"));
    await page.waitForTimeout(250);
    check(
      (await page.locator("[data-input]").inputValue()) === "newer manual line\nnewer manual line\nkeep newer",
      "an older file read overwrote newer manual input"
    );
    check(
      (await page.locator("[data-output]").inputValue()) === "newer manual line\nkeep newer",
      "an older file read overwrote the newer result"
    );
  });

  await step("table detection, column comparison, header counts, clipboard, and downloads", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto("/");
    const source = 'Name\tEmail\tNote\nAda\tada@example.com\t"two\nlines"\nGrace\tgrace@example.com\tkeep\nAda\tada+new@example.com\tlatest';
    await page.locator("[data-input]").fill(source);
    await page.evaluate(() => window.__REMOVE_DUPLICATES_QA__.process());
    await waitForTableState("TSV detection", () => window.__REMOVE_DUPLICATES_QA__?.result?.table?.kind === "tsv" && window.__REMOVE_DUPLICATES_QA__?.result?.table?.columns === 3);
    check(await page.locator("[data-table-options]").isVisible(), "auto-detected table controls are hidden");
    check((await page.locator("[data-detected-format]").textContent()).trim() === "Detected table · 3 columns · tab-separated", "detected table chip is wrong");
    check((await page.locator("[data-input-lines]").textContent()).includes("4 rows · 3 columns"), "table input hint counts physical lines instead of records");

    await page.locator("[data-header]").check();
    await waitForTableState("header labels", () => document.querySelector("[data-compare]")?.options?.[1]?.textContent === "Name");
    await page.locator("[data-compare]").selectOption("0");
    const expected = 'Name\tEmail\tNote\nAda\tada@example.com\t"two\nlines"\nGrace\tgrace@example.com\tkeep';
    await waitForTableState("column result", (value) => window.__REMOVE_DUPLICATES_QA__?.result?.text === value, expected);
    check((await page.locator("[data-output]").inputValue()) === expected, "column-based TSV result is wrong");
    check((await page.locator('[data-stat="total"]').textContent()).trim() === "3", "header was included in total rows");
    check((await page.locator('[data-stat="unique"]').textContent()).trim() === "2", "unique row count is wrong");
    check((await page.locator('[data-stat-label="total"]').textContent()).trim() === "Total rows", "table statistics did not switch to rows");
    check((await page.locator("[data-mobile-result-count]").textContent()).trim() === "2", "mobile result badge is not a bare number");

    await page.locator("[data-copy]").click();
    await page.waitForFunction((value) => window.__RDQA_COPIED_TEXT__ === value, expected);
    const tsvDownloadPromise = page.waitForEvent("download");
    await page.locator("[data-download]").click();
    const tsvDownload = await tsvDownloadPromise;
    check(tsvDownload.suggestedFilename() === "unique-rows.tsv", "TSV download filename is wrong");
    const tsvStream = await tsvDownload.createReadStream();
    let tsvText = "";
    for await (const chunk of tsvStream) tsvText += chunk.toString();
    check(tsvText === expected, "TSV download content is wrong");

    await page.setViewportSize({ width: 320, height: 800 });
    await audit("table home 320");
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.locator("[data-compare]").selectOption("2");
    await page.locator("[data-input]").fill("Name\tCity\nA\tParis\nB\tRome");
    await page.evaluate(() => window.__REMOVE_DUPLICATES_QA__.process());
    await waitForTableState("invalid compare reset", () =>
      document.querySelector("[data-compare]")?.value === "row"
      && window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 2
      && document.querySelector("[data-announcer]")?.textContent.includes("reset to Entire row")
    );
    check((await page.locator("[data-output]").inputValue()) === "Name\tCity\nA\tParis\nB\tRome", "invalid compare reset did not reprocess by entire row");
    check((await page.locator("[data-announcer]").textContent()).includes("reset to Entire row"), "invalid compare reset was not announced");

    await page.locator("[data-header]").uncheck();
    await page.locator("[data-input]").fill("name,city\nAda,Paris\nAda,Paris");
    await page.evaluate(() => window.__REMOVE_DUPLICATES_QA__.process());
    await waitForTableState("CSV result", () => window.__REMOVE_DUPLICATES_QA__?.result?.table?.kind === "csv" && window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 2);
    const csvDownloadPromise = page.waitForEvent("download");
    await page.locator("[data-download]").click();
    const csvDownload = await csvDownloadPromise;
    check(csvDownload.suggestedFilename() === "unique-rows.csv", "CSV download filename is wrong");

    await page.locator('[name="format"][value="table"]').check();
    await page.locator("[data-header]").check();
    await page.locator("[data-input]").fill("Name\tCity");
    await page.evaluate(() => window.__REMOVE_DUPLICATES_QA__.process());
    await waitForTableState("header-only result", () => window.__REMOVE_DUPLICATES_QA__?.result?.table?.kind === "tsv" && window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 0);
    check((await page.locator("[data-output]").inputValue()) === "Name\tCity", "header-only table did not preserve the header");
    check(await page.locator("[data-copy]").isDisabled(), "header-only table enabled Copy");
    check(await page.locator("[data-download]").isDisabled(), "header-only table enabled Download");
  });

  await step("platform-aware shortcut hint and touch-only hiding", async () => {
    const browser = page.context().browser();
    check(browser, "Playwright browser handle is unavailable");
    const verifyPlatform = async (platform, expected) => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
      try {
        await context.addInitScript((value) => {
          Object.defineProperty(navigator, "platform", { configurable: true, value });
          Object.defineProperty(navigator, "userAgentData", {
            configurable: true,
            value: { platform: value }
          });
        }, platform);
        const platformPage = await context.newPage();
        await platformPage.goto(`${base}/`, { waitUntil: "networkidle" });
        check((await platformPage.locator("[data-shortcut-hint]").textContent()).trim() === expected, `${platform} shortcut hint is wrong`);
      } finally {
        await context.close();
      }
    };
    await verifyPlatform("MacIntel", "⌘ ↵");
    await verifyPlatform("Win32", "Ctrl ↵");

    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${base}/`, { waitUntil: "networkidle" });
      check(await touchPage.locator("[data-shortcut-hint]").isHidden(), "touch-only shortcut hint remains visible");
    } finally {
      await touchContext.close();
    }
  });

  await step("legal history, Escape, back, focus, and text preservation", async () => {
    await goto("/");
    await page.locator("[data-input]").fill("private draft\nprivate draft\nkeep me");
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.result?.stats?.unique === 2);
    const beforeInput = await page.locator("[data-input]").inputValue();
    const beforeOutput = await page.locator("[data-output]").inputValue();

    const termsLink = page.locator('footer [data-legal-link="terms"]');
    await termsLink.click();
    await page.locator("[data-legal-dialog]").waitFor({ state: "visible" });
    check(await page.evaluate(() => location.pathname) === "/terms", "Terms did not create a real history path");
    check((await page.locator(":focus").getAttribute("aria-label")) === "Close Terms", "focus did not move to Close Terms");
    await page.waitForTimeout(200);
    await page.screenshot({ path: "output/playwright/legal-dialog.png", fullPage: false });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-legal-dialog]")?.open);
    check(await page.evaluate(() => location.pathname) === "/", "Escape did not restore the home URL");
    check((await page.locator(":focus").getAttribute("data-legal-link")) === "terms", "focus did not return to Terms");
    check((await page.locator("[data-input]").inputValue()) === beforeInput, "Terms flow cleared the input");
    check((await page.locator("[data-output]").inputValue()) === beforeOutput, "Terms flow changed the result");

    await page.locator('footer [data-legal-link="privacy"]').click();
    check(await page.evaluate(() => location.pathname) === "/privacy", "Privacy did not create a real history path");
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("[data-legal-dialog]")?.open);
    check((await page.locator("[data-input]").inputValue()) === beforeInput, "browser Back cleared the input");
    await page.goForward();
    await page.waitForFunction(() => document.querySelector("[data-legal-dialog]")?.open);
    check(await page.evaluate(() => location.pathname) === "/privacy", "browser Forward did not reopen Privacy");
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("[data-legal-dialog]")?.open);
    check((await page.locator("[data-output]").inputValue()) === beforeOutput, "browser Forward/Back changed the result");
  });

  await step("direct legal pages and real 404", async () => {
    await goto("/terms");
    check((await page.locator('meta[name="robots"]').getAttribute("content")) === "noindex, nofollow", "Terms is not noindex");
    await audit("direct Terms");
    await goto("/privacy");
    check((await page.locator('meta[name="robots"]').getAttribute("content")) === "noindex, nofollow", "Privacy is not noindex");
    await audit("direct Privacy");

    const response = await page.goto(`${base}/missing-rdqa`, { waitUntil: "networkidle" });
    check(response?.status() === 404, `unknown route returned ${response?.status()} instead of 404`);
    check((await page.locator('meta[name="robots"]').getAttribute("content")) === "noindex, nofollow", "404 page is not noindex");
    await audit("404 page");
  });

  await step("near-limit text stays responsive in the Web Worker", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto("/");
    const receipt = await page.evaluate((marker) => new Promise((resolve) => {
      const unique = Array.from({ length: 500 }, (_, index) => `line-${String(index).padStart(3, "0")}-${marker}-${"x".repeat(74)}`);
      const text = Array.from({ length: 88 }, () => unique).flat().join("\n");
      const editor = document.querySelector("[data-input]");
      const assignedAt = performance.now();
      editor.value = text;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const gaps = [];
        const started = performance.now();
        let lastBeat = started;
        const heartbeat = setInterval(() => {
          const now = performance.now();
          gaps.push({ gap: now - lastBeat, at: now - started });
          lastBeat = now;
        }, 16);
        const inputStarted = performance.now();
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        window.__RDQA_HEARTBEAT__ = { gaps, heartbeat, started };
        resolve({
          inputDelay: performance.now() - inputStarted,
          pasteSettle: started - assignedAt,
          length: text.length
        });
      }));
    }), privateMarker);
    check(receipt.length > 4_500_000 && receipt.length < 5_200_000, `near-limit test input was ${receipt.length} characters`);
    check(receipt.inputDelay < 150, `near-limit input event blocked for ${Math.round(receipt.inputDelay)} ms`);
    await page.waitForFunction(() => window.__REMOVE_DUPLICATES_QA__?.processingMode === "worker" && !window.__REMOVE_DUPLICATES_QA__?.processing, null, { timeout: 20_000 });
    const proof = await page.evaluate(() => {
      const longestGap = window.__RDQA_HEARTBEAT__.gaps.reduce(
        (longest, sample) => sample.gap > longest.gap ? sample : longest,
        { gap: 0, at: 0 }
      );
      return {
        stats: window.__REMOVE_DUPLICATES_QA__.result.stats,
        sourceBytes: window.__REMOVE_DUPLICATES_QA__.result.sourceBytes,
        mode: window.__REMOVE_DUPLICATES_QA__.processingMode,
        duration: window.__REMOVE_DUPLICATES_QA__.duration,
        maxEventLoopGap: longestGap.gap,
        maxGapAt: longestGap.at,
        elapsed: performance.now() - window.__RDQA_HEARTBEAT__.started
      };
    });
    await page.evaluate(() => clearInterval(window.__RDQA_HEARTBEAT__.heartbeat));
    check(proof.mode === "worker", "large input did not use the Web Worker");
    check(proof.stats.total === 44_000 && proof.stats.unique === 500, "near-limit result counts are wrong");
    check(proof.sourceBytes === receipt.length, "near-limit byte count was not returned by the Worker");
    check(
      proof.maxEventLoopGap < 200,
      `near-limit event-loop gap reached ${Math.round(proof.maxEventLoopGap)} ms at ${Math.round(proof.maxGapAt)} ms (Worker ${Math.round(proof.duration)} ms; total ${Math.round(proof.elapsed)} ms; input ${Math.round(receipt.inputDelay)} ms; paste settle ${Math.round(receipt.pasteSettle)} ms)`
    );
    check(proof.duration < 5_000, `near-limit processing took ${Math.round(proof.duration)} ms`);
  });

  await step("WebMCP tool registers only for agents and runs locally", async () => {
    check(!requestPayloads.some((value) => value.includes("/js/webmcp.js")), "WebMCP module loaded in a browser without modelContext");
    const agentPage = await page.context().newPage();
    const agentRequests = [];
    agentPage.on("request", (request) => agentRequests.push(`${request.url()}\n${request.postData() || ""}`));
    agentPage.on("pageerror", (error) => consoleErrors.push(`WebMCP pageerror: ${error.message}`));
    await agentPage.addInitScript(() => {
      window.__RDQA_WEBMCP__ = [];
      Object.defineProperty(navigator, "modelContext", {
        configurable: true,
        value: {
          async registerTool(tool) {
            window.__RDQA_WEBMCP__.push(tool);
          }
        }
      });
    });
    try {
      const response = await agentPage.goto(`${base}/`, { waitUntil: "networkidle" });
      check(response && response.status() < 400, `WebMCP homepage returned ${response?.status()}`);
      await agentPage.waitForFunction(() => window.__RDQA_WEBMCP__.length === 1, null, { timeout: 10_000 });
      const outcome = await agentPage.evaluate(async (marker) => {
        const [tool] = window.__RDQA_WEBMCP__;
        const input = document.querySelector("[data-input]");
        input.value = "visitor draft";
        const output = await tool.execute({ text: `${marker}\nb\n${marker}\nB`, ignoreCase: true });
        let rejected = "";
        try {
          await tool.execute({ text: "a", keep: "middle" });
        } catch (error) {
          rejected = error.message;
        }
        return {
          name: tool.name,
          readOnly: tool.annotations?.readOnlyHint,
          required: tool.inputSchema?.required,
          parsed: JSON.parse(output),
          inputUntouched: input.value === "visitor draft",
          rejected
        };
      }, privateMarker);
      check(outcome.name === "remove_duplicates" && outcome.readOnly === true, `unexpected WebMCP tool ${outcome.name}`);
      check(JSON.stringify(outcome.required) === '["text"]', "WebMCP tool does not require text");
      check(outcome.parsed.text === `${privateMarker}\nb` && outcome.parsed.stats.removed === 2, `WebMCP result was ${JSON.stringify(outcome.parsed)}`);
      check(outcome.inputUntouched, "WebMCP tool changed the visitor's input");
      check(/keep must be/.test(outcome.rejected), `invalid WebMCP arguments were not rejected: ${outcome.rejected}`);
      check(agentRequests.some((value) => value.includes("/js/webmcp.js")), "WebMCP module was not requested for an agent browser");
      check(!agentRequests.some((value) => value.includes(privateMarker)), "WebMCP tool text left the browser");
    } finally {
      await agentPage.close();
    }
  });

  await step("no text upload, third-party origin, or runtime error", async () => {
    check(!requestPayloads.some((value) => value.includes(privateMarker)), "private input marker appeared in an HTTP request");
    check(externalOrigins.size === 0, `external runtime origins: ${[...externalOrigins].join(", ")}`);
    check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
  });

  if (failures.length > 0) throw new Error(failures.join("\n"));
  return {
    ok: true,
    passed: results.length,
    failed: 0,
    summary: results,
    externalOrigins: [...externalOrigins],
    consoleErrors
  };
}
