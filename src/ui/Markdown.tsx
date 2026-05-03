import { memo, useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileText, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion } from 'motion/react';
import type { Components } from 'react-markdown';

import { cn } from '../lib/cn';
import { openExternal } from '../lib/tauri';
import { getCurrentWorkspace } from '../lib/workspace';

// Polished markdown rendering for the chat surface. Targets the
// quality bar set by Claude.ai and the Codex desktop app:
//
//   - GFM (tables, task lists, strikethrough, autolinks) via
//     remark-gfm — the assistant emits all of these and the old
//     hand-rolled parser silently dropped them.
//   - Shiki syntax highlighting for code blocks with language
//     header, copy button, and a max-height scroll cap. Loaded
//     lazily on first code block so the cold path doesn't pay
//     the highlighter weight.
//   - Smooth fade-in for newly-streamed blocks via motion. Subtle
//     enough to not feel chatty; just removes the abrupt pop-in.
//   - Inline file paths (`src/foo.ts:42`) become click-to-open
//     buttons that hand off to the user's default editor via
//     openExternal — same UX the old component had, ported.
//
// Streaming: the component re-parses on each `source` change, but
// each block reducer is memoized by its own content. Shiki
// highlights are cached per (lang, code) pair so a block that
// finishes streaming doesn't re-highlight on every parent re-render.
//
// Safety: react-markdown disables raw HTML by default. shiki output
// is HTML but shiki escapes its input — the only "unsafe" route is
// inserting shiki's themed tokens, which are static markup. We do
// NOT enable rehype-raw or any HTML pass-through.

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  // Pre-process: turn bare workspace-relative `path:line` mentions
  // into markdown links pointing at a synthetic `qcode-file://`
  // scheme our link component recognizes. Skips matches inside
  // fenced code blocks (those start with ``` and end with ```)
  // because file paths inside code samples should stay literal.
  const processed = useMemo(() => annotateFileLinks(source), [source]);
  return (
    <div className="qcode-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {processed}
      </ReactMarkdown>
    </div>
  );
});

// ─── File-link pre-processor ─────────────────────────────────────
//
// The agent often references files like `src/lib/agent.ts:42`.
// Transform those into markdown links with a custom href scheme so
// our `a` component can render them as click-to-open chips.
//
// Skips any text inside fenced code blocks (delimited by triple
// backticks) so paths shown in code samples stay literal.
function annotateFileLinks(source: string): string {
  // Match: optional ./ then segment(s) ending in .<ext> with
  // optional :line suffix. Tight to avoid false positives on URLs
  // and URL-looking prose. Only triggers on tokens with a clear
  // file extension.
  const FILE_RE = /(?<![\w/[(])((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8})(?::(\d+))?(?![\w/])/g;
  // Split into fenced/non-fenced segments. Fenced regions pass
  // through verbatim.
  const parts = source.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced — leave alone
      return part.replace(FILE_RE, (match, p, line) => {
        // Avoid double-wrapping if it's already a markdown link
        // target — a clumsy heuristic but cheap.
        return `[${match}](qcode-file:${p}${line ? ':' + line : ''})`;
      });
    })
    .join('');
}

// ─── Component overrides ──────────────────────────────────────────

const MARKDOWN_COMPONENTS: Components = {
  // Headings — visual hierarchy without going huge. Chat bubbles
  // shouldn't have giant h1s; we cap below the page chrome.
  h1: ({ children }) => (
    <FadeBlock>
      <h1 className="mt-5 mb-3 text-[17px] font-semibold tracking-tight text-foreground first:mt-0">
        {children}
      </h1>
    </FadeBlock>
  ),
  h2: ({ children }) => (
    <FadeBlock>
      <h2 className="mt-5 mb-2.5 text-[15.5px] font-semibold tracking-tight text-foreground first:mt-0">
        {children}
      </h2>
    </FadeBlock>
  ),
  h3: ({ children }) => (
    <FadeBlock>
      <h3 className="mt-4 mb-2 text-[14.5px] font-semibold tracking-tight text-foreground first:mt-0">
        {children}
      </h3>
    </FadeBlock>
  ),
  h4: ({ children }) => (
    <FadeBlock>
      <h4 className="mt-3.5 mb-1.5 text-[13.5px] font-semibold tracking-tight text-foreground first:mt-0">
        {children}
      </h4>
    </FadeBlock>
  ),
  h5: ({ children }) => (
    <FadeBlock>
      <h5 className="mt-3 mb-1 text-[13px] font-semibold tracking-tight text-foreground/90 first:mt-0">
        {children}
      </h5>
    </FadeBlock>
  ),
  h6: ({ children }) => (
    <FadeBlock>
      <h6 className="mt-3 mb-1 text-[12.5px] font-semibold uppercase tracking-wider text-muted-foreground first:mt-0">
        {children}
      </h6>
    </FadeBlock>
  ),
  p: ({ children }) => (
    <FadeBlock>
      <p className="text-[14px] leading-[1.65] text-foreground/90 [&:not(:first-child)]:mt-3">
        {children}
      </p>
    </FadeBlock>
  ),
  ul: ({ children }) => (
    <FadeBlock>
      <ul className="my-2 list-none space-y-1.5 pl-1 marker:text-foreground/40">
        {children}
      </ul>
    </FadeBlock>
  ),
  ol: ({ children }) => (
    <FadeBlock>
      <ol className="my-2 list-decimal space-y-1.5 pl-5 text-foreground/90 marker:font-mono marker:text-[12px] marker:text-foreground/50">
        {children}
      </ol>
    </FadeBlock>
  ),
  li: ({ children, ...props }) => {
    // Task lists use a `[ ]`/`[x]` checkbox node injected by remark-gfm;
    // detect via the className react-markdown adds.
    const className = (props as { className?: string }).className;
    if (className === 'task-list-item') {
      return <li className="flex items-start gap-2 text-[14px] leading-[1.65] text-foreground/90 [&_input]:mt-1 [&_input]:flex-shrink-0">{children}</li>;
    }
    return (
      <li className="relative pl-5 text-[14px] leading-[1.6] text-foreground/90 before:absolute before:left-1 before:top-[0.6em] before:h-[3px] before:w-[3px] before:rounded-full before:bg-foreground/40">
        {children}
      </li>
    );
  },
  blockquote: ({ children }) => (
    <FadeBlock>
      <blockquote className="my-3 rounded-r-md border-l-2 border-primary/60 bg-muted/40 px-4 py-2 italic text-foreground/85">
        {children}
      </blockquote>
    </FadeBlock>
  ),
  hr: () => (
    <FadeBlock>
      <hr className="my-5 border-0 border-t border-border/60" />
    </FadeBlock>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-foreground/95">{children}</em>,
  del: ({ children }) => (
    <del className="text-muted-foreground decoration-foreground/30">{children}</del>
  ),
  a: ({ href, children }) => {
    if (href?.startsWith('qcode-file:')) {
      return <FileLink href={href} label={String(children)} />;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-baseline gap-0.5 text-primary underline decoration-primary/40 underline-offset-[3px] transition-colors hover:decoration-primary"
        onClick={(e) => {
          // In Tauri context, route external links through the OS
          // shell so they don't open inside the qcode webview.
          if (href && /^https?:\/\//.test(href)) {
            e.preventDefault();
            void openExternal(href);
          }
        }}
      >
        {children}
        <ExternalLink className="h-2.5 w-2.5 self-center opacity-50" />
      </a>
    );
  },
  // Code rendering — react-markdown 10 dropped the `inline` prop,
  // so we detect inline by looking at the className: fenced blocks
  // get `language-<lang>` from remark, inline code does not.
  code: (props) => {
    const { className, children } = props as { className?: string; children: React.ReactNode };
    const langMatch = /language-([\w-]+)/.exec(className ?? '');
    if (!langMatch) {
      return (
        <code className="rounded-[5px] border border-border/50 bg-muted/70 px-[5px] py-px font-mono text-[12.5px] tracking-tight text-foreground/95">
          {children}
        </code>
      );
    }
    return <CodeBlock lang={langMatch[1]} code={String(children).replace(/\n$/, '')} />;
  },
  // react-markdown wraps code in <pre>; we render our own pre via
  // CodeBlock so suppress the default wrapper.
  pre: ({ children }) => <>{children}</>,
  // Tables — sticky header, hover row, soft borders.
  table: ({ children }) => (
    <FadeBlock>
      <div className="my-3 overflow-x-auto rounded-md border border-border/60">
        <table className="w-full border-collapse text-[13px]">
          {children}
        </table>
      </div>
    </FadeBlock>
  ),
  thead: ({ children }) => (
    <thead className="bg-muted/60 text-[12px] uppercase tracking-wider text-foreground/70">
      {children}
    </thead>
  ),
  tbody: ({ children }) => <tbody className="divide-y divide-border/40">{children}</tbody>,
  tr: ({ children }) => (
    <tr className="transition-colors hover:bg-muted/30">{children}</tr>
  ),
  th: ({ children, style }) => (
    <th
      className="px-3 py-2 text-left font-semibold"
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="px-3 py-2 align-top text-foreground/90" style={style}>
      {children}
    </td>
  ),
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ''}
      className="my-3 max-w-full rounded-md border border-border/60"
      loading="lazy"
    />
  ),
};

// ─── Animated block wrapper ───────────────────────────────────────
//
// motion's `initial` only fires on first mount, so streaming
// re-renders don't re-animate. Each block fades in once when the
// markdown reducer first emits it.
function FadeBlock({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

// ─── File link chip ──────────────────────────────────────────────
//
// Triggered by our pre-processor when the assistant emits a path.
// Hands off to openExternal so the user's default editor opens the
// file. In browser-mode (no Tauri), gracefully degrades to a span.

function FileLink({ href, label }: { href: string; label: string }) {
  // qcode-file:src/foo.ts:42  →  { path: 'src/foo.ts', line: 42 }
  const target = href.replace(/^qcode-file:/, '');
  const lineMatch = /^(.+?):(\d+)$/.exec(target);
  const path = lineMatch ? lineMatch[1] : target;
  const line = lineMatch ? Number(lineMatch[2]) : null;

  function open(e: React.MouseEvent) {
    e.preventDefault();
    const ws = getCurrentWorkspace();
    if (!ws) return;
    const abs = path.startsWith('/') ? path : `${ws.path}/${path}`;
    void openExternal(abs);
  }

  return (
    <button
      onClick={open}
      title={`Open ${label}`}
      className="group inline-flex items-baseline gap-1 rounded border border-border/50 bg-muted/50 px-1.5 py-px font-mono text-[12px] tracking-tight text-foreground/90 transition-all hover:border-primary/60 hover:bg-primary/5 hover:text-foreground"
    >
      <FileText className="h-3 w-3 self-center text-muted-foreground transition-colors group-hover:text-primary" />
      {path}
      {line !== null && <span className="text-muted-foreground/70">:{line}</span>}
    </button>
  );
}

// ─── Code block with shiki ───────────────────────────────────────

const SHIKI_THEME_DARK = 'github-dark-default';
const SHIKI_THEME_LIGHT = 'github-light-default';
// Languages we explicitly preload; everything else falls back to
// 'text' (no highlighting). Tradeoff: smaller bundle, snappy first
// paint, vs full universal coverage. Adjust as needs evolve.
const SHIKI_LANGS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'py', 'python',
  'rs', 'rust', 'go', 'sql', 'yaml', 'yml', 'toml', 'html', 'css',
  'md', 'markdown', 'diff', 'docker', 'dockerfile', 'java', 'c', 'cpp', 'rb', 'php',
] as const;

let shikiPromise: Promise<{ codeToHtml: (code: string, opts: { lang: string; theme: string }) => Promise<string> } | null> | null = null;

function getShiki() {
  if (!shikiPromise) {
    shikiPromise = import('shiki')
      .then(async (m) => {
        const highlighter = await m.createHighlighter({
          themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
          langs: SHIKI_LANGS as unknown as string[],
        });
        return {
          codeToHtml: async (code: string, opts: { lang: string; theme: string }) => {
            const safeLang = highlighter.getLoadedLanguages().includes(opts.lang as never)
              ? opts.lang
              : 'text';
            return highlighter.codeToHtml(code, { lang: safeLang as never, theme: opts.theme });
          },
        };
      })
      .catch(() => null);
  }
  return shikiPromise;
}

// Cache: (lang|code) -> rendered HTML. Avoids re-highlighting the
// same block on every parent re-render (a streaming text delta in
// the same message triggers a Markdown re-parse, which would
// otherwise re-highlight every prior code block).
const HIGHLIGHT_CACHE = new Map<string, string>();

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(() => {
    const cached = HIGHLIGHT_CACHE.get(`${lang}|${code}`);
    return cached ?? null;
  });
  const langLabel = lang || 'text';

  useEffect(() => {
    const key = `${lang}|${code}`;
    const cached = HIGHLIGHT_CACHE.get(key);
    if (cached) {
      setHighlighted(cached);
      return;
    }
    let cancelled = false;
    void getShiki().then(async (shiki) => {
      if (!shiki || cancelled) return;
      try {
        const isDark = document.documentElement.classList.contains('dark');
        const theme = isDark ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
        const html = await shiki.codeToHtml(code, { lang: langLabel, theme });
        if (cancelled) return;
        HIGHLIGHT_CACHE.set(key, html);
        // Cap cache so a long session doesn't grow unbounded.
        if (HIGHLIGHT_CACHE.size > 200) {
          const firstKey = HIGHLIGHT_CACHE.keys().next().value;
          if (firstKey) HIGHLIGHT_CACHE.delete(firstKey);
        }
        setHighlighted(html);
      } catch {
        // Highlighter unavailable for this lang — fall back to plain.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, langLabel]);

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <FadeBlock>
      <div className="group my-3 overflow-hidden rounded-lg border border-border/60 bg-[#0d1117] dark:bg-[#0d1117]">
        <header className="flex items-center justify-between border-b border-white/5 bg-[#161b22] px-3.5 py-1.5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/55">
            {langLabel}
          </span>
          <button
            onClick={copy}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider transition-all',
              copied
                ? 'border-emerald-400/30 text-emerald-300'
                : 'text-white/55 hover:border-white/20 hover:bg-white/5 hover:text-white',
            )}
            aria-label={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </header>
        <div className="qcode-shiki max-h-[420px] overflow-auto text-[12.5px] leading-[1.55]">
          {highlighted ? (
            <div
              className="[&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:px-4 [&_pre]:py-3 [&_pre]:font-mono"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          ) : (
            <pre className="m-0 px-4 py-3 font-mono text-[#c9d1d9]">{code}</pre>
          )}
        </div>
      </div>
    </FadeBlock>
  );
}
