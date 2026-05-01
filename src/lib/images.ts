// Helpers for image attachments in the composer. We support
// drag/drop and paste-from-clipboard; both routes converge on
// readImageFile() which produces an Anthropic-shape image content
// block (base64 + media_type) plus a small in-memory thumbnail
// data URL the chat surface uses for previews.
//
// Hard cap on size + dimensions so a stray drag of a 50 MB
// screenshot doesn't OOM the webview or balloon the model
// payload. Models accept JPEG/PNG/GIF/WebP — anything else gets
// rejected.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type AttachedImage = {
  /** Stable id used for keying + the chip's onRemove. */
  id: string;
  /** What the user dragged in / pasted. Used for the chip label. */
  name: string;
  mediaType: string;
  /** Raw base64 (no data: prefix). The Anthropic image block needs
   *  exactly this — the data URL form is only used for thumbnails. */
  base64: string;
  /** Display URL (data: URL) for preview chips + user bubble. */
  thumbUrl: string;
  bytes: number;
};

export type ImageError = {
  reason: 'too_big' | 'unsupported_type' | 'read_failed';
  message: string;
};

export async function readImageFile(
  file: File | Blob,
  fallbackName?: string,
): Promise<AttachedImage | ImageError> {
  const mediaType = file.type;
  if (!ALLOWED.has(mediaType)) {
    return {
      reason: 'unsupported_type',
      message: `Type ${mediaType || 'unknown'} not supported. Use PNG, JPEG, GIF, or WebP.`,
    };
  }
  if (file.size > MAX_BYTES) {
    return {
      reason: 'too_big',
      message: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Limit is ${MAX_BYTES / 1024 / 1024} MB.`,
    };
  }

  const dataUrl = await readAsDataURL(file);
  if (!dataUrl) {
    return { reason: 'read_failed', message: 'Could not read the image.' };
  }
  // dataUrl is "data:<mt>;base64,<base64>"; split to get the
  // raw bytes for the Anthropic block.
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';

  return {
    id:
      'img_' +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36),
    name: 'name' in file && file.name ? file.name : (fallbackName ?? 'pasted-image'),
    mediaType,
    base64,
    thumbUrl: dataUrl,
    bytes: file.size,
  };
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

/** Pull every image File out of a clipboard event. Modern
 *  Mac/Win/Linux browsers all expose clipboard images via items[]. */
export function imagesFromPaste(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** Pull image Files from a drag/drop event. */
export function imagesFromDrop(e: DragEvent): File[] {
  const items = e.dataTransfer?.files;
  if (!items) return [];
  const out: File[] = [];
  for (const f of items) {
    if (f.type.startsWith('image/')) out.push(f);
  }
  return out;
}
