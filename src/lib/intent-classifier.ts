// Client-side intent classifier — mirror of qlaud_router's
// apps/edge/src/sandbox/intent-classifier.ts.
//
// Purpose: decide per-turn whether the user's prompt needs the
// AGENT engine (full sandbox container + claude-code tool loop +
// GitLab restore) or the CHAT engine (plain model passthrough).
//
// Why this exists on the client:
// As of alpha.182 we hid the Chat / Agent / Plan toggle so users
// don't see modes. Without this classifier, every send goes
// through whatever `mode` the user had set previously — typically
// 'agent' on a thread that's already been promoted to a sandbox
// workspace. Result: typing "hi" or "thanks" triggers the
// full agent loop (~30s container spinup + GitLab clone + claude
// stream + push). The classifier downshifts those to the chat
// path so a one-word greeting stays a one-word greeting.
//
// Keep this file in lock-step with the server module — same
// keyword lists, same heuristic order, same biases. If the two
// drift, server- and client-side decisions can disagree and the
// user sees inconsistent behavior. A future commit factors them
// into a shared package; for now duplication is fine because
// the logic is small + stable.

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
