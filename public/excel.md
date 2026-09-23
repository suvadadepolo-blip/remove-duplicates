# Remove duplicates from Excel files online

Canonical page: https://removeduplicates.org/excel

Choose an XLSX file, select a worksheet and comparison columns, then download a cleaned copy. The workbook is opened, checked, and rewritten entirely in the browser; it never leaves the tab. This page has no API: an AI agent should send the user to https://removeduplicates.org/excel to run it on their own device.

## Limits

- Only macro-free `.xlsx` workbooks.
- Up to 10 MiB compressed, 2,000 ZIP entries, 100 MiB declared expanded data, 500,000 workbook cells, and 250,000 cells in the selected sheet.

## Matching rules

| Option | Choices | Default |
| --- | --- | --- |
| First row contains headers | on / off | on |
| Compare by | Entire row, Selected columns | Entire row |
| Keep | First occurrence, Last occurrence | First occurrence |
| Trim surrounding spaces | on / off | off |
| Ignore uppercase/lowercase | on / off | off |
| Remove empty rows | on / off | off |

Hidden and filter-hidden rows are included in duplicate checks. Values are compared by their saved display text.

## How it works

1. **Choose locally.** The browser checks the XLSX package before a dedicated Worker opens it.
2. **Define a duplicate.** Compare the whole row or a stable combination of selected columns.
3. **Download a copy.** The original stays untouched; unsafe formula and merge changes are blocked.

## FAQ

### Is my Excel file uploaded or stored?

No. Your browser reads and processes the selected workbook in memory. RemoveDuplicates.org does not upload, store, or send its contents to a server.

### Which Excel file formats are supported?

Only .xlsx workbooks are supported. Legacy .xls, macro-enabled .xlsm, OpenDocument .ods, and Apple Numbers files must be converted to a macro-free .xlsx file first.

### Can I remove duplicates using one or several columns?

Yes. Compare entire rows or select one or several columns. Multi-column comparisons always follow worksheet column order, regardless of the order in which you select them.

### What happens to headers, formulas, dates, and formatting?

The first row is treated as a header by default, and dates and values are compared by saved display text. If any row would be removed from a workbook containing formulas, the tool stops to avoid unsafe formula shifts. Advanced features such as styles, charts, validation, and named ranges are listed as risks and require confirmation before a rewrite.

### Does the tool change my original workbook?

No. The original file is never overwritten. The tool creates a separate download, and if no rows need removal it returns the original workbook bytes unchanged.

### Why can a password-protected or macro-enabled workbook not be opened?

Encrypted workbooks cannot be read safely in this local tool, and macro-enabled files can contain executable code that this tool does not preserve or run. Save a password-free, macro-free .xlsx copy before processing.

## Related

- [Remove duplicate lines from text lists and CSV](https://removeduplicates.org/)
- [Privacy](https://removeduplicates.org/privacy)
- [Source code (MIT)](https://github.com/suvadadepolo-blip/remove-duplicates)
