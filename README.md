# PDF Invoice Splitter

Split a combined invoice PDF into one PDF per invoice, automatically named by invoice number. Everything runs in your browser, so your documents are never uploaded to a server.

Upload one or more PDFs, review the proposed split, and download the results as a ZIP.

```
all-invoices.pdf (98 pages)   →   SSC-2026-1268.pdf
                                  MIP-2026-1261.pdf
                                  GRB-2026-1239.pdf
                                  …
```

## Features

- **Splits by invoice number.** The app reads the text on every page, finds the invoice number, and starts a new document whenever it changes.
- **Multi-page invoices.** Pages with no invoice number (for example page 2 of a long invoice) stay with the previous invoice.
- **Multiple PDFs at once.** Select or drag in several files; each is split on its own and the results appear in one list.
- **Duplicate removal.** If the same invoice number appears more than once, in different PDFs or again later in the same PDF, only the first copy is kept. Skipped duplicates are listed with their page numbers so nothing disappears silently.
- **Scanned PDFs.** OCR (Tesseract) runs automatically on pages that have no selectable text.
- **Review before you download.** Edit any filename, preview a single invoice, download one file, or download everything as a ZIP. Empty and clashing names are highlighted and can be fixed with one click.
- **Private.** Processing happens locally in the browser. No account, no watermark, no upload.

## Getting started

There is nothing to install or build. It is a static site made of three files.

The app uses ES modules, so it must be served over HTTP. Opening `index.html` directly from disk (`file://`) will not work.

```bash
# from the project folder
python -m http.server 8000
```

Then open <http://localhost:8000>.

An internet connection is needed: the PDF libraries load from the jsDelivr CDN, and OCR downloads a language model the first time it is used.

You can also host the folder on any static host, such as GitHub Pages, Netlify or an S3 bucket.

## How it works

1. **Upload** one or more PDFs.
2. The app extracts the text of each page and looks for an invoice number. If a page has no selectable text, OCR is used instead.
3. A new output document starts every time the invoice number changes.
4. **Review** the list, adjust filenames if needed, then download.

### What counts as an invoice number

The detector looks for the word `Invoice` or `Inv`, an optional `Number` / `No.` / `#`, an optional `:`, and then a value that contains at least one digit. For example:

| Page text | Detected |
|---|---|
| `Invoice No: 12345` | `12345` |
| `Invoice Number: SSC-2026-1268` | `SSC-2026-1268` |
| `Invoice # INV-2024-001` | `INV-2024-001` |
| `INV1001` | `1001` |
| `Tax Invoice (Original for Recipient)` | nothing (no number) |

If your invoices label the number differently (for example `Bill No` or `Document No`), the pattern in `presetPattern()` in `app.js` needs extending.

### Output filenames

Files are named `{invoice number}.pdf`. If two different invoice numbers would produce the same filename after cleaning, the second gets a `-2` suffix. Characters that are not allowed in Windows filenames are replaced.

When several PDFs are uploaded, the ZIP is named `invoices-split-and-renamed.zip`; for a single PDF it is `<original name>-split-and-renamed.zip`.

## Limitations

- Detection depends on the invoice number being labelled in the text. Unlabelled numbers will not be found.
- If no invoice number is found anywhere in a PDF, it is output as a single file.
- If a page also contains another reference that follows an "Invoice" label (such as an invoice date or purchase order), the wrong value can be picked up. Always glance at the review table before downloading.
- Large batches keep every uploaded PDF in browser memory at once. Very large files can be slow; split big batches into smaller ones.
- Each new upload replaces the previous set of files.
- OCR is slower than normal text extraction, and accuracy depends on scan quality.

## Project structure

```
index.html   Page markup
app.js       All application logic (ES module)
styles.css   Styling
```

There is no build step, package manager or test suite.

### Libraries (loaded from jsDelivr)

| Library | Used for |
|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) | Reading pages and extracting text |
| [pdf-lib](https://pdf-lib.js.org/) | Building the output PDFs |
| [JSZip](https://stuk.github.io/jszip/) | Creating the ZIP archive |
| [FileSaver.js](https://github.com/eligrey/FileSaver.js) | Saving files from the browser |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | OCR for scanned pages (loaded only when needed) |

## For developers

The app was originally a general-purpose splitter and was narrowed down to invoices. Rather than deleting the other features, they were commented out or hidden, so they can be restored:

- **Other split methods** (keyword, fixed page count, one file per page) and the "choose how to split" step are commented out in `index.html` and `app.js`.
- **Manual text-area selection and the other detection presets** (employee ID, name, account number, certificate, custom regex) still exist in the code. The settings step is hidden with the `hidden` class on `#configureSection` rather than removed. Removing that class shows the settings again.
- **Saved setups** (stored in the browser's `localStorage`) live in the hidden settings step.

Key points when changing the code:

- `state.sources` holds every uploaded PDF. The older single-document fields on `state` always point at the PDF currently being processed, switched with `useSource()`. Code that touches per-document state should run inside a `useSource()` call or read `group.source`.
- `analysePdf()` is the main pipeline: it analyses each source, removes duplicate invoice numbers, assigns filenames, and renders the review table.
- When you change `app.js` or `styles.css`, bump the `?v=` number on their tags in `index.html` so browsers do not keep a cached copy.

More detail is in [CLAUDE.md](CLAUDE.md).

## Privacy

Your PDFs are read and processed entirely inside your browser tab and are never sent anywhere. The page does download code libraries from a CDN, and OCR downloads a language model, but your document content is not transmitted.
