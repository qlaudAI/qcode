// Upload a local workspace artifact to the qlaud cloud so it's
// available to the user on web / other devices.
//
// Two-step flow matching the qlaud /v1/artifacts API:
//   1. POST /v1/artifacts/init with metadata → mint id + upload_url
//   2. PUT the bytes to upload_url
//
// Caller passes the absolute path; we read it via Tauri's
// plugin-fs and infer mime from the extension. Surfaces failure
// as a thrown Error with a human-readable message — Media tab's
// upload button catches and shows it as a transient toast.

import { getKey } from './auth';
import { isTauri } from './tauri';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

/** Minimal mime sniff from extension. Covers everything qcode's
 *  Media tab classifies as image/audio/video. Falls back to
 *  application/octet-stream so the upload still works for unknown
 *  types — R2 doesn't care about the content-type for storage. */
function mimeFromName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'avif':
      return 'image/avif';
    case 'pdf':
      return 'application/pdf';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'm4v':
      return 'video/x-m4v';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

/** "image" | "audio" | "video" — the artifacts API needs a hint
 *  for filtering / billing. Inferred from the mime prefix. */
function kindFromMime(mime: string): 'image' | 'audio' | 'video' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  // PDF + everything else gets bucketed as image (best-effort —
  // the artifacts API rejects anything outside the three known
  // kinds, so this keeps us inside the contract).
  return 'image';
}

export type UploadResult = {
  id: string;
  download_url: string;
};

/** Upload a local file at `absPath` to the qlaud cloud, scoped
 *  to the given thread so it shows up in the Media tab on other
 *  devices viewing the same conversation. Throws on auth /
 *  network / API failure with a message safe to show in toast. */
export async function uploadArtifactToCloud(opts: {
  absPath: string;
  name: string;
  threadId: string | null;
}): Promise<UploadResult> {
  if (!isTauri()) {
    throw new Error('cloud upload is desktop-only');
  }
  const apiKey = getKey();
  if (!apiKey) {
    throw new Error('sign in to upload to cloud');
  }

  // Read the file bytes via Tauri's plugin-fs. readFile returns
  // Uint8Array which we wrap into a Blob for the PUT body.
  const { readFile } = await import('@tauri-apps/plugin-fs');
  let bytes: Uint8Array;
  try {
    bytes = await readFile(opts.absPath);
  } catch (e) {
    throw new Error(
      `couldn't read ${opts.name}: ${e instanceof Error ? e.message : 'fs error'}`,
    );
  }
  const byteSize = bytes.byteLength;
  // 50MB cap matches the worker's MAX_BYTE_SIZE in routes/artifacts.ts.
  if (byteSize === 0) {
    throw new Error(`${opts.name} is empty`);
  }
  if (byteSize > 50 * 1024 * 1024) {
    throw new Error(
      `${opts.name} is too large (${(byteSize / 1024 / 1024).toFixed(1)} MB > 50 MB cap)`,
    );
  }

  const mime = mimeFromName(opts.name);
  const kind = kindFromMime(mime);

  // Step 1: init.
  let initRes: Response;
  try {
    initRes = await fetch(`${BASE}/v1/artifacts/init`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        thread_id: opts.threadId,
        kind,
        mime,
        byte_size: byteSize,
        original_name: opts.name,
      }),
    });
  } catch (e) {
    // Network failure (offline, CSP block, DNS). Logging the raw
    // exception in devtools is the only way to diagnose connect-src
    // CSP rejections — fetch swallows them into a generic TypeError
    // with no detail in the message.
    console.error('[artifact-upload] init fetch failed', e);
    throw new Error(
      `network error during init: ${e instanceof Error ? e.message : 'unknown'}`,
    );
  }
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => '');
    console.error(
      '[artifact-upload] init non-2xx',
      initRes.status,
      text.slice(0, 500),
    );
    throw new Error(`init failed (${initRes.status}): ${text.slice(0, 200)}`);
  }
  // Server returns { artifact_id, upload_url, r2_key, ... } from
  // /v1/artifacts/init. We aliased it to `id` in an earlier pass —
  // wrong, the actual field is `artifact_id`. Reading the wrong key
  // silently failed every upload here with "init response missing
  // id / upload_url" since alpha.161.
  const initJson = (await initRes.json()) as {
    artifact_id?: string;
    upload_url?: string;
    download_url?: string;
  };
  if (!initJson.artifact_id || !initJson.upload_url) {
    console.error('[artifact-upload] init missing fields', initJson);
    throw new Error('init response missing artifact_id / upload_url');
  }

  // Step 2: upload bytes. The worker's PUT endpoint is bearer-
  // authed too — same key.
  //
  // Body shape: pass the raw Uint8Array so the WebView's fetch builds
  // a fixed-length octet body with no streaming. Tauri 2's macOS
  // WKWebView previously dropped Content-Length when handed a Blob
  // that wraps a Uint8Array (the worker then saw `c.req.raw.body` as
  // null and rejected the upload), so we keep this explicit. Cast
  // through `BodyInit` because TypeScript's lib.dom types still allow
  // ArrayBufferView in body but the typedef here doesn't unify with
  // Uint8Array<ArrayBuffer> generic — a one-line cast over a debate
  // about generics on a 4MB upload is cleaner.
  let putRes: Response;
  try {
    putRes = await fetch(initJson.upload_url, {
      method: 'PUT',
      headers: {
        'x-api-key': apiKey,
        'content-type': mime,
        'content-length': String(byteSize),
      },
      body: bytes as unknown as BodyInit,
    });
  } catch (e) {
    console.error('[artifact-upload] PUT fetch failed', e);
    throw new Error(
      `network error during upload: ${e instanceof Error ? e.message : 'unknown'}`,
    );
  }
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    console.error(
      '[artifact-upload] PUT non-2xx',
      putRes.status,
      text.slice(0, 500),
    );
    throw new Error(`upload failed (${putRes.status}): ${text.slice(0, 200)}`);
  }

  return {
    id: initJson.artifact_id,
    download_url:
      initJson.download_url ??
      `${BASE}/v1/artifacts/${initJson.artifact_id}/download`,
  };
}
