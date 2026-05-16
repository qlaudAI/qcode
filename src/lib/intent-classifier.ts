// Client-side intent classifier — mirror of qlaud_router's
// apps/edge/src/sandbox/intent-classifier.ts.
//
// Purpose: decide per-turn whether the user's prompt needs the
// AGENT engine (full sandbox container + claude-code tool loop +
// GitLab restore) or the CHAT engine (plain model passthrough).
//
// Two-stage architecture (alpha.216):
//
//   Stage 1: heuristic (this module, classifyIntent)
//     - Keyword + structural rules
//     - ~0ms, free, deterministic
//     - Covers high-confidence cases (>= 0.7): clear agent verbs,
//       explicit chat phrases, very short greetings
//
//   Stage 2: Haiku LLM fallback (classifyIntentLlm, async)
//     - POST /v1/intent/classify with prompt + thread context
//     - ~200-400ms, ~$0.0003/call
//     - Fires only when heuristic returns < 0.7 confidence
//     - Authoritative; overrides the heuristic
//
// The user-facing caller (ChatSurface.send) runs the heuristic
// synchronously. If confidence is high, send proceeds. If low,
// awaits the LLM classification before deciding engine. Most
// turns skip stage 2 entirely; only the ambiguous middle pays
// the round-trip.

export type Intent = 'chat' | 'agent' | 'plan';

export type IntentResult = {
  intent: Intent;
  confidence: number;
  reason: string;
};

const AGENT_VERBS = [
  'build', 'create', 'make', 'scaffold', 'generate', 'implement',
  'add a', 'add this', 'set up', 'setup', 'install',
  'fix', 'debug', 'refactor', 'rename', 'modify', 'update',
  'change the', 'edit', 'remove the', 'delete the', 'replace',
  'run', 'execute', 'test', 'deploy', 'start the', 'launch',
  'compile', 'serve',
  'open the file', 'open file', 'read file', 'write a file',
  'git ', 'commit', 'push to', 'clone', 'branch',
  'project', 'codebase', 'repository', 'repo', 'workspace',
];

const CHAT_PHRASES = [
  'what is', 'what are', 'what does', 'what was',
  'why is', 'why do', 'why does',
  'how does', 'how do', 'how can',
  'explain', 'tell me about', 'describe',
  'difference between', 'compare',
  'when should', 'should i', 'is it ok',
  'translate', 'summarize',
];

const STRONG_AGENT_SIGNALS = [
  'and apply', 'and run it', 'in the codebase',
  'in my project', 'in this repo', 'in my repo',
  'commit and push', 'open a pr', 'open a pull request',
  'show me the diff', 'apply the changes',
];

const PLAN_VERBS = [
  'investigate', 'analyze', 'audit', 'review', 'walk through',
  'walk me through', 'find where', 'find all',
  'trace', 'profile', 'where is', 'where does',
];

const AGENT_MIN_LENGTH = 12;

export function classifyIntent(args: {
  prompt: string;
  /** When true (thread already on agent path), ambiguous prompts
   *  stay on agent. When false (new thread or pure-chat thread),
   *  ambiguous prompts go to chat. */
  threadIsAgentic?: boolean;
}): IntentResult {
  const raw = (args.prompt ?? '').trim();
  const text = raw.toLowerCase();

  if (text.length === 0) {
    return { intent: 'chat', confidence: 1, reason: 'empty prompt' };
  }

  // Very short prompts ("hi", "hello", "ok", "thanks", "lol") —
  // always chat. Greetings + acknowledgments never need the agent
  // engine, regardless of thread state.
  if (text.length < 6) {
    return {
      intent: 'chat',
      confidence: 0.95,
      reason: `prompt is very short (${text.length} chars)`,
    };
  }

  const baselineBias: Intent = args.threadIsAgentic ? 'agent' : 'chat';

  for (const phrase of STRONG_AGENT_SIGNALS) {
    if (text.includes(phrase)) {
      return {
        intent: 'agent',
        confidence: 0.95,
        reason: `strong agent signal: "${phrase}"`,
      };
    }
  }

  const planMatch = PLAN_VERBS.find((v) => text.includes(v));
  if (planMatch && text.length >= AGENT_MIN_LENGTH) {
    return {
      intent: 'plan',
      confidence: 0.85,
      reason: `plan verb: "${planMatch}"`,
    };
  }

  const chatMatch = CHAT_PHRASES.find((p) => text.includes(p));
  const agentMatch = AGENT_VERBS.find((v) => text.includes(v));

  if (chatMatch && !agentMatch) {
    return {
      intent: 'chat',
      confidence: 0.9,
      reason: `chat phrase: "${chatMatch}"`,
    };
  }

  if (chatMatch && agentMatch) {
    if (text.length >= 60) {
      return {
        intent: 'agent',
        confidence: 0.6,
        reason: `mixed signals; long prompt biased to agent`,
      };
    }
    return {
      intent: baselineBias,
      confidence: 0.5,
      reason: `mixed signals; short prompt biased to baseline=${baselineBias}`,
    };
  }

  if (agentMatch) {
    if (text.length < AGENT_MIN_LENGTH) {
      return {
        intent: 'chat',
        confidence: 0.7,
        reason: `agent verb "${agentMatch}" but prompt too short`,
      };
    }
    return {
      intent: 'agent',
      confidence: 0.85,
      reason: `agent verb: "${agentMatch}"`,
    };
  }

  return {
    intent: baselineBias,
    confidence: 0.4,
    reason: `no signal; baseline=${baselineBias}`,
  };
}

// API origin for the Haiku-backed classifier. Same base every
// other qlaud lib in qcode reads from. Skipped on Tauri-only
// builds where SANDBOX_AGENT_ENABLED is false — the heuristic's
// answer is good enough for the chat-only routing decisions
// the desktop build makes.
const EDGE_BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

/** Confidence threshold below which we invoke the Haiku LLM
 *  fallback. Tuned conservative — the keyword heuristic is
 *  cheap; the LLM call is ~$0.0003 + 300ms. We'd rather pay
 *  occasionally and be right than always be heuristic-fast and
 *  sometimes wrong. */
export const LLM_FALLBACK_CONFIDENCE_THRESHOLD = 0.7;

/** Async LLM-backed intent classifier. Hits POST /v1/intent/classify
 *  on the edge worker, which runs Haiku with the prompt + thread
 *  context. Returns null on any failure (network, 5xx, parse) so
 *  callers fall back to the heuristic answer rather than block
 *  the user's turn on a classifier outage. */
export async function classifyIntentLlm(args: {
  prompt: string;
  threadIsAgentic?: boolean;
  authBearer: string;
  /** Recent conversation snippets — last 2-3 message texts, each
   *  ~200 chars. Helps Haiku disambiguate "continue" / "retry" /
   *  "yes" follow-ups that are meaningless in isolation. */
  recentMessages?: string[];
  /** Race timeout in ms. Default 4000 — Haiku usually resolves
   *  in 200-400ms; anything past 4s indicates the classifier is
   *  unavailable and the user is better served by falling back
   *  to the heuristic than waiting longer. */
  timeoutMs?: number;
}): Promise<IntentResult | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), args.timeoutMs ?? 4000);
    const r = await fetch(`${EDGE_BASE}/v1/intent/classify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.authBearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: args.prompt,
        threadIsAgentic: args.threadIsAgentic ?? false,
        recentMessages: args.recentMessages,
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = (await r.json()) as {
      intent?: string;
      confidence?: number;
      reason?: string;
      source?: string;
    };
    const intent = data.intent;
    if (intent !== 'chat' && intent !== 'agent' && intent !== 'plan') return null;
    return {
      intent,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.95,
      reason: data.reason ?? `LLM classifier returned ${intent}`,
    };
  } catch {
    return null;
  }
}
