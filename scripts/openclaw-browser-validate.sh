#!/usr/bin/env bash
set -euo pipefail

# This wrapper is dispatched by the registered openclaw-ops project lane.
BASE_URL="${OPENCLAW_TARGET_URL:-${OPENCLAW_PREVIEW_URL:-http://127.0.0.1:3630}}"
ARTIFACT_DIR="${OPENCLAW_ARTIFACT_DIR:-$PWD/output/playwright}"
SESSION="removeduplicates-qa-$$"
mkdir -p output/playwright "$ARTIFACT_DIR"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required on the OpenClaw runtime" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required on the OpenClaw runtime" >&2
  exit 1
fi

run_with_timeout() {
  node - "$@" <<'NODE'
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(2);
let timedOut = false;
const child = spawn(command, args, { stdio: "inherit" });
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}, 180_000);
child.on("error", (error) => {
  clearTimeout(timer);
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(timedOut ? 124 : (code ?? 1));
});
NODE
}

pw() {
  npx --yes --package @playwright/cli playwright-cli -s="$SESSION" "$@"
}

cleanup() {
  pw close >"$ARTIFACT_DIR/playwright-close.log" 2>&1 || true
}
trap cleanup EXIT INT TERM

pw open "$BASE_URL/" >"$ARTIFACT_DIR/playwright-open.log"
pw resize 1440 900 >"$ARTIFACT_DIR/playwright-resize.log"
pw snapshot >"$ARTIFACT_DIR/home.snapshot.txt"
QA_CODE=$(<"$PWD/scripts/openclaw-browser-qa.js")
RESULT_LOG="$ARTIFACT_DIR/browser-results.log"
RESULT_TMP="$RESULT_LOG.tmp"

set +e
run_with_timeout npx --yes --package @playwright/cli \
  playwright-cli -s="$SESSION" run-code "$QA_CODE" \
  2>&1 | tee "$RESULT_TMP"
transport_rc=${PIPESTATUS[0]}
set -e

mv "$RESULT_TMP" "$RESULT_LOG"
unset QA_CODE
qa_rc="$transport_rc"
if [[ "$qa_rc" -eq 0 ]] && grep -q '^### Error' "$RESULT_LOG"; then
  qa_rc=1
fi
if [[ "$qa_rc" -eq 0 ]] && ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$RESULT_LOG"; then
  qa_rc=1
fi
if [[ "$qa_rc" -ne 0 ]]; then
  printf '{"complete":true,"ok":false,"transport_rc":%s}\n' "$transport_rc" >"$ARTIFACT_DIR/qa-complete.json.tmp"
  mv "$ARTIFACT_DIR/qa-complete.json.tmp" "$ARTIFACT_DIR/qa-complete.json"
  echo "Browser QA failed; see $RESULT_LOG" >&2
  exit "$qa_rc"
fi

EXCEL_QA_CODE=$(<"$PWD/scripts/openclaw-excel-browser-qa.js")
EXCEL_RESULT_LOG="$ARTIFACT_DIR/excel-browser-results.log"
EXCEL_RESULT_TMP="$EXCEL_RESULT_LOG.tmp"
set +e
run_with_timeout npx --yes --package @playwright/cli \
  playwright-cli -s="$SESSION" run-code "$EXCEL_QA_CODE" \
  2>&1 | tee "$EXCEL_RESULT_TMP"
excel_transport_rc=${PIPESTATUS[0]}
set -e
mv "$EXCEL_RESULT_TMP" "$EXCEL_RESULT_LOG"
unset EXCEL_QA_CODE
excel_qa_rc="$excel_transport_rc"
if [[ "$excel_qa_rc" -eq 0 ]] && grep -q '^### Error' "$EXCEL_RESULT_LOG"; then
  excel_qa_rc=1
fi
if [[ "$excel_qa_rc" -eq 0 ]] && ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$EXCEL_RESULT_LOG"; then
  excel_qa_rc=1
fi
if [[ "$excel_qa_rc" -ne 0 ]]; then
  printf '{"complete":true,"ok":false,"home_transport_rc":%s,"excel_transport_rc":%s}\n' "$transport_rc" "$excel_transport_rc" >"$ARTIFACT_DIR/qa-complete.json.tmp"
  mv "$ARTIFACT_DIR/qa-complete.json.tmp" "$ARTIFACT_DIR/qa-complete.json"
  echo "Excel browser QA failed; see $EXCEL_RESULT_LOG" >&2
  exit "$excel_qa_rc"
fi
pw console error >"$ARTIFACT_DIR/console-errors.log" || true
pw requests >"$ARTIFACT_DIR/network-requests.log" || true

for artifact in \
  home-1920.png \
  home-1440.png \
  home-1280.png \
  home-390.png \
  home-320.png \
  legal-dialog.png \
  excel-1920.png \
  excel-1440.png \
  excel-1280.png \
  excel-390.png \
  excel-320.png \
  excel-legal-dialog.png; do
  if [[ -f "output/playwright/$artifact" ]]; then
    cp "output/playwright/$artifact" "$ARTIFACT_DIR/$artifact"
  fi
done

printf '{"complete":true,"ok":true}\n' >"$ARTIFACT_DIR/qa-complete.json.tmp"
mv "$ARTIFACT_DIR/qa-complete.json.tmp" "$ARTIFACT_DIR/qa-complete.json"
