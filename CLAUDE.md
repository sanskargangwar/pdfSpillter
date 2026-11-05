# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PDF Split & Rename: a static, client-only web app that splits one large PDF into several PDFs and names each from its content (selected text regions, auto-detected IDs, keywords, fixed page counts, or one file per page). All processing happens in the browser; nothing is uploaded.

The whole app is three files: `index.html`, `app.js`, `styles.css`. There is no package.json, build step, bundler, linter, or test suite, and the directory is not a git repo.

## Running

`app.js` is loaded as `<script type="module">`, so opening `index.html` via `file://` will fail in most browsers. Serve the folder over HTTP, e.g. `python -m http.server 8000` and open `http://localhost:8000`. An internet connection is required because every dependency is loaded from the jsDelivr CDN.

`index.html` references `assets/favicon.svg`, `assets/social-preview.svg` and `manifest.webmanifest`, which are not in this directory (404s are expected locally).

## Architecture

**Dependencies are split across two loading mechanisms**, which matters when touching them:
- `pdfjs-dist` (rendering and text extraction) is ES-module-imported at the top of `app.js`, with its worker URL set manually. Versions are pinned in the URLs.
- `pdf-lib`, `JSZip` and `FileSaver` are plain `defer` script tags in `index.html` and are read from `window.PDFLib` / `window.JSZip` / `window.saveAs`. `waitForLibraries()` polls for them before a PDF is loaded.
- `tesseract.js` is lazy-loaded via `loadScript()` only when OCR is needed (`getOcrWorker()`); the worker is cached per language in `state.ocrWorker`.

**Two PDF libraries with distinct roles:** pdf.js (`state.pdfjsDoc`) is read-only and used for preview rendering, thumbnails and text extraction. pdf-lib (`state.pdfLibDoc`) is used only to build output files via `createGroupPdf()` (copy page indexes into a new document). Both are loaded from the same buffer in `handlePdfFile()`.

**Single global `state` object** in `app.js` holds the loaded file, docs, current page, drawn regions, the text cache and the computed `groups`. `elements` caches DOM nodes by ID. There is no framework; UI is re-rendered by setting `innerHTML` and re-attaching listeners (see `renderReview`, `renderRegionsList`). Anything interpolated into HTML must go through `escapeHtml()`.

**Multiple PDFs:** the upload input accepts several files. `handlePdfFiles()` loads each into `state.sources` (`{ file, buffer, pdfjsDoc, pdfLibDoc, pageCount, textCache }`; the old single-file `handlePdfFile()` is kept commented out). The legacy single-document fields (`state.file`, `pdfjsDoc`, `pdfLibDoc`, `pageCount`, `textCache`) are not the source of truth any more: they point at whichever source is being processed, switched with `useSource()`. `analysePdf()` loops over the sources, runs the per-document `analyse*` function on each, and tags every output group with `group.source`; `createGroupPdf()`, `filenameContext()` and the review table read `group.source` instead of the global state. Duplicate invoices are removed in `analysePdf()` via `removeDuplicateInvoices()`: after all sources are analysed, only the first group per normalised invoice number (case/whitespace-insensitive, across all files and within a file) is kept; the rest go to `state.duplicates` and are listed in `#duplicateInfo` by `renderDuplicates()`. Groups with no detected number (`unidentified`) are never treated as duplicates. Filename de-duplication (`-2` suffix) in `assignFilenames()` remains as a safety net for names that collide after templating. Filenames are de-duplicated across all sources, and the ZIP is named `invoices-split-and-renamed.zip` when more than one PDF was uploaded. Each upload replaces the previous set. Any new code that touches per-document state must either run inside a `useSource()` window or use `group.source`.

**Pipeline:** upload → `analysePdf()` (runs automatically at the end of `handlePdfFiles()`) → review table → download. The UI shows 2 steps (Upload, Review). The configure step (`#configureSection`) is kept in the DOM but hidden with the `hidden` class, because `app.js` reads its fields; its defaults are automatic detection, the "Invoice number" preset, carry-forward on, OCR on, filename template `{value}`. The progress panel was moved into the upload step so it remains visible. Remove `hidden` from `#configureSection` (and re-enable the commented-out `renderCurrentPage()` / `buildThumbnails()` calls in `handlePdfFile()`) to bring manual region selection back.
1. The "Choose how the PDF should be split" step is commented out in `index.html`, and `getSelectedMode()` is hardcoded to return `'smart'`, so splitting is always by text / ID changes. `analysePdf()` still dispatches on the mode to an `analyse*` function, but the `keyword` / `fixed` / `single` branches (`analyseKeyword`, `analyseFixed`, `analyseSingle`, their config blocks in the HTML, and their element IDs such as `keywordInput`) are intentionally left in place, commented out or unreachable. To restore them, uncomment the HTML blocks and the `app.js` lines marked as removed. Each `analyse*` function returns `groups`: `{ pages: number[], value, fields }`. Do not call `$()` on the removed IDs from live code paths; it returns `null`.
2. `analyseSmart()` has two sub-methods: drawn **regions** (text pulled by `textFromRegion()` from pdf.js text items) or **automatic** regex presets (`presetPattern()` / `matchPattern()`; the value is capture group 1). It starts a new group whenever the key value changes, with optional "carry forward" so blank continuation pages join the previous group.
3. `pageTextWithOcrFallback()` is the single text-extraction entry point; it falls back to Tesseract OCR (rendering the page, and cropping to the region when one is given) only if no selectable text was found and the OCR checkbox is on.
4. `assignFilenames()` applies the filename template (`{placeholder}` substitution in `applyTemplate()`, context built in `filenameContext()`), sanitises via `sanitiseFilename()` (Windows-reserved names and characters), and dedupes. The review table lets the user edit names; `filenameIssues()` / `autoFixNames()` handle empty and duplicate names, and ZIP download is disabled while issues exist.
5. `downloadZip()` / `downloadSingleGroup()` / `previewGroup()` generate PDFs on demand with `createGroupPdf()`.

**Region coordinates are stored normalised (0–1) relative to the page**, via `normaliseRect()` / `denormaliseRect()`, so they work across pages of different render sizes, at any canvas scale, and for saved templates. The pdf.js text items in `getPageTextData()` are computed at scale 1, and regions are denormalised against that viewport. The preview canvas (`pdfCanvas`) and an overlay canvas (`selectionCanvas`) are stacked; the overlay handles pointer-based drawing.

**Persistence:** saved "setups" (`currentConfig()` / `loadTemplate()`) are stored in `localStorage` under `pdfSplitRenameTemplatesV1`, capped at the last 20. They store settings and regions only, never the PDF. If you change the config shape, keep it backward compatible or bump the `version` field.

**UI state is driven by CSS classes** (`hidden`, `disabled-section`, `selected`), and `validateAnalyseButton()` must be called after any input change that could affect whether analysis can run.
