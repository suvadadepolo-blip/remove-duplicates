# Remove duplicates from lines and lists

Canonical page: https://removeduplicates.org/

RemoveDuplicates.org is a free duplicate remover for text lists, pasted spreadsheet rows, and CSV/TSV files. Paste text, type a list, or drop a TXT or CSV file. The website processes everything in the browser tab; nothing you enter is uploaded.

## What it does

- Removes duplicate lines from a list while keeping the original order.
- Keeps the first or the last occurrence of each duplicate.
- Optionally ignores capitalization, trims surrounding spaces, and drops empty lines.
- Can return the unique lines in natural (numeric-aware) sorted order instead.
- Detects pasted Excel or Google Sheets rows (tab-separated) and CSV text, then removes duplicate rows by the entire row or by one column, with an optional header row.
- Copies the result or downloads it as TXT, CSV, or TSV.
- Accepts TXT, CSV, TSV, LOG, Markdown, and LIST files up to 5 MB.

## Options

| Option | Choices | Default |
| --- | --- | --- |
| Format | Auto, Lines, Table | Auto |
| Ignore case | on / off | off |
| Trim spaces | on / off | off |
| Remove empty lines | on / off | on |
| When a line repeats | Keep first, Keep last | Keep first |
| Result order | Preserve order, Sort unique lines | Preserve order |
| Table: Compare by | Entire row or one column | Entire row |
| Table: First row is header | on / off | off |

Example with Ignore case on: `Maple Street`, `maple street`, `River Road`, `Maple Street` becomes `Maple Street`, `River Road` (2 unique lines, 2 removed).

## How it works

1. **Paste or open.** Add one item per line, or drop a TXT file onto the input.
2. **Set the rules.** Control capitalization, spaces, empty lines, which copy survives, and ordering.
3. **Use the result.** Copy the cleaned text or download it as a new TXT file.

## Privacy

Pasted text, opened text files, and selected XLSX workbooks are read in browser memory. Larger work may use a Web Worker inside the same tab. There are no content uploads, accounts, saved drafts, analytics scripts, or advertising pixels. Details: https://removeduplicates.org/privacy

## FAQ

### Is my text uploaded or stored?

No. Your pasted text and opened files are processed in browser memory, and large inputs may be handled by a Web Worker in the same browser tab. The site does not upload or persist that content.

### Can I remove duplicates without changing the original order?

Yes. Preserve order is the default. Choose Sort unique lines only when you want the cleaned result reordered.

### How do Ignore case and Trim spaces work?

Ignore case treats values such as Apple and apple as duplicates. Trim spaces removes surrounding spaces before lines are compared and uses the trimmed line in the result.

### Can I open a text or CSV file?

Yes. Choose or drop a TXT, CSV, TSV, LOG, Markdown, or LIST file up to 5 MB. Your browser reads it directly; the file is not uploaded to RemoveDuplicates.org.

### Can I remove duplicate rows from Excel or Google Sheets?

Yes. For an XLSX workbook, use the [Excel duplicate remover](https://removeduplicates.org/excel) to choose a worksheet and comparison columns, then download a cleaned copy. You can also copy Excel or Google Sheets rows and paste them here for text-based cleanup.

### Does it work with CSV files?

Yes. Drop a CSV file up to 5 MB. Quoted fields, embedded commas, and embedded newlines are handled locally, and nothing in the file is uploaded.

## Related

- [Remove duplicates from Excel (XLSX)](https://removeduplicates.org/excel)
- [For AI agents: MCP endpoint and route map](https://removeduplicates.org/llms.txt)
- [Source code (MIT)](https://github.com/describesomeone/remove-duplicates)
