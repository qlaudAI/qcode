// Renderers for the 4 qlaud meta-tools (tools_mode='dynamic'):
//   - qlaud_search_tools     → "find me tools that do X"
//   - qlaud_get_tool_schemas → "give me the input schema for tool Y"
//   - qlaud_multi_execute    → "run tools A, B, C in parallel"
//   - qlaud_manage_connections — special: when action='connect' and the
//     server returns a connect_url, we render a prominent button that
//     opens the qlaud-hosted credential form in the user's browser.
//     The user pastes their token there; qlaud encrypts + stores it;
//     the next agent turn finds the credentials ready.
//
// Outputs come back as JSON-stringified payloads (qlaud serializes
// non-string outputs server-side before fitting them into Anthropic's
// tool_result content block, which is string-only).

import { ExternalLink, Plug, Search, Wrench } from 'lucide-react';

import { openExternal } from '../../lib/tauri';

export function MetaToolView({
  name,
  input,
  output,
  isError,
}: {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}) {
  if (name === 'qlaud_manage_connections') {
    return <ManageConnectionsView input={input} output={output} isError={isError} />;
  }
  if (name === 'qlaud_search_tools') {
    return <SearchToolsView output={output} isError={isError} />;
  }
  if (name === 'qlaud_get_tool_schemas') {
    return <GetSchemasView output={output} isError={isError} />;
  }
  if (name === 'qlaud_multi_execute') {
    return <MultiExecuteView output={output} isError={isError} />;
  }
  return <RawJSONView output={output} />;
}

// ─── qlaud_manage_connections ─────────────────────────────────────
//
// Three response shapes worth handling distinctly:
//   - connect_url present → user needs to paste credentials. Show a
//     prominent button.
//   - status: 'connected' / 'not_connected' → status pill.
//   - list action → bullet list of {tool, status} pairs.

function ManageConnectionsView({
  input,
  output,
  isError,
}: {
  input: unknown;
  output: string;
  isError: boolean;
}) {
  const parsed = safeParse(output);
  const action =
    typeof (input as Record<string, unknown>)?.action === 'string'
      ? ((input as Record<string, unknown>).action as string)
      : '';

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const connectUrl = typeof obj.connect_url === 'string' ? obj.connect_url : null;
    const expiresAt =
      typeof obj.expires_at === 'number' ? obj.expires_at : null;
    if (connectUrl) {
      const tool = typeof obj.tool === 'string' ? obj.tool : 'this tool';
      const minsLeft = expiresAt
        ? Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))
        : null;
      return (
        <div className="flex items-start gap-3 px-3 py-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Plug className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              Connect{' '}
              <span className="font-mono text-foreground/80">{tool}</span>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              qlaud hosts a one-time form for your credentials. The link
              expires{minsLeft != null ? ` in ${minsLeft} min` : ' in 10 min'}{' '}
              and never enters this chat or the model's context.
            </p>
            <button
              onClick={() => void openExternal(connectUrl)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <ExternalLink className="h-3 w-3" />
              Open connect form
            </button>
          </div>
        </div>
      );
    }
    if (typeof obj.status === 'string') {
      return (
        <div className="flex items-center gap-2 px-3 py-2">
          <StatusPill ok={obj.status === 'connected'} />
          <span className="text-[11.5px] text-foreground/85">
            {obj.status === 'connected'
              ? `Connected to ${describeTool(obj)}`
              : `Not connected to ${describeTool(obj)}`}
          </span>
        </div>
      );
    }
    if (action === 'list' && Array.isArray(obj.tools)) {
      return (
        <ul className="m-0 list-none divide-y divide-border/40 px-0 py-0">
          {(obj.tools as Array<Record<string, unknown>>).map((row, i) => (
            <li
              key={i}
              className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
            >
              <StatusPill ok={row.status === 'connected'} />
              <span className="font-mono text-foreground/85">
                {String(row.tool ?? row.name ?? '?')}
              </span>
              <span className="text-muted-foreground">
                — {String(row.status ?? '?')}
              </span>
            </li>
          ))}
        </ul>
      );
    }
  }
  return <RawJSONView output={output} isError={isError} />;
}

function describeTool(obj: Record<string, unknown>): string {
  if (typeof obj.tool === 'string') return obj.tool;
  if (typeof obj.name === 'string') return obj.name;
  return 'tool';
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={
        'inline-block h-2 w-2 shrink-0 rounded-full ' +
        (ok ? 'bg-emerald-500' : 'bg-amber-500')
      }
      aria-hidden
    />
  );
}

// ─── qlaud_search_tools ───────────────────────────────────────────

function SearchToolsView({ output, isError }: { output: string; isError: boolean }) {
  const parsed = safeParse(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <RawJSONView output={output} isError={isError} />;
  }
  const obj = parsed as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? obj.results : [];
  if (results.length === 0) {
    return (
      <div className="px-3 py-2 text-[11.5px] text-muted-foreground">
        No matching tools.
      </div>
    );
  }
  return (
    <ul className="m-0 list-none divide-y divide-border/40 px-0 py-0">
      {(results as Array<Record<string, unknown>>).map((r, i) => (
        <li key={i} className="flex items-start gap-2 px-3 py-2">
          <Search className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-mono text-foreground">
                {String(r.name ?? '?')}
              </span>
              {typeof r.kind === 'string' && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {r.kind}
                </span>
              )}
            </div>
            {typeof r.description === 'string' && (
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── qlaud_get_tool_schemas ──────────────────────────────────────

function GetSchemasView({ output, isError }: { output: string; isError: boolean }) {
  const parsed = safeParse(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <RawJSONView output={output} isError={isError} />;
  }
  const obj = parsed as Record<string, unknown>;
  const schemas = Array.isArray(obj.schemas) ? obj.schemas : [];
  if (schemas.length === 0) {
    return <RawJSONView output={output} isError={isError} />;
  }
  return (
    <ul className="m-0 list-none divide-y divide-border/40 px-0 py-0">
      {(schemas as Array<Record<string, unknown>>).map((s, i) => (
        <li key={i} className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            <span className="text-[12px] font-mono text-foreground">
              {String(s.name ?? '?')}
            </span>
          </div>
          {typeof s.description === 'string' && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {s.description}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── qlaud_multi_execute ──────────────────────────────────────────

function MultiExecuteView({ output, isError }: { output: string; isError: boolean }) {
  const parsed = safeParse(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <RawJSONView output={output} isError={isError} />;
  }
  const obj = parsed as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? obj.results : [];
  if (results.length === 0) {
    return <RawJSONView output={output} isError={isError} />;
  }
  return (
    <ul className="m-0 list-none divide-y divide-border/40 px-0 py-0">
      {(results as Array<Record<string, unknown>>).map((r, i) => {
        const ok = r.is_error !== true;
        const out =
          typeof r.output === 'string'
            ? r.output
            : JSON.stringify(r.output ?? null);
        const previewLen = ok ? 200 : 400;
        const preview =
          out.length > previewLen ? out.slice(0, previewLen - 1) + '…' : out;
        return (
          <li key={i} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <StatusPill ok={ok} />
              <span className="text-[12px] font-mono text-foreground">
                {String(r.tool ?? '?')}
              </span>
              {!ok && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
                  error
                </span>
              )}
            </div>
            <pre className="mt-1 m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-foreground/85">
              {preview}
            </pre>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Fallback ─────────────────────────────────────────────────────

function RawJSONView({ output, isError }: { output: string; isError?: boolean }) {
  const parsed = safeParse(output);
  const pretty = parsed != null ? JSON.stringify(parsed, null, 2) : output;
  return (
    <pre
      className={
        'm-0 max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed ' +
        (isError ? 'text-primary' : 'text-foreground/90')
      }
    >
      {pretty}
    </pre>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
