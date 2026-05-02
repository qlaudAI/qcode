// Auto-generated thread titles — replaces titleFromPrompt's
// "first 60 chars of the user's first message" with a proper
// summary. After every turn lands we kick off a background call
// that asks a small/cheap model to distill the conversation into
// a 3-5 word title for the sidebar. As the user's purpose shifts
// (refactor → debug → review), the title shifts with it.
//
// Cost is negligible: Haiku 4.5 at ~500 tokens in / 10 tokens out
// is roughly $0.0006 per call. We don't queue or debounce — fire
// per-turn, race wins (the latest turn's regenerate overwrites
// any stale earlier one if they finish out of order — the latest
// always reflects the latest content).
//
// Skipped when the user has manually edited the title
// (titleSource === 'user' on the ThreadSummary). qcode currently
// has no UI for manual edits, but the field exists so the
// behavior is correct from day one when we add it.

import { getKey } from './auth';
import type { ContentBlock, Message } from './qlaud-client';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

// Small, fast, cheap. Haiku is overkill for "summarize in 5 words"
// but the latency is what matters more than the dollars — anything
// slower than ~1s makes the sidebar feel stale.
const TITLE_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 30;
// Cap conversation context — we don't need the whole thread, just
// enough to know what it's about. Last 6 turns is plenty.
const CONTEXT_TURNS = 6;
const TITLE_MAX_CHARS = 50;

const SYSTEM = `You write tab titles. Given a conversation, output a 3-5 word title that captures what the user is working on. NO quotes, NO punctuation at the end, NO "Discussing" or "About" prefixes — just the topic in title case. If the conversation hasn't established a clear topic yet, output exactly "New chat".`;

/** Generate a fresh title from the thread's recent history. Returns
 *  null on any failure (network, empty, ratelimit) — caller keeps
 *  whatever title was there before. */
export async function generateThreadTitle(
  history: Message[],
): Promise<string | null> {
  const key = getKey();
  if (!key) return null;
  if (history.length === 0) return null;

  // Trim to the last N turns + flatten to plain text. Tool use /
  // image / document blocks compress to a one-liner placeholder so
  // the model focuses on the human-readable conversation, not on
  // the tool-loop noise.
  const recent = history.slice(-CONTEXT_TURNS).map((m) => ({
    role: m.role,
    content: flatten(m.content),
  }));
  if (recent.every((m) => !m.content.trim())) return null;

  const userPrompt =
    'Conversation:\n\n' +
    recent
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n') +
    '\n\nTitle:';

  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(
        `[title-gen] /v1/messages returned ${res.status} — keeping prior title`,
      );
      return null;
    }
    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) return null;
    // First line, trim trailing punctuation, cap length.
    let title = text.split('\n')[0]?.trim() ?? '';
    title = title.replace(/^["']|["']$/g, '').replace(/[.!?,;:]+$/, '');
    if (title.length > TITLE_MAX_CHARS) {
      title = title.slice(0, TITLE_MAX_CHARS - 1).trim() + '…';
    }
    return title || null;
  } catch (e) {
    console.warn('[title-gen] generation failed:', e);
    return null;
  }
}

/** Flatten ContentBlock[] to plain text for the title prompt.
 *  Images / documents / tool-loop noise become one-liner
 *  placeholders so the model summarizes the human conversation. */
function flatten(content: ContentBlock[]): string {
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[image]';
      if (b.type === 'document') return '[document]';
      if (b.type === 'tool_use') return `[ran ${b.name}]`;
      if (b.type === 'tool_result') return '';
      return '';
    })
    .filter(Boolean)
    .join(' ');
}
