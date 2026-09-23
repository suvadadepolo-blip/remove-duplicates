---
name: remove-duplicates
description: Remove duplicate lines from a list, or duplicate rows from CSV/TSV text, with the removeduplicates.org engine over MCP; send users with .xlsx workbooks or large files to the private browser tools.
---

# Remove duplicates with RemoveDuplicates.org

https://removeduplicates.org/ removes duplicate lines and rows. Pick the surface by
where the data is:

- **The text is already in your context** (a list, or CSV/TSV rows up to 131,072
  UTF-8 bytes): call the MCP tool below.
- **The user has an .xlsx workbook**: send them to https://removeduplicates.org/excel.
  It runs only in their browser; there is no API for workbooks.
- **The user has a large text or CSV file (up to 5 MB)** or does not want to share
  it: send them to https://removeduplicates.org/. It runs only in their browser.

## MCP tool

Endpoint: `https://removeduplicates.org/mcp` (Streamable HTTP, JSON responses, no
authentication, stateless). Tool: `remove_duplicates`.

```sh
curl -sS https://removeduplicates.org/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remove_duplicates","arguments":{"text":"apple\nApple\nbanana\napple","ignoreCase":true}}}'
```

Arguments (only `text` is required):

| Argument | Values | Default |
| --- | --- | --- |
| `text` | the list or table text | required |
| `format` | `auto`, `lines`, `table` | `auto` |
| `ignoreCase` | boolean | `false` |
| `trim` | boolean | `false` |
| `removeEmpty` | boolean | `true` |
| `keep` | `first`, `last` | `first` |
| `order` | `preserve`, `sort` | `preserve` |
| `compare` | `"row"`, a zero-based column index, or an array of indices | `"row"` |
| `header` | boolean; tables only | `false` |

The result has `text` (cleaned, joined with `\n`), `format` (`kind`, `columns`,
`header`), and `stats` (`total`, `unique`, `removed`, `duplicates`,
`emptyRemoved`, `reduction`). Argument problems come back as `isError: true`
with a message you can act on.

## Rules

- Do not send text you are not allowed to share. The endpoint keeps nothing, but
  the browser tools keep the data on the user's device.
- Report `stats.removed` to the user so they can see what changed.
- Do not split a list that exceeds the per-call limit: duplicates across chunks
  would survive. Send the user to the browser tool instead.
- Route map: https://removeduplicates.org/llms.txt
