// Read attached files from disk before sending the agent loop a
// turn. Each file is wrapped in a <file path="…"> block so the model
// sees clean structure regardless of which provider routes the call.
//
// Cap the per-file size so a careless attach-of-package-lock.json
// doesn't burn the user's context window. Cap the total too — a
// hard ceiling on what one turn can carry.

import { isTauri } from './tauri';

const MAX_FILE_BYTES = 100 * 1024; // 100 KB per file
const MAX_TOTAL_BYTES = 400 * 1024; // 400 KB across all attachments

export type AttachmentResult = {
  /** Markdown-shaped block to prepend to the user's text. */
  contextBlock: string;
  /** Files actually loaded — small subset of input may be skipped. */
  loaded: { path: string; bytes: number }[];
  /** Files we couldn't load (too big, missing, read error). */
  skipped: { path: string; reason: string }[];
};

export async function buildAttachmentContext(
  workspace: string,
  paths: string[],
): Promise<AttachmentResult> {
  if (paths.length === 0) {
    return { contextBlock: '', loaded: [], skipped: [] };
  }
  if (!isTauri()) {
    // vite-dev: stub the contents so the message-building flow stays
    // testable without filesystem access.
    const stubs = paths.map((p) => `<file path="${p}">\n[browser-mode stub]\n</file>`);
    return {
      contextBlock: stubs.join('\n\n'),
      loaded: paths.map((p) => ({ path: p, bytes: 0 })),
      skipped: [],
    };
  }

  const { stat, readTextFile } = await import('@tauri-apps/plugin-fs');
  const loaded: AttachmentResult['loaded'] = [];
  const skipped: AttachmentResult['skipped'] = [];
  const blocks: string[] = [];
  let totalBytes = 0;

  for (const rel of paths) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      skipped.push({ path: rel, reason: 'total cap reached' });
      continue;
    }
    const abs = `${workspace}/${rel}`;
    let info;
    try {
      info = await stat(abs);
    } catch {
      skipped.push({ path: rel, reason: 'not found' });
      continue;
    }
    if (info.size != null && info.size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: `too large (${info.size} bytes)` });
      continue;
    }
    let text: string;
    try {
      text = await readTextFile(abs);
    } catch (e) {
      skipped.push({
        path: rel,
        reason: e instanceof Error ? e.message : 'read failed',
      });
      continue;
    }
    blocks.push(`<file path="${rel}">\n${text}\n</file>`);
    loaded.push({ path: rel, bytes: text.length });
    totalBytes += text.length;
  }

  if (loaded.length === 0) {
    return { contextBlock: '', loaded, skipped };
  }
  return {
    contextBlock:
      `The user attached the following files for context. Reference them directly:\n\n${blocks.join('\n\n')}`,
    loaded,
    skipped,
  };
}
