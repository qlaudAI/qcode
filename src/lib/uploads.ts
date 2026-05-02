// Generic uploaded-file ingestion for the composer. Three flavors:
//
//   - image (PNG/JPEG/GIF/WebP) → Anthropic image content block.
//     Native multimodal handling on every routed provider.
//
//   - PDF → Anthropic document content block. Claude reads PDFs
//     natively (vision + text). For non-Anthropic providers the
//     qlaud edge handles fallback (text extraction or rejection).
//
//   - text (markdown, code, csv, json, plain text) → inlined into
//     the user message text with a clear `--- file: <name> ---`
//     fence. Cheap, works everywhere, no special model support
//     needed.
//
// Anything else gets a typed error so the UI can show "we don't
// support .xlsx yet" rather than silently failing or sending bytes
// the model can't read.
//
// Drop / paste / file-picker all funnel through readUploadedFile().
// The composer keeps a flat `attachments` list of the union, then
// fans out to the right content-block shape at send time.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB (Anthropic limit is 32 MB)
const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB — text gets tokenized inline

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_TYPES = new Set(['application/pdf']);

// Extensions we treat as text even when the OS / browser reports
// `application/octet-stream` (common for unrecognized code files).
// Keeping this list narrow on purpose — anything beyond well-known
// source/data formats should declare a real text MIME type.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml',
  'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'graphql', 'proto', 'thrift',
  'env', 'ini', 'conf', 'cfg', 'lock',
  'log',
]);

export type AttachedImage = {
  kind: 'image';
  id: string;
  name: string;
  mediaType: string;
  /** Raw base64, no data: prefix. The image content block needs this. */
  base64: string;
  /** Display URL for previews + the user bubble's thumbnail. */
  thumbUrl: string;
  bytes: number;
};

export type AttachedDocument = {
  kind: 'document';
  id: string;
  name: string;
  mediaType: string;
  base64: string;
  bytes: number;
};

export type AttachedText = {
  kind: 'text';
  id: string;
  name: string;
  text: string;
  bytes: number;
};

export type AttachedFile = AttachedImage | AttachedDocument | AttachedText;

export type UploadError = {
  reason: 'too_big' | 'unsupported_type' | 'read_failed';
  message: string;
};

export async function readUploadedFile(
  file: File | Blob,
  fallbackName?: string,
): Promise<AttachedFile | UploadError> {
  const name = 'name' in file && file.name ? file.name : (fallbackName ?? 'pasted-file');
  const mt = file.type || guessFromExtension(name) || '';

  if (IMAGE_TYPES.has(mt)) {
    return readImage(file, name, mt);
  }
  if (PDF_TYPES.has(mt)) {
    return readPdf(file, name, mt);
  }
  if (mt.startsWith('text/') || isTextExtension(name)) {
    return readText(file, name);
  }

  return {
    reason: 'unsupported_type',
    message:
      `Type ${mt || 'unknown'} not supported. Use an image (PNG/JPEG/GIF/WebP), ` +
      `a PDF, or a text/code file.`,
  };
}

// ─── per-kind readers ─────────────────────────────────────────────

async function readImage(
  file: File | Blob,
  name: string,
  mediaType: string,
): Promise<AttachedImage | UploadError> {
  if (file.size > MAX_IMAGE_BYTES) {
    return tooBig('Image', file.size, MAX_IMAGE_BYTES);
  }
  const dataUrl = await readAsDataURL(file);
  if (!dataUrl) return { reason: 'read_failed', message: 'Could not read the image.' };
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  return {
    kind: 'image',
    id: makeId('img'),
    name,
    mediaType,
    base64,
    thumbUrl: dataUrl,
    bytes: file.size,
  };
}

async function readPdf(
  file: File | Blob,
  name: string,
  mediaType: string,
): Promise<AttachedDocument | UploadError> {
  if (file.size > MAX_PDF_BYTES) {
    return tooBig('PDF', file.size, MAX_PDF_BYTES);
  }
  const dataUrl = await readAsDataURL(file);
  if (!dataUrl) return { reason: 'read_failed', message: 'Could not read the PDF.' };
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  return {
    kind: 'document',
    id: makeId('pdf'),
    name,
    mediaType,
    base64,
    bytes: file.size,
  };
}

async function readText(
  file: File | Blob,
  name: string,
): Promise<AttachedText | UploadError> {
  if (file.size > MAX_TEXT_BYTES) {
    return tooBig('Text file', file.size, MAX_TEXT_BYTES);
  }
  const text = await readAsText(file);
  if (text === null) {
    return { reason: 'read_failed', message: 'Could not decode the file as text.' };
  }
  return {
    kind: 'text',
    id: makeId('txt'),
    name,
    text,
    bytes: file.size,
  };
}

// ─── paste / drop helpers ─────────────────────────────────────────

/** Pull every supported file out of a clipboard event. Modern
 *  browsers expose pasted images via `items`; pasted documents
 *  rarely show up here, but we accept what we can. */
export function filesFromPaste(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** Pull all files from a drag/drop event. Filters happen later in
 *  readUploadedFile so the user gets a clear "unsupported" message
 *  per file rather than silent drops. */
export function filesFromDrop(e: DragEvent): File[] {
  const items = e.dataTransfer?.files;
  if (!items) return [];
  return Array.from(items);
}

// ─── helpers ──────────────────────────────────────────────────────

function tooBig(label: string, bytes: number, limit: number): UploadError {
  return {
    reason: 'too_big',
    message: `${label} is ${(bytes / 1024 / 1024).toFixed(1)} MB. Limit is ${limit / 1024 / 1024} MB.`,
  };
}

function makeId(prefix: string): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readAsDataURL(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const v = reader.result;
      resolve(typeof v === 'string' ? v : null);
    };
    reader.readAsDataURL(blob);
  });
}

function readAsText(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const v = reader.result;
      resolve(typeof v === 'string' ? v : null);
    };
    reader.readAsText(blob);
  });
}

function guessFromExtension(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return null;
}

function isTextExtension(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}
