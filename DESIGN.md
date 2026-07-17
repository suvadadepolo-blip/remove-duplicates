# RemoveDuplicates.org design brief

## Direction

- Lane: aesthetic direction for a task-first utility.
- Page type: a repeated-use text-cleaning workspace with concise supporting guidance.
- Target user: anyone cleaning copied lists, exports, logs, names, keywords, IDs, URLs, or other line-based text.
- Visual thesis: a quiet sorting desk — cool paper, dark ink, one deep-teal action color, and restrained rust feedback for removed lines.
- Interaction thesis: the page should feel immediate and steady; feedback explains processing, copying, downloads, legal history, and mobile view changes without ornamental motion.

## References

1. The adjacent TextDiff.org project: reuse its proven tool-first information density, real legal URLs enhanced into an in-page dialog, local-processing trust language, and Worker-backed 404 convention. Do not reuse its brand, copy, or diff-specific visual identity.
2. CombinePDF: borrow the idea that a utility can keep the task intact when opening Terms or Privacy, while implementing the overlay with a native, accessible dialog and real fallback URLs.
3. Familiar text editors and command palettes: borrow compact labels, monospace work areas, predictable keyboard focus, and status feedback rather than dashboard decoration.

## Composition

- A compact header identifies the product and its local-processing promise.
- One short H1 and one supporting sentence lead directly into the tool.
- Desktop uses an equal Input / Cleaned text split; at narrow widths, Input / Result tabs keep each editor useful rather than squeezing both columns.
- Options, primary action, status, and live counts remain attached to the workspace so the user never has to hunt for the next step.
- Supporting explanation, privacy detail, and FAQ appear only after the complete tool.

## Visual system

- Palette: cool off-white page, white work surfaces, near-black green ink, deep teal actions, and rust for removal feedback.
- Typography: system sans for zero font requests and a native monospace stack inside editors and numeric readouts.
- Spacing: 4/8/12/16/24/32/48 rhythm with a 1,520px maximum workspace width.
- Material: hairline borders, small radii, almost no shadow, and no blur. A panel exists only where it is the actual editor or control surface.
- Motion: short opacity/color/position transitions for status and dialog entry only; all transitions are removed under `prefers-reduced-motion`.

## Product and accessibility constraints

- The complete job begins in the first desktop viewport, including editors, options, action, and live statistics.
- Browser runtime has no framework, external font, analytics, advertising, cookie, account, or text-upload dependency.
- Text and opened files remain in browser memory and may be processed in a Web Worker; they are not placed in the URL or persisted by the site.
- Meaning never relies on color alone. Labels and counts name every state.
- One H1, real labels, semantic fieldsets, visible focus, polite live regions, native dialog behavior, and 44px minimum pointer targets.
- Responsive floor: 320 CSS pixels. Long filenames, text, status messages, and footer links must wrap without horizontal overflow.

## Anti-patterns

- 3D, WebGL, canvas decoration, ornamental particles, or animation that delays typing.
- Oversized marketing hero that moves the tool below the fold.
- Generic SaaS feature cards, icon circles, pill soup, gradients, glass panels, or testimonial/logo filler.
- A two-column mobile editor squeezed below readable width.
- Muted focus, placeholder-only labels, hidden FAQ schema, or green/red-only meaning.
- Claims that Cloudflare receives no request metadata; the privacy copy distinguishes page-delivery data from the text being cleaned.

## Visual QA

- Desktop: 1920x993, 1440x900, and short 1280x720.
- Mobile: 390x844 and 320x800.
- Check first-viewport utility, mobile tab state, long lines, editor scrolling, option wrapping, file/drop affordances, live counts, focus order, dialog focus/history, text retention across legal views, reduced motion, and zero horizontal overflow.
- Browser QA runs through the registered OpenClaw preview. Static source checks alone are not visual acceptance.
