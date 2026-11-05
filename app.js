import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const qsa = (selector) => [...document.querySelectorAll(selector)];

const REGION_COLOURS = ['#B8962E', '#2f7d58', '#3f6f9f', '#c4621d', '#8a4fb0', '#b3374a'];
const TEMPLATE_STORAGE_KEY = 'pdfSplitRenameTemplatesV1';

const state = {
  file: null,
  originalBuffer: null,
  pdfjsDoc: null,
  pdfLibDoc: null,
  pageCount: 0,
  currentPage: 1,
  currentViewport: null,
  currentRenderScale: 1,
  regions: [],
  pendingRect: null,
  drawing: false,
  dragStart: null,
  draftRect: null,
  textCache: new Map(),
  groups: [],
  ocrWorker: null,
  ocrLanguage: null,
  thumbnailObserver: null,
  busy: false,
  // Multi-file upload: every loaded PDF lives in state.sources; the single-document fields above
  // (file, pdfjsDoc, pdfLibDoc, pageCount, textCache) always point at the source currently being processed.
  sources: [],
  loadWarnings: [],
  duplicates: [], // invoice groups skipped because the same invoice number was already found
  progress: { prefix: '', base: 0, span: 1 },
};

const elements = {
  pdfInput: $('pdfInput'),
  dropzone: $('dropzone'),
  fileSummary: $('fileSummary'),
  // methodSection: $('methodSection'), // step removed: always split by text / ID changes
  configureSection: $('configureSection'),
  reviewSection: $('reviewSection'),
  pdfCanvas: $('pdfCanvas'),
  selectionCanvas: $('selectionCanvas'),
  pdfViewer: $('pdfViewer'),
  viewerEmpty: $('viewerEmpty'),
  pageNumberInput: $('pageNumberInput'),
  pageCountLabel: $('pageCountLabel'),
  previousPageButton: $('previousPageButton'),
  nextPageButton: $('nextPageButton'),
  selectionForm: $('selectionForm'),
  regionNameInput: $('regionNameInput'),
  regionsList: $('regionsList'),
  splitKeySelect: $('splitKeySelect'),
  thumbnailStrip: $('thumbnailStrip'),
  analyseButton: $('analyseButton'),
  progressPanel: $('progressPanel'),
  progressText: $('progressText'),
  progressPercent: $('progressPercent'),
  progressBar: $('progressBar'),
  reviewTableBody: $('reviewTableBody'),
  reviewStats: $('reviewStats'),
  reviewWarnings: $('reviewWarnings'),
  downloadZipButton: $('downloadZipButton'),
  autoFixNamesButton: $('autoFixNamesButton'),
  suggestions: $('suggestions'),
  filenameTemplateInput: $('filenameTemplateInput'),
  placeholderHelp: $('placeholderHelp'),
};

function showNotice(message, type = 'info') {
  const notice = $('notice');
  notice.className = `notice notice-${type}`;
  notice.innerHTML = message;
  notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function humanFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function baseFileName(name) {
  return name.replace(/\.pdf$/i, '');
}

function slugKey(value) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char ? char.toUpperCase() : '');
  const first = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  return first || `field${state.regions.length + 1}`;
}

function sanitiseFilename(value) {
  let name = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
  if (!name) return '';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `file-${name}`;
  return name.slice(0, 180);
}

function normaliseCompare(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The split-method step was removed: splitting is always by text / ID changes ('smart').
function getSelectedMode() {
  // return document.querySelector('input[name="splitMode"]:checked')?.value || 'smart';
  return 'smart';
}

function getSmartMethod() {
  return document.querySelector('input[name="smartMethod"]:checked')?.value || 'region';
}

function defaultTemplateForMode(mode) {
  if (mode === 'fixed') return '{originalName}-{documentNumber}-pages-{startPage}-{endPage}';
  if (mode === 'single') return '{originalName}-page-{startPage}';
  if (mode === 'keyword') return '{match}-{documentNumber}';
  return '{value}';
}

/* Original multi-mode version (needs the removed method picker and keyword/fixed/single config blocks):
function updateModeUI(resetTemplate = false) {
  const mode = getSelectedMode();
  qsa('.method-option').forEach((label) => label.classList.toggle('selected', label.querySelector('input').checked));
  ['smart', 'keyword', 'fixed', 'single'].forEach((name) => $(`${name}Config`).classList.toggle('hidden', name !== mode));
  if (resetTemplate) elements.filenameTemplateInput.value = defaultTemplateForMode(mode);
  updatePlaceholderHelp();
  validateAnalyseButton();
}
*/
function updateModeUI() {
  updatePlaceholderHelp();
  validateAnalyseButton();
}

function updateSmartMethodUI() {
  const method = getSmartMethod();
  $('regionConfig').classList.toggle('hidden', method !== 'region');
  $('automaticConfig').classList.toggle('hidden', method !== 'automatic');
  updatePlaceholderHelp();
  validateAnalyseButton();
}

function updatePlaceholderHelp() {
  const mode = getSelectedMode();
  const base = ['{startPage}', '{endPage}', '{pageCount}', '{documentNumber}', '{originalName}', '{date}'];
  if (mode === 'keyword') base.unshift('{match}');
  if (mode === 'smart') {
    base.unshift('{value}');
    if (getSmartMethod() === 'region') state.regions.forEach((region) => base.unshift(`{${region.key}}`));
  }
  elements.placeholderHelp.innerHTML = `Available: ${[...new Set(base)].map((item) => `<code>${escapeHtml(item)}</code>`).join(', ')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function waitForLibraries() {
  const started = Date.now();
  while ((!window.PDFLib || !window.JSZip || !window.saveAs) && Date.now() - started < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!window.PDFLib || !window.JSZip || !window.saveAs) throw new Error('Required PDF libraries could not be loaded. Check your internet connection and reload the page.');
}

function isPdfFile(file) {
  return Boolean(file) && (String(file.type || '').includes('pdf') || file.name.toLowerCase().endsWith('.pdf'));
}

// Point the single-document state fields at one of the loaded PDFs so the existing per-document code can be reused.
function useSource(source) {
  state.file = source.file;
  state.originalBuffer = source.buffer;
  state.pdfjsDoc = source.pdfjsDoc;
  state.pdfLibDoc = source.pdfLibDoc;
  state.pageCount = source.pageCount;
  state.textCache = source.textCache;
}

async function handlePdfFiles(fileList) {
  const picked = [...(fileList || [])];
  const files = picked.filter(isPdfFile);
  if (!files.length) {
    showNotice('<strong>Please choose at least one PDF file.</strong>', 'danger');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  let loaded = false;
  try {
    showProgress(true, 'Loading PDFs…', 2);
    await waitForLibraries();
    const sources = [];
    const warnings = [];
    if (picked.length > files.length) warnings.push(`${picked.length - files.length} non-PDF file${picked.length - files.length === 1 ? '' : 's'} ignored`);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setProgress(`Loading ${file.name} (${index + 1} of ${files.length})…`, index / files.length * 100);
      try {
        const buffer = await file.arrayBuffer();
        const pdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
        const pdfLibDoc = await window.PDFLib.PDFDocument.load(buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
        sources.push({ file, buffer, pdfjsDoc, pdfLibDoc, pageCount: pdfjsDoc.numPages, textCache: new Map() });
      } catch (error) {
        console.error('Could not open', file.name, error);
        warnings.push(`${escapeHtml(file.name)} could not be opened`);
      }
    }
    if (!sources.length) throw new Error('None of the selected files could be opened. They may be encrypted, damaged or unsupported.');

    state.sources = sources;
    state.loadWarnings = warnings;
    useSource(sources[0]);
    state.currentPage = 1;
    state.regions = [];
    state.groups = [];
    state.pendingRect = null;

    const totalPages = sources.reduce((sum, source) => sum + source.pageCount, 0);
    const totalSize = sources.reduce((sum, source) => sum + source.file.size, 0);
    elements.pageCountLabel.textContent = state.pageCount;
    elements.pageNumberInput.max = state.pageCount;
    elements.pageNumberInput.value = '1';
    elements.fileSummary.innerHTML = sources.length === 1
      ? `<div><strong>${escapeHtml(sources[0].file.name)}</strong><small>${humanFileSize(totalSize)} • ${totalPages} page${totalPages === 1 ? '' : 's'}</small></div><span>✅ Ready</span>`
      : `<div><strong>${sources.length} PDF files</strong><small>${humanFileSize(totalSize)} • ${totalPages} pages in total</small>${sources.map((source) => `<small>${escapeHtml(source.file.name)} — ${source.pageCount} page${source.pageCount === 1 ? '' : 's'}</small>`).join('')}</div><span>✅ Ready</span>`;
    elements.fileSummary.classList.remove('hidden');
    elements.configureSection.classList.remove('disabled-section');
    elements.viewerEmpty.classList.add('hidden');
    elements.reviewSection.classList.add('disabled-section');
    clearReview();
    renderRegionsList();
    validateAnalyseButton();
    showNotice(`<strong>${sources.length === 1 ? escapeHtml(sources[0].file.name) : `${sources.length} PDF files`}</strong> loaded. Splitting ${totalPages} page${totalPages === 1 ? '' : 's'} by invoice number…`, 'info');
    loaded = true;
  } catch (error) {
    console.error(error);
    showNotice(`<strong>Could not open the PDF${files.length === 1 ? '' : 's'}.</strong> ${escapeHtml(error.message || 'The file may be encrypted, damaged or unsupported.')}`, 'danger');
  } finally {
    state.busy = false;
    showProgress(false);
    elements.pdfInput.value = ''; // lets the same selection be chosen again
  }
  // Auto-run the invoice-number split once the PDFs have loaded (runs after busy is cleared so analysePdf() is not blocked).
  if (loaded) {
    validateAnalyseButton();
    await analysePdf();
  }
}

/* Original single-file version, superseded by handlePdfFiles() above:
async function handlePdfFile(file) {
  if (!file || (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
    showNotice('<strong>Please choose a PDF file.</strong>', 'danger');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  let loaded = false;
  try {
    showProgress(true, 'Loading PDF…', 5);
    await waitForLibraries();
    const buffer = await file.arrayBuffer();
    const pdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
    const pdfLibDoc = await window.PDFLib.PDFDocument.load(buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });

    state.file = file;
    state.originalBuffer = buffer;
    state.pdfjsDoc = pdfjsDoc;
    state.pdfLibDoc = pdfLibDoc;
    state.pageCount = pdfjsDoc.numPages;
    state.currentPage = 1;
    state.regions = [];
    state.groups = [];
    state.textCache.clear();
    state.pendingRect = null;

    elements.pageCountLabel.textContent = state.pageCount;
    elements.pageNumberInput.max = state.pageCount;
    elements.pageNumberInput.value = '1';
    elements.fileSummary.innerHTML = `<div><strong>${escapeHtml(file.name)}</strong><small>${humanFileSize(file.size)} • ${state.pageCount} page${state.pageCount === 1 ? '' : 's'}</small></div><span>✅ Ready</span>`;
    elements.fileSummary.classList.remove('hidden');
    // elements.methodSection.classList.remove('disabled-section');
    elements.configureSection.classList.remove('disabled-section');
    elements.viewerEmpty.classList.add('hidden');
    elements.reviewSection.classList.add('disabled-section');
    clearReview();
    renderRegionsList();
    // The page preview / thumbnails live in the hidden configure step, so they are not rendered any more.
    // buildThumbnails();
    // await renderCurrentPage();
    validateAnalyseButton();
    // showNotice(`<strong>${escapeHtml(file.name)}</strong> is ready. Choose how you want to split its ${state.pageCount} pages.`, 'success');
    showNotice(`<strong>${escapeHtml(file.name)}</strong> loaded. Splitting its ${state.pageCount} pages by invoice number…`, 'info');
    loaded = true;
  } catch (error) {
    console.error(error);
    showNotice(`<strong>Could not open that PDF.</strong> ${escapeHtml(error.message || 'The file may be encrypted, damaged or unsupported.')}`, 'danger');
  } finally {
    state.busy = false;
    showProgress(false);
  }
  // Auto-run the invoice-number split once the PDF has loaded (runs after busy is cleared so analysePdf() is not blocked).
  if (loaded) {
    validateAnalyseButton();
    await analysePdf();
  }
}
*/

async function renderCurrentPage() {
  if (!state.pdfjsDoc) return;
  const pageNumber = Math.min(Math.max(1, state.currentPage), state.pageCount);
  state.currentPage = pageNumber;
  elements.pageNumberInput.value = pageNumber;
  elements.previousPageButton.disabled = pageNumber <= 1;
  elements.nextPageButton.disabled = pageNumber >= state.pageCount;
  qsa('.thumbnail').forEach((thumb) => thumb.classList.toggle('active', Number(thumb.dataset.page) === pageNumber));

  const page = await state.pdfjsDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const available = Math.max(320, elements.pdfViewer.clientWidth - 24);
  const scale = Math.min(2, Math.max(.65, available / baseViewport.width));
  const viewport = page.getViewport({ scale });
  state.currentViewport = viewport;
  state.currentRenderScale = scale;

  const canvas = elements.pdfCanvas;
  const overlay = elements.selectionCanvas;
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.width = canvas.style.width;
  overlay.style.height = canvas.style.height;

  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  positionOverlay();
  drawOverlay();
}

function positionOverlay() {
  const canvas = elements.pdfCanvas;
  const overlay = elements.selectionCanvas;
  overlay.style.left = `${canvas.offsetLeft}px`;
  overlay.style.top = `${canvas.offsetTop}px`;
}

function drawOverlay() {
  const canvas = elements.selectionCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.regions.forEach((region, index) => {
    const rect = denormaliseRect(region.rect, canvas.width, canvas.height);
    ctx.fillStyle = `${REGION_COLOURS[index % REGION_COLOURS.length]}22`;
    ctx.strokeStyle = REGION_COLOURS[index % REGION_COLOURS.length];
    ctx.lineWidth = 2;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = REGION_COLOURS[index % REGION_COLOURS.length];
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(region.key, rect.x + 5, Math.max(14, rect.y - 5));
  });
  const draft = state.draftRect || state.pendingRect;
  if (draft) {
    const rect = denormaliseRect(draft, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(28,28,28,.08)';
    ctx.strokeStyle = '#1C1C1C';
    ctx.setLineDash([7, 4]);
    ctx.lineWidth = 2;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
  }
}

function normaliseRect(rect, width, height) {
  return { x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height };
}

function denormaliseRect(rect, width, height) {
  return { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height };
}

function pointerPosition(event) {
  const rect = elements.selectionCanvas.getBoundingClientRect();
  const scaleX = elements.selectionCanvas.width / rect.width;
  const scaleY = elements.selectionCanvas.height / rect.height;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

function handlePointerDown(event) {
  if (!state.pdfjsDoc || getSelectedMode() !== 'smart' || getSmartMethod() !== 'region') return;
  elements.selectionCanvas.setPointerCapture(event.pointerId);
  state.drawing = true;
  state.dragStart = pointerPosition(event);
  state.pendingRect = null;
  elements.selectionForm.classList.add('hidden');
}

function handlePointerMove(event) {
  if (!state.drawing) return;
  const pos = pointerPosition(event);
  const x = Math.min(state.dragStart.x, pos.x);
  const y = Math.min(state.dragStart.y, pos.y);
  const width = Math.abs(pos.x - state.dragStart.x);
  const height = Math.abs(pos.y - state.dragStart.y);
  state.draftRect = normaliseRect({ x, y, width, height }, elements.selectionCanvas.width, elements.selectionCanvas.height);
  drawOverlay();
}

function handlePointerUp(event) {
  if (!state.drawing) return;
  state.drawing = false;
  const pos = pointerPosition(event);
  const x = Math.min(state.dragStart.x, pos.x);
  const y = Math.min(state.dragStart.y, pos.y);
  const width = Math.abs(pos.x - state.dragStart.x);
  const height = Math.abs(pos.y - state.dragStart.y);
  state.draftRect = null;
  if (width < 8 || height < 8) { drawOverlay(); return; }
  state.pendingRect = normaliseRect({ x, y, width, height }, elements.selectionCanvas.width, elements.selectionCanvas.height);
  elements.regionNameInput.value = `field${state.regions.length + 1}`;
  elements.selectionForm.classList.remove('hidden');
  elements.regionNameInput.focus();
  drawOverlay();
}

function addPendingRegion() {
  if (!state.pendingRect) return;
  let key = slugKey(elements.regionNameInput.value);
  const existing = new Set(state.regions.map((region) => region.key));
  let suffix = 2;
  const original = key;
  while (existing.has(key)) key = `${original}${suffix++}`;
  state.regions.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, key, rect: state.pendingRect, referencePage: state.currentPage });
  state.pendingRect = null;
  elements.selectionForm.classList.add('hidden');
  renderRegionsList();
  drawOverlay();
  updatePlaceholderHelp();
  validateAnalyseButton();
}

function cancelPendingRegion() {
  state.pendingRect = null;
  elements.selectionForm.classList.add('hidden');
  drawOverlay();
}

function renderRegionsList() {
  if (!state.regions.length) {
    elements.regionsList.innerHTML = '<p class="empty-state">No areas selected yet.</p>';
    elements.splitKeySelect.innerHTML = '<option value="">Select an area first</option>';
    return;
  }
  elements.regionsList.innerHTML = state.regions.map((region, index) => `
    <div class="region-item">
      <span class="region-color" style="background:${REGION_COLOURS[index % REGION_COLOURS.length]}"></span>
      <span><strong>{${escapeHtml(region.key)}}</strong><small>Selected on page ${region.referencePage}</small></span>
      <button class="region-remove" data-remove-region="${escapeHtml(region.id)}" type="button" aria-label="Remove ${escapeHtml(region.key)}">×</button>
    </div>`).join('');
  const current = elements.splitKeySelect.value;
  elements.splitKeySelect.innerHTML = state.regions.map((region) => `<option value="${escapeHtml(region.key)}">${escapeHtml(region.key)}</option>`).join('');
  if (state.regions.some((region) => region.key === current)) elements.splitKeySelect.value = current;
  elements.regionsList.querySelectorAll('[data-remove-region]').forEach((button) => button.addEventListener('click', () => {
    state.regions = state.regions.filter((region) => region.id !== button.dataset.removeRegion);
    renderRegionsList(); drawOverlay(); updatePlaceholderHelp(); validateAnalyseButton();
  }));
}

function buildThumbnails() {
  elements.thumbnailStrip.innerHTML = '';
  state.thumbnailObserver?.disconnect();
  state.thumbnailObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const canvas = entry.target.querySelector('canvas');
        if (!canvas.dataset.rendered) renderThumbnail(Number(entry.target.dataset.page), canvas);
        state.thumbnailObserver.unobserve(entry.target);
      }
    });
  }, { root: elements.thumbnailStrip, rootMargin: '250px' });

  for (let page = 1; page <= state.pageCount; page += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thumbnail${page === 1 ? ' active' : ''}`;
    button.dataset.page = page;
    button.innerHTML = `<canvas width="78" height="112" aria-hidden="true"></canvas><span>Page ${page}</span>`;
    button.addEventListener('click', async () => { state.currentPage = page; await renderCurrentPage(); });
    elements.thumbnailStrip.appendChild(button);
    state.thumbnailObserver.observe(button);
  }
}

async function renderThumbnail(pageNumber, canvas) {
  try {
    const page = await state.pdfjsDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: .18 });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    canvas.dataset.rendered = 'true';
  } catch (error) {
    console.warn('Thumbnail failed', pageNumber, error);
  }
}

async function getPageTextData(pageNumber) {
  if (state.textCache.has(pageNumber)) return state.textCache.get(pageNumber);
  const page = await state.pdfjsDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.filter((item) => 'str' in item && item.str.trim()).map((item) => {
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const height = Math.max(1, Math.hypot(tx[2], tx[3]));
    const width = Math.max(1, Number(item.width || 0) * viewport.scale);
    return { text: item.str, x: tx[4], y: tx[5] - height, width, height };
  });
  const text = items.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
  const data = { page, viewport, items, text };
  state.textCache.set(pageNumber, data);
  return data;
}

function textFromRegion(data, normalRect) {
  const rect = denormaliseRect(normalRect, data.viewport.width, data.viewport.height);
  const chosen = data.items.filter((item) => {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
  });
  chosen.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) < 5) return a.x - b.x;
    return yDiff;
  });
  return chosen.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.Tesseract) resolve();
      else existing.addEventListener('load', resolve, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not download the OCR engine.'));
    document.head.appendChild(script);
  });
}

async function getOcrWorker() {
  const language = $('ocrLanguageSelect').value;
  if (state.ocrWorker && state.ocrLanguage === language) return state.ocrWorker;
  if (state.ocrWorker) await state.ocrWorker.terminate();
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js');
  setProgress('Loading OCR language model…', 2);
  state.ocrWorker = await window.Tesseract.createWorker(language, undefined, {
    logger: (message) => {
      if (typeof message.progress === 'number') {
        const value = Math.round(message.progress * 100);
        elements.progressText.textContent = `OCR: ${message.status || 'working'}…`;
        elements.progressPercent.textContent = `${value}%`;
        elements.progressBar.style.width = `${value}%`;
      }
    },
  });
  state.ocrLanguage = language;
  return state.ocrWorker;
}

async function renderPageForOcr(pageNumber, normalRect = null) {
  const page = await state.pdfjsDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, Math.max(1.6, 1800 / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  if (!normalRect) return canvas;
  const rect = denormaliseRect(normalRect, canvas.width, canvas.height);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.floor(rect.width));
  crop.height = Math.max(1, Math.floor(rect.height));
  crop.getContext('2d', { alpha: false }).drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, crop.width, crop.height);
  return crop;
}

async function ocrPage(pageNumber, normalRect = null) {
  const worker = await getOcrWorker();
  const canvas = await renderPageForOcr(pageNumber, normalRect);
  const result = await worker.recognize(canvas);
  return String(result.data?.text || '').replace(/\s+/g, ' ').trim();
}

function presetPattern(preset, custom) {
  const patterns = {
    // Old pattern: matched "Inv" inside the word "Invoice" and captured "oice", and accepted words with no digits.
    // invoice: /(?:invoice|inv)\s*(?:number|no\.?|#)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9_\-/]{2,})/i,
    // The label must be a whole word ("INV1001" and "INV-1001" still work) and the value must contain at least one digit.
    invoice: /\b(?:invoice|inv)(?![a-z])\s*(?:number|no\.?|#)?\s*[:#.-]?\s*((?=[A-Z0-9_\-/]*\d)[A-Z0-9][A-Z0-9_\-/]{2,})/i,
    employeeId: /(?:employee|staff|payroll)\s*(?:id|number|no\.?|#)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9_\-/]{2,})/i,
    employeeName: /(?:employee\s*name|staff\s*name|recipient|name)\s*[:#.-]?\s*([A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+){1,4})/i,
    account: /(?:account|customer|client)\s*(?:number|no\.?|id|#)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9_\-/]{2,})/i,
    certificate: /(?:awarded\s+to|presented\s+to|certif(?:y|ies)\s+that)\s*[:#.-]?\s*([A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+){1,4})/i,
  };
  if (preset === 'custom') {
    if (!custom.trim()) throw new Error('Enter a custom regular expression. Put the value you want inside the first pair of parentheses.');
    return new RegExp(custom, 'i');
  }
  return patterns[preset];
}

function matchPattern(text, regex) {
  regex.lastIndex = 0;
  const match = regex.exec(text);
  return match ? String(match[1] || match.groups?.value || match[0]).trim() : '';
}

async function findLikelyIds() {
  if (!state.pdfjsDoc) return;
  elements.suggestions.classList.remove('hidden');
  elements.suggestions.innerHTML = '<span class="empty-state">Scanning this page…</span>';
  try {
    const { text } = await getPageTextData(state.currentPage);
    const candidates = [];
    ['invoice', 'employeeId', 'employeeName', 'account', 'certificate'].forEach((preset) => {
      const value = matchPattern(text, presetPattern(preset, ''));
      if (value && !candidates.some((item) => item.value === value)) candidates.push({ preset, value });
    });
    const generic = text.match(/\b[A-Z]{1,5}[-_/]?\d{3,12}\b/g) || [];
    generic.slice(0, 8).forEach((value) => {
      if (!candidates.some((item) => item.value === value)) candidates.push({ preset: 'possible ID', value });
    });
    elements.suggestions.innerHTML = candidates.length
      ? `<strong>Possible values on page ${state.currentPage}:</strong>${candidates.map((item) => `<button type="button" class="suggestion-chip" title="${escapeHtml(item.preset)}">${escapeHtml(item.value)}</button>`).join('')}`
      : '<span class="empty-state">No common invoice, employee or account pattern was found. Draw a box around the value instead.</span>';
  } catch (error) {
    elements.suggestions.innerHTML = `<span class="empty-state">${escapeHtml(error.message)}</span>`;
  }
}

function validateAnalyseButton() {
  if (!state.pdfjsDoc || state.busy) { elements.analyseButton.disabled = true; return; }
  const mode = getSelectedMode();
  let valid = true;
  if (mode === 'smart' && getSmartMethod() === 'region') valid = state.regions.length > 0 && Boolean(elements.splitKeySelect.value);
  if (mode === 'smart' && getSmartMethod() === 'automatic') valid = $('autoPresetSelect').value !== 'custom' || Boolean($('customRegexInput').value.trim());
  if (mode === 'keyword') valid = Boolean($('keywordInput').value.trim());
  if (mode === 'fixed') valid = Number($('fixedPageCountInput').value) >= 1;
  valid = valid && Boolean(elements.filenameTemplateInput.value.trim());
  elements.analyseButton.disabled = !valid;
}

function showProgress(show, text = 'Working…', percent = 0) {
  elements.progressPanel.classList.toggle('hidden', !show);
  if (show) setProgress(text, percent);
}

function setProgress(text, percent) {
  elements.progressText.textContent = text;
  elements.progressPercent.textContent = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function pageTextWithOcrFallback(pageNumber, rect = null) {
  const data = await getPageTextData(pageNumber);
  let text = rect ? textFromRegion(data, rect) : data.text;
  if (!text && $('ocrCheckbox').checked) text = await ocrPage(pageNumber, rect);
  return text;
}

async function analysePdf() {
  if (state.busy || elements.analyseButton.disabled) return;
  state.busy = true;
  validateAnalyseButton();
  elements.reviewSection.classList.add('disabled-section');
  elements.analyseButton.textContent = 'Analysing…';
  showProgress(true, 'Preparing analysis…', 0);
  try {
    const mode = getSelectedMode();
    /* Original single-document version:
    let groups;
    if (mode === 'smart') groups = await analyseSmart();
    else if (mode === 'keyword') groups = await analyseKeyword();
    else if (mode === 'fixed') groups = analyseFixed();
    else groups = analyseSingle();
    */
    // Split every uploaded PDF in turn and tag each output group with the PDF it came from.
    const sources = state.sources.length
      ? state.sources
      : [{ file: state.file, buffer: state.originalBuffer, pdfjsDoc: state.pdfjsDoc, pdfLibDoc: state.pdfLibDoc, pageCount: state.pageCount, textCache: state.textCache }];
    const groups = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      useSource(source);
      state.progress = { prefix: sources.length > 1 ? `File ${index + 1} of ${sources.length}: ` : '', base: index / sources.length * 100, span: 1 / sources.length };
      let found;
      if (mode === 'smart') found = await analyseSmart();
      else if (mode === 'keyword') found = await analyseKeyword();
      else if (mode === 'fixed') found = analyseFixed();
      else found = analyseSingle();
      found.forEach((group) => {
        group.source = source;
        // Pages with no detectable number would all be called "Page 1"; keep them apart per file.
        if (sources.length > 1 && group.unidentified) group.value = `${baseFileName(source.file.name)} - ${group.value}`;
        groups.push(group);
      });
    }

    // Same invoice number found more than once (in another PDF, or again later in the same PDF): keep the first only.
    const { kept, duplicates } = removeDuplicateInvoices(groups);
    state.duplicates = duplicates;

    // if (!groups.length) throw new Error('No output documents could be created with the current settings.');
    // state.groups = assignFilenames(groups);
    if (!kept.length) throw new Error('No output documents could be created with the current settings.');
    state.groups = assignFilenames(kept);
    renderReview();
    elements.reviewSection.classList.remove('disabled-section');
    elements.reviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // showNotice(`<strong>Split plan ready:</strong> ${state.groups.length} PDF file${state.groups.length === 1 ? '' : 's'} will be created. Review the filenames below.`, 'success');
    const skipped = state.loadWarnings.length ? `<br><small>Note: ${state.loadWarnings.join('; ')}.</small>` : '';
    showNotice(`<strong>Split plan ready:</strong> ${state.groups.length} PDF file${state.groups.length === 1 ? '' : 's'} will be created${sources.length > 1 ? ` from ${sources.length} uploaded PDFs` : ''}. Review the filenames below.${state.duplicates.length ? `<br><small>${state.duplicates.length} duplicate invoice${state.duplicates.length === 1 ? '' : 's'} skipped (see the list below).</small>` : ''}${skipped}`, 'success');
  } catch (error) {
    console.error(error);
    showNotice(`<strong>Analysis stopped.</strong> ${escapeHtml(error.message || 'Please check your settings and try again.')}`, 'danger');
  } finally {
    if (state.sources.length) useSource(state.sources[0]);
    state.progress = { prefix: '', base: 0, span: 1 };
    state.busy = false;
    elements.analyseButton.textContent = 'Analyse PDF and create split plan';
    showProgress(false);
    validateAnalyseButton();
  }
}

async function analyseSmart() {
  const method = getSmartMethod();
  const rows = [];
  let regex;
  if (method === 'automatic') regex = presetPattern($('autoPresetSelect').value, $('customRegexInput').value);

  for (let page = 1; page <= state.pageCount; page += 1) {
    // setProgress(`Reading page ${page} of ${state.pageCount}…`, (page - 1) / state.pageCount * 100);
    setProgress(`${state.progress.prefix}Reading page ${page} of ${state.pageCount}…`, state.progress.base + (page - 1) / state.pageCount * 100 * state.progress.span);
    const fields = {};
    let keyValue = '';
    if (method === 'region') {
      for (const region of state.regions) fields[region.key] = await pageTextWithOcrFallback(page, region.rect);
      keyValue = fields[elements.splitKeySelect.value] || '';
    } else {
      const text = await pageTextWithOcrFallback(page);
      keyValue = matchPattern(text, regex);
      fields.value = keyValue;
    }
    rows.push({ page, keyValue: keyValue.trim(), fields });
  }

  const carry = method === 'region' ? $('carryForwardCheckbox').checked : $('autoCarryForwardCheckbox').checked;
  const groups = [];
  let current = null;
  rows.forEach((row) => {
    const key = normaliseCompare(row.keyValue);
    if (row.keyValue && (!current || normaliseCompare(current.value) !== key)) {
      current = { pages: [row.page], value: row.keyValue, fields: { ...row.fields } };
      groups.push(current);
    } else if (current && (carry || key)) {
      current.pages.push(row.page);
      Object.entries(row.fields).forEach(([field, value]) => { if (!current.fields[field] && value) current.fields[field] = value; });
    } else {
      current = { pages: [row.page], value: row.keyValue || `Page ${row.page}`, fields: { ...row.fields }, unidentified: !row.keyValue };
      groups.push(current);
    }
  });
  return groups;
}

async function analyseKeyword() {
  const query = $('keywordInput').value.trim();
  const type = $('keywordTypeSelect').value;
  const flags = $('caseSensitiveCheckbox').checked ? 'g' : 'gi';
  let regex;
  try { regex = type === 'regex' ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
  catch { throw new Error('The keyword regular expression is not valid.'); }
  const groups = [];
  let current = null;
  for (let page = 1; page <= state.pageCount; page += 1) {
    setProgress(`Searching page ${page} of ${state.pageCount}…`, (page - 1) / state.pageCount * 100);
    const text = await pageTextWithOcrFallback(page);
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (!current || match) {
      const detectedMatch = match?.[1] || match?.[0] || '';
      const filenameMatch = $('firstMatchValueCheckbox').checked
        ? (detectedMatch || `document-${groups.length + 1}`)
        : (query || `document-${groups.length + 1}`);
      current = {
        pages: [page],
        value: detectedMatch || `Document ${groups.length + 1}`,
        fields: { match: filenameMatch },
      };
      groups.push(current);
    } else current.pages.push(page);
  }
  return groups;
}

function analyseFixed() {
  const count = Math.max(1, Number($('fixedPageCountInput').value));
  const groups = [];
  for (let start = 1; start <= state.pageCount; start += count) {
    const pages = [];
    for (let page = start; page < Math.min(start + count, state.pageCount + 1); page += 1) pages.push(page);
    groups.push({ pages, value: `Document ${groups.length + 1}`, fields: {} });
  }
  return groups;
}

function analyseSingle() {
  return Array.from({ length: state.pageCount }, (_, index) => ({ pages: [index + 1], value: `Page ${index + 1}`, fields: {} }));
}

function filenameContext(group, index) {
  const startPage = group.pages[0];
  const endPage = group.pages[group.pages.length - 1];
  return {
    ...group.fields,
    value: group.value,
    match: group.fields?.match || group.value,
    startPage,
    endPage,
    pageCount: group.pages.length,
    documentNumber: index + 1,
    // originalName: baseFileName(state.file.name),
    originalName: baseFileName((group.source?.file || state.file).name),
    date: new Date().toISOString().slice(0, 10),
  };
}

function applyTemplate(template, context) {
  return template.replace(/\{([^}]+)\}/g, (_, key) => context[key] ?? '');
}

function assignFilenames(groups) {
  const template = elements.filenameTemplateInput.value.trim();
  const counts = new Map();
  return groups.map((group, index) => {
    const suggested = sanitiseFilename(applyTemplate(template, filenameContext(group, index))) || `document-${index + 1}`;
    const key = suggested.toLowerCase();
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    return { ...group, filename: count === 1 ? `${suggested}.pdf` : `${suggested}-${count}.pdf`, originalSuggested: suggested, hadDuplicate: count > 1 };
  });
}

function pageRangeLabel(group) {
  return group.pages.length === 1 ? `page ${group.pages[0]}` : `pages ${group.pages[0]}–${group.pages[group.pages.length - 1]}`;
}

// Keep only the first group for each detected invoice number. Groups with no detected number are never treated as duplicates.
function removeDuplicateInvoices(groups) {
  const firstByNumber = new Map();
  const kept = [];
  const duplicates = [];
  groups.forEach((group) => {
    const key = group.unidentified ? '' : normaliseCompare(group.value);
    if (key && firstByNumber.has(key)) duplicates.push({ group, firstGroup: firstByNumber.get(key) });
    else {
      if (key) firstByNumber.set(key, group);
      kept.push(group);
    }
  });
  return { kept, duplicates };
}

function renderDuplicates() {
  const box = $('duplicateInfo');
  if (!box) return;
  const list = state.duplicates;
  if (!list.length) { box.innerHTML = ''; return; }
  const shown = list.slice(0, 20).map(({ group, firstGroup }) => `<li><strong>${escapeHtml(group.value)}</strong>: ${pageRangeLabel(group)} of ${escapeHtml(group.source?.file.name || 'the PDF')} <em>(already kept from ${pageRangeLabel(firstGroup)} of ${escapeHtml(firstGroup.source?.file.name || 'the PDF')})</em></li>`).join('');
  box.innerHTML = `<div class="notice notice-warning"><strong>${list.length} duplicate invoice${list.length === 1 ? '' : 's'} skipped.</strong> Only the first copy of each invoice number is kept:<ul class="duplicate-list">${shown}${list.length > 20 ? `<li>…and ${list.length - 20} more</li>` : ''}</ul></div>`;
}

function clearReview() {
  state.groups = [];
  state.duplicates = [];
  if ($('duplicateInfo')) $('duplicateInfo').innerHTML = '';
  elements.reviewTableBody.innerHTML = '<tr><td colspan="5" class="empty-table">Analyse a PDF to see the split plan.</td></tr>';
  elements.reviewStats.innerHTML = '';
  elements.reviewWarnings.innerHTML = '';
  elements.downloadZipButton.disabled = true;
  elements.autoFixNamesButton.disabled = true;
}

function filenameIssues() {
  const seen = new Map();
  const issues = [];
  state.groups.forEach((group, index) => {
    const clean = sanitiseFilename(group.filename.replace(/\.pdf$/i, ''));
    if (!clean) issues.push({ index, type: 'empty' });
    const key = `${clean}.pdf`.toLowerCase();
    if (seen.has(key)) { issues.push({ index, type: 'duplicate' }); issues.push({ index: seen.get(key), type: 'duplicate' }); }
    else seen.set(key, index);
  });
  return issues;
}

function renderReview() {
  elements.reviewTableBody.innerHTML = state.groups.map((group, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${group.pages.length === 1 ? group.pages[0] : `${group.pages[0]}–${group.pages[group.pages.length - 1]}`} <small>(${group.pages.length})</small>${state.sources.length > 1 && group.source ? `<br><small class="source-name" title="${escapeHtml(group.source.file.name)}">${escapeHtml(group.source.file.name)}</small>` : ''}</td>
      <td><div class="detected-value" title="${escapeHtml(group.value)}">${escapeHtml(group.value || 'Not detected')}</div></td>
      <td><input data-filename-index="${index}" type="text" value="${escapeHtml(group.filename)}" aria-label="Filename for document ${index + 1}" /></td>
      <td><button data-preview-index="${index}" class="button button-small button-ghost" type="button">Open</button> <button data-download-index="${index}" class="button button-small button-secondary" type="button">Download</button></td>
    </tr>`).join('');
  elements.reviewTableBody.querySelectorAll('[data-filename-index]').forEach((input) => input.addEventListener('input', () => {
    state.groups[Number(input.dataset.filenameIndex)].filename = input.value;
    updateReviewValidation();
  }));
  elements.reviewTableBody.querySelectorAll('[data-preview-index]').forEach((button) => button.addEventListener('click', () => previewGroup(Number(button.dataset.previewIndex))));
  elements.reviewTableBody.querySelectorAll('[data-download-index]').forEach((button) => button.addEventListener('click', () => downloadSingleGroup(Number(button.dataset.downloadIndex))));
  // elements.reviewStats.innerHTML = `<span>${state.groups.length} files</span><span>${state.pageCount} pages</span><span>${state.groups.filter((g) => g.pages.length > 1).length} multi-page files</span>`;
  const totalPages = state.sources.length ? state.sources.reduce((sum, source) => sum + source.pageCount, 0) : state.pageCount;
  elements.reviewStats.innerHTML = `${state.sources.length > 1 ? `<span>${state.sources.length} uploaded PDFs</span>` : ''}<span>${state.groups.length} files</span><span>${totalPages} pages</span><span>${state.groups.filter((g) => g.pages.length > 1).length} multi-page files</span>`;
  elements.downloadZipButton.disabled = false;
  elements.autoFixNamesButton.disabled = false;
  updateReviewValidation();
  renderDuplicates();
}

function updateReviewValidation() {
  const issues = filenameIssues();
  const issueIndexes = new Set(issues.map((issue) => issue.index));
  elements.reviewTableBody.querySelectorAll('[data-filename-index]').forEach((input) => input.classList.toggle('filename-error', issueIndexes.has(Number(input.dataset.filenameIndex))));
  const empty = issues.filter((issue) => issue.type === 'empty').length;
  const duplicate = new Set(issues.filter((issue) => issue.type === 'duplicate').map((issue) => issue.index)).size;
  elements.reviewWarnings.innerHTML = issues.length
    ? `<div class="notice notice-warning"><strong>Please fix the filenames:</strong> ${empty ? `${empty} empty; ` : ''}${duplicate ? `${duplicate} duplicate` : ''}. You can edit them or use the automatic fix button.</div>`
    : '<div class="notice notice-success"><strong>All filenames are valid and unique.</strong></div>';
  elements.downloadZipButton.disabled = issues.length > 0 || state.busy;
}

function autoFixNames() {
  const used = new Map();
  state.groups.forEach((group, index) => {
    let name = sanitiseFilename(group.filename.replace(/\.pdf$/i, '')) || `document-${index + 1}`;
    const base = name;
    let count = 1;
    while (used.has(name.toLowerCase())) name = `${base}-${++count}`;
    used.set(name.toLowerCase(), true);
    group.filename = `${name}.pdf`;
  });
  renderReview();
}

async function createGroupPdf(group) {
  const output = await window.PDFLib.PDFDocument.create();
  const pageIndexes = group.pages.map((page) => page - 1);
  // const copied = await output.copyPages(state.pdfLibDoc, pageIndexes);
  const copied = await output.copyPages(group.source?.pdfLibDoc || state.pdfLibDoc, pageIndexes);
  copied.forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}

async function previewGroup(index) {
  try {
    const bytes = await createGroupPdf(state.groups[index]);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) showNotice('Your browser blocked the preview window. Allow pop-ups for this site and try again.', 'warning');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { showNotice(`<strong>Preview failed.</strong> ${escapeHtml(error.message)}`, 'danger'); }
}

async function downloadSingleGroup(index) {
  try {
    const group = state.groups[index];
    const bytes = await createGroupPdf(group);
    window.saveAs(new Blob([bytes], { type: 'application/pdf' }), sanitiseFilename(group.filename.replace(/\.pdf$/i, '')) + '.pdf');
  } catch (error) { showNotice(`<strong>Download failed.</strong> ${escapeHtml(error.message)}`, 'danger'); }
}

async function downloadZip() {
  if (state.busy || filenameIssues().length) return;
  state.busy = true;
  updateReviewValidation();
  elements.downloadZipButton.textContent = 'Creating ZIP…';
  showProgress(true, 'Generating PDF files…', 0);
  try {
    const zip = new window.JSZip();
    for (let index = 0; index < state.groups.length; index += 1) {
      const group = state.groups[index];
      setProgress(`Creating ${group.filename} (${index + 1} of ${state.groups.length})…`, index / state.groups.length * 90);
      const bytes = await createGroupPdf(group);
      zip.file(group.filename, bytes);
    }
    setProgress('Compressing ZIP archive…', 94);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, (meta) => setProgress('Compressing ZIP archive…', 94 + meta.percent * .06));
    // window.saveAs(blob, `${baseFileName(state.file.name)}-split-and-renamed.zip`);
    window.saveAs(blob, `${state.sources.length > 1 ? 'invoices' : baseFileName(state.file.name)}-split-and-renamed.zip`);
    setProgress('Download ready', 100);
    showNotice(`<strong>Download ready:</strong> ${state.groups.length} PDF files were created in one ZIP archive.`, 'success');
  } catch (error) {
    console.error(error);
    showNotice(`<strong>Could not generate the ZIP.</strong> ${escapeHtml(error.message || 'The browser may have run out of memory.')}`, 'danger');
  } finally {
    state.busy = false;
    elements.downloadZipButton.textContent = 'Download all PDFs as ZIP';
    showProgress(false);
    updateReviewValidation();
  }
}

function currentConfig() {
  return {
    version: 1,
    mode: getSelectedMode(),
    smartMethod: getSmartMethod(),
    regions: state.regions,
    splitKey: elements.splitKeySelect.value,
    carryForward: $('carryForwardCheckbox').checked,
    autoPreset: $('autoPresetSelect').value,
    customRegex: $('customRegexInput').value,
    autoCarryForward: $('autoCarryForwardCheckbox').checked,
    // keyword: $('keywordInput').value,
    // keywordType: $('keywordTypeSelect').value,
    // caseSensitive: $('caseSensitiveCheckbox').checked,
    // fixedCount: $('fixedPageCountInput').value,
    filenameTemplate: elements.filenameTemplateInput.value,
    useOcr: $('ocrCheckbox').checked,
    ocrLanguage: $('ocrLanguageSelect').value,
  };
}

function readTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function renderTemplateSelect() {
  const templates = readTemplates();
  $('savedTemplateSelect').innerHTML = '<option value="">Saved templates…</option>' + templates.map((template, index) => `<option value="${index}">${escapeHtml(template.name)}</option>`).join('');
}

function saveTemplate() {
  const name = window.prompt('Give this setup a name, for example “Monthly payslips”:');
  if (!name?.trim()) return;
  const templates = readTemplates();
  templates.push({ name: name.trim(), savedAt: new Date().toISOString(), config: currentConfig() });
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates.slice(-20)));
  renderTemplateSelect();
  $('savedTemplateSelect').value = String(Math.min(templates.length - 1, 19));
  showNotice('<strong>Setup saved in this browser.</strong> It stores the detection boxes and settings, not your PDF.', 'success');
}

function loadTemplate() {
  const index = Number($('savedTemplateSelect').value);
  const template = readTemplates()[index];
  if (!template) { showNotice('Choose a saved template first.', 'warning'); return; }
  const config = template.config;
  // Split-mode picker removed; older saved setups may still contain config.mode, which is ignored.
  // const modeInput = document.querySelector(`input[name="splitMode"][value="${config.mode}"]`);
  // if (modeInput) modeInput.checked = true;
  const methodInput = document.querySelector(`input[name="smartMethod"][value="${config.smartMethod}"]`);
  if (methodInput) methodInput.checked = true;
  state.regions = Array.isArray(config.regions) ? config.regions : [];
  updateModeUI(false); updateSmartMethodUI(); renderRegionsList();
  if (config.splitKey && state.regions.some((r) => r.key === config.splitKey)) elements.splitKeySelect.value = config.splitKey;
  $('carryForwardCheckbox').checked = config.carryForward !== false;
  $('autoPresetSelect').value = config.autoPreset || 'invoice';
  $('customRegexInput').value = config.customRegex || '';
  $('customRegexInput').disabled = $('autoPresetSelect').value !== 'custom';
  $('autoCarryForwardCheckbox').checked = config.autoCarryForward !== false;
  // $('keywordInput').value = config.keyword || '';
  // $('keywordTypeSelect').value = config.keywordType || 'text';
  // $('caseSensitiveCheckbox').checked = Boolean(config.caseSensitive);
  // $('fixedPageCountInput').value = config.fixedCount || 1;
  elements.filenameTemplateInput.value = config.filenameTemplate || defaultTemplateForMode('smart');
  $('ocrCheckbox').checked = Boolean(config.useOcr);
  $('ocrLanguageSelect').value = config.ocrLanguage || 'eng';
  $('ocrLanguageField').classList.toggle('hidden', !$('ocrCheckbox').checked);
  drawOverlay(); updatePlaceholderHelp(); validateAnalyseButton();
  showNotice(`<strong>${escapeHtml(template.name)}</strong> was loaded. Confirm the boxes still match this PDF layout.`, 'success');
}

async function resetApplication() {
  if (state.busy) return;
  if (state.ocrWorker) { await state.ocrWorker.terminate(); state.ocrWorker = null; }
  state.file = null; state.originalBuffer = null; state.pdfjsDoc = null; state.pdfLibDoc = null; state.pageCount = 0; state.currentPage = 1; state.regions = []; state.pendingRect = null; state.textCache.clear(); state.groups = []; state.sources = []; state.loadWarnings = [];
  elements.pdfInput.value = '';
  elements.fileSummary.classList.add('hidden');
  elements.fileSummary.innerHTML = '';
  // elements.methodSection.classList.add('disabled-section');
  elements.configureSection.classList.add('disabled-section');
  elements.reviewSection.classList.add('disabled-section');
  elements.viewerEmpty.classList.remove('hidden');
  elements.pdfCanvas.width = 0; elements.pdfCanvas.height = 0; elements.selectionCanvas.width = 0; elements.selectionCanvas.height = 0;
  elements.thumbnailStrip.innerHTML = '';
  elements.pageCountLabel.textContent = '0';
  elements.pageNumberInput.value = '1';
  renderRegionsList(); clearReview(); validateAnalyseButton();
  showNotice('<strong>Ready for another PDF.</strong> Choose a file to begin.', 'info');
}

function attachEvents() {
  // elements.pdfInput.addEventListener('change', () => handlePdfFile(elements.pdfInput.files[0]));
  elements.pdfInput.addEventListener('change', () => handlePdfFiles(elements.pdfInput.files));
  ['dragenter', 'dragover'].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropzone.classList.remove('dragover'); }));
  // elements.dropzone.addEventListener('drop', (event) => handlePdfFile(event.dataTransfer.files[0]));
  elements.dropzone.addEventListener('drop', (event) => handlePdfFiles(event.dataTransfer.files));
  // qsa('input[name="splitMode"]').forEach((input) => input.addEventListener('change', () => updateModeUI(true)));
  qsa('input[name="smartMethod"]').forEach((input) => input.addEventListener('change', updateSmartMethodUI));
  elements.previousPageButton.addEventListener('click', async () => { if (state.currentPage > 1) { state.currentPage -= 1; await renderCurrentPage(); } });
  elements.nextPageButton.addEventListener('click', async () => { if (state.currentPage < state.pageCount) { state.currentPage += 1; await renderCurrentPage(); } });
  elements.pageNumberInput.addEventListener('change', async () => { state.currentPage = Math.min(state.pageCount, Math.max(1, Number(elements.pageNumberInput.value))); await renderCurrentPage(); });
  elements.selectionCanvas.addEventListener('pointerdown', handlePointerDown);
  elements.selectionCanvas.addEventListener('pointermove', handlePointerMove);
  elements.selectionCanvas.addEventListener('pointerup', handlePointerUp);
  elements.selectionCanvas.addEventListener('pointercancel', handlePointerUp);
  $('addRegionButton').addEventListener('click', addPendingRegion);
  $('cancelRegionButton').addEventListener('click', cancelPendingRegion);
  $('clearRegionsButton').addEventListener('click', () => { state.regions = []; renderRegionsList(); drawOverlay(); updatePlaceholderHelp(); validateAnalyseButton(); });
  elements.regionNameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') addPendingRegion(); });
  $('suggestButton').addEventListener('click', findLikelyIds);
  elements.splitKeySelect.addEventListener('change', validateAnalyseButton);
  $('autoPresetSelect').addEventListener('change', () => { $('customRegexInput').disabled = $('autoPresetSelect').value !== 'custom'; validateAnalyseButton(); });
  $('customRegexInput').addEventListener('input', validateAnalyseButton);
  // $('keywordInput').addEventListener('input', validateAnalyseButton);
  // $('fixedPageCountInput').addEventListener('input', validateAnalyseButton);
  elements.filenameTemplateInput.addEventListener('input', validateAnalyseButton);
  $('ocrCheckbox').addEventListener('change', () => $('ocrLanguageField').classList.toggle('hidden', !$('ocrCheckbox').checked));
  elements.analyseButton.addEventListener('click', analysePdf);
  elements.downloadZipButton.addEventListener('click', downloadZip);
  elements.autoFixNamesButton.addEventListener('click', autoFixNames);
  $('resetButton').addEventListener('click', resetApplication);
  $('saveTemplateButton').addEventListener('click', saveTemplate);
  $('loadTemplateButton').addEventListener('click', loadTemplate);
  window.addEventListener('resize', () => { if (state.pdfjsDoc) renderCurrentPage(); });
}

attachEvents();
renderTemplateSelect();
updateModeUI(false);
updateSmartMethodUI();
renderRegionsList();
validateAnalyseButton();
