// qlaud-tools skill — teaches the agent the search-then-call pattern
// over qlaud's meta-tool REST API.
//
// The whole point of this is to avoid token bloat. Instead of
// listing every available tool's schema in the system prompt, the
// agent uses 3 endpoints to discover and call any of qlaud's
// builtins / MCP servers / registered tools dynamically:
//   • POST /v1/tools/search   — find tools by intent
//   • POST /v1/tools/schemas  — fetch schemas for the ones you'll call
//   • POST /v1/tools/execute  — run them (one or more in parallel)
//   • POST /v1/connections    — manage per-user MCP credentials
//
// All four are 1:1 wrappers over qlaud's existing meta-tool dispatch
// logic — same handlers the threads endpoint runs in tools_mode=
// 'dynamic'. Reuse, not parallel implementation.
//
// This skill stays SHORT on purpose. The whole architecture is
// "search-by-intent, don't enumerate." Listing tools here would
// defeat the design.

export const QLAUD_TOOLS_SKILL = `qlaud tools — discover and call any external tool dynamically.

The pattern is search-then-call. Don't list tools or memorize URLs — describe what you want, search for the matching tool, fetch its schema, call it. Token-efficient by design.

────────────────────────────────────────────────────────────────────
THE 3-STEP PATTERN

1. SEARCH by intent
   curl -s https://api.qlaud.ai/v1/tools/search \\
     -H "x-api-key: \$ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{"intent":"<plain-english description>","limit":5}'
   # Returns matching tools with name + description (NOT schemas).
   # Search covers every qlaud builtin (web-search, slack-post-message,
   # github-create-issue, send-email, etc.), every MCP server in
   # qlaud's catalog (~105: Linear, Stripe, Atlassian, Notion, …),
   # and the user's own registered tools.

2. FETCH SCHEMAS for the ones you'll actually use
   curl -s https://api.qlaud.ai/v1/tools/schemas \\
     -H "x-api-key: \$ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{"tools":["tool_name_1","tool_name_2"]}'
   # Returns input_schema for each. Now you know what args to pass.

3. EXECUTE
   curl -s https://api.qlaud.ai/v1/tools/execute \\
     -H "x-api-key: \$ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{"calls":[{"tool":"tool_name","args":{...}}]}'
   # Returns results in same order. Multiple tools run in parallel
   # when independent. For single tool: one element in calls.

────────────────────────────────────────────────────────────────────
PER-USER CREDENTIALS (when execute returns "not connected")

Some tools (auth_mode='per_user': Linear, GitHub, etc.) need the
end-user's own credentials before they can run. Three steps:

  # Check status
  curl -s https://api.qlaud.ai/v1/connections \\
    -H "x-api-key: \$ANTHROPIC_API_KEY" \\
    -d '{"action":"status","tool":"<tool_name>"}'
  # Returns { connected: bool, credentials_prompt: string|null }

  # If not connected, ask the user for the credentials in chat,
  # then store them
  curl -s https://api.qlaud.ai/v1/connections \\
    -H "x-api-key: \$ANTHROPIC_API_KEY" \\
    -d '{"action":"connect","tool":"<tool_name>",
         "credentials":{"<key>":"<value>"}}'
  # AES-GCM encrypted server-side, scoped to this account.

  # Then retry execute.

Other actions: 'list' (every tool + status), 'disconnect' (revoke).

────────────────────────────────────────────────────────────────────
WHEN TO REACH FOR THIS

Any user request that might involve an external system. Examples:

  "send a slack message to #engineering"
    → search intent="post a slack channel message"
    → schemas for the matching tool
    → execute

  "open a github issue from this bug repro"
    → search intent="create github issue"
    → schemas
    → execute

  "what tools do I have?"
    → connections action="list"

  "do you have anything for Linear?"
    → search intent="linear" → returns connectors and registered tools

────────────────────────────────────────────────────────────────────
COMMON MISTAKES

✗ Don't list tools you might use. Search-by-intent with the user's
  ACTUAL goal. The pattern works precisely because you don't have
  to know the tool names upfront.

✗ Don't fetch schemas for every search result. Fetch only the
  tool(s) you'll actually call. Schemas are 200-500 tokens each.

✗ Don't guess argument shapes — fetch the schema first.

✗ Don't ask the user "do you have GitHub connected?" before
  searching. /v1/tools/search + connections.action='status' answer
  this without asking.

────────────────────────────────────────────────────────────────────
A FEW STATIC ENDPOINTS (search-first not required)

Stable enough to call directly without going through search.
Documented in qlaud-media.md for the full curl recipes:

  /v1/images/generations    /v1/audio/speech
  /v1/audio/transcriptions  /v1/videos/generations
  /v1/artifacts/init        /pexels/*  /pixabay/*
  /elevenlabs/*  /deepgram/*  /cartesia/*

For everything else: search-then-call.`;
