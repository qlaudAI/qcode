import { memo, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Info,
  Lightbulb,
  ShieldAlert,
  Sparkles,
  WrapText,
} from 'lucide-react';
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

export const Markdown = memo(function Markdown({
  source,
  streaming = false,
}: {
  source: string;
  /** When true, renders a blinking cursor at the end of the last
   *  block — the "live typing" affordance Claude.ai and Codex use
   *  while a turn is in progress. Implemented as a CSS pseudo-
   *  element on the last child so it lives in the natural inline
   *  flow of a paragraph (vs floating somewhere awkward). */
  streaming?: boolean;
}) {
  // Pre-process: turn bare workspace-relative `path:line` mentions
  // into markdown links pointing at a synthetic `qcode-file://`
  // scheme our link component recognizes. Skips matches inside
  // fenced code blocks (those start with ``` and end with ```)
  // because file paths inside code samples should stay literal.
  const processed = useMemo(() => annotateFileLinks(source), [source]);
  return (
    <div className={cn('qcode-prose', streaming && 'is-streaming')}>
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
  // optional :line suffix. Tight to avoid false positives on URLs,
  // version numbers, and unit-suffixed measurements ('1.4MB',
  // 'v2.1', '3.14', etc.).
  //
  // Two guards against the classic false positives:
  //   1. Lookahead `(?=[\w.-]*[a-zA-Z])` requires the filename body
  //      to contain at least one ASCII letter. Excludes pure-digit
  //      bodies like '1' (in '1.1') or '3' (in '3.14').
  //   2. Extension must START with a letter `[a-zA-Z][\w]{0,7}`.
  //      Excludes pure-numeric extensions like '0' (in 'v1.0') and
  //      keeps real ones (md, ts, tsx, jpeg, mp4).
  // Together these reject '1.1', '1.4MB', 'v1.0' while still matching
  // 'README.md', 'app.ts:42', './src/index.tsx', 'logo.svg'.
  const FILE_RE = /(?<![\w/[(])((?:\.\.?\/)?(?:[\w.-]+\/)*(?=[\w.-]*[a-zA-Z])[\w.-]+\.[a-zA-Z][\w]{0,7})(?::(\d+))?(?![\w/])/g;
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
  blockquote: ({ children, node }) => {
    // GitHub-style admonitions — `> [!NOTE]\n> body` etc. The marker
    // is parsed as a regular paragraph by remark-gfm, which means the
    // first child of the blockquote is a <p> whose first text node
    // starts with "[!KIND]". Detect that, render as a Callout.
    // Fall through to the default styled blockquote when nothing
    // matches so non-admonition quotes look the same as before.
    const kind = detectAdmonitionKind(node);
    if (kind) {
      return (
        <FadeBlock>
          <Callout kind={kind}>{stripAdmonitionMarker(children)}</Callout>
        </FadeBlock>
      );
    }
    return (
      <FadeBlock>
        <blockquote className="my-3 rounded-r-md border-l-2 border-primary/60 bg-muted/40 px-4 py-2 italic text-foreground/85">
          {children}
        </blockquote>
      </FadeBlock>
    );
  },
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

// Media extensions that we route to the inline Media right-rail
// view instead of (or alongside) the OS default app. The agent
// often promises "click to preview here" for these — make the
// click match the promise.
const MEDIA_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif',
  'mp4', 'webm', 'mov', 'm4v',
  'mp3', 'wav', 'ogg', 'flac', 'm4a',
]);

function isMediaPath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase();
  return ext ? MEDIA_EXTS.has(ext) : false;
}

function FileLink({ href, label }: { href: string; label: string }) {
  // qcode-file:src/foo.ts:42  →  { path: 'src/foo.ts', line: 42 }
  const target = href.replace(/^qcode-file:/, '');
  const lineMatch = /^(.+?):(\d+)$/.exec(target);
  const path = lineMatch ? lineMatch[1] : target;
  const line = lineMatch ? Number(lineMatch[2]) : null;
  const isMedia = isMediaPath(path);

  function open(e: React.MouseEvent) {
    e.preventDefault();
    const ws = getCurrentWorkspace();
    if (!ws) return;
    const abs = path.startsWith('/') ? path : `${ws.path}/${path}`;
    if (isMedia) {
      // Open the inline Media right-rail view so the user sees the
      // image/video/audio without leaving qcode. App.tsx listens
      // for this custom event and flips rightRailView='media'.
      // Best-effort: dispatch + open in OS default app too, so the
      // user gets the inline view AND a full-resolution viewer.
      window.dispatchEvent(
        new CustomEvent('qcode:open-media-preview', {
          detail: { absPath: abs, relPath: path },
        }),
      );
      return;
    }
    // Non-media files: open in OS default editor (existing behavior).
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

// ─── Admonitions (GitHub-style callouts) ──────────────────────────
//
// Recognized markers:
//   > [!NOTE]       informational
//   > [!TIP]        helpful aside
//   > [!IMPORTANT]  emphasized — yellow
//   > [!WARNING]    caution — amber
//   > [!CAUTION]    danger — red
//
// remark-gfm parses `> [!NOTE]\n> body` as a blockquote whose first
// child is a paragraph containing text "[!NOTE]" followed by the
// body. We sniff the AST for the marker and re-render as a Callout
// component with kind-appropriate color + icon. Keeps the original
// children tree (just minus the marker text node) so links, code,
// and other inline formatting inside the callout still render.

type AdmonitionKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ADMONITION_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;

function detectAdmonitionKind(node: unknown): AdmonitionKind | null {
  // Walk the AST: blockquote → first child <p> → first text node.
  const n = node as
    | {
        children?: Array<{
          tagName?: string;
          children?: Array<{ type?: string; value?: string }>;
        }>;
      }
    | undefined;
  const firstChild = n?.children?.find((c) => c?.tagName === 'p');
  const firstText = firstChild?.children?.[0];
  if (firstText?.type !== 'text' || typeof firstText.value !== 'string') {
    return null;
  }
  const m = ADMONITION_RE.exec(firstText.value);
  if (!m) return null;
  return m[1]!.toLowerCase() as AdmonitionKind;
}

// Remove the marker text node (and any leading whitespace) from the
// rendered children. The marker is always alone on its own line in
// GitHub's spec, which means after parsing it's the entirety of the
// first <p>'s first text node — but the first <p> may also contain
// the body text on subsequent lines. Easier than trying to surgically
// edit React elements: we just hide the first paragraph entirely
// when it contains ONLY the marker (which is the spec form), and
// pass the rest through. If a user did `> [!NOTE] body on same line`
// (out-of-spec), we strip just the marker prefix.
function stripAdmonitionMarker(children: React.ReactNode): React.ReactNode {
  const arr = Array.isArray(children) ? children : [children];
  return arr.map((child, i) => {
    if (typeof child !== 'object' || child === null) return child;
    // ReactMarkdown wraps text in <p>. The first <p> holds the
    // marker. If that <p>'s text is exactly the marker, drop the
    // whole <p>. Otherwise keep the rest of the children but
    // strip the marker prefix.
    const el = child as React.ReactElement<{ children?: React.ReactNode }>;
    if (i === 0 && el.props && Array.isArray(el.props.children)) {
      const inner = el.props.children;
      const first = inner[0];
      if (typeof first === 'string' && ADMONITION_RE.test(first)) {
        // Spec form: marker alone in the first paragraph, body
        // starts at children[1+]. Drop this paragraph.
        return null;
      }
      if (typeof first === 'string') {
        // Out-of-spec: marker followed by body on same line. Strip
        // marker prefix only.
        const stripped = first.replace(ADMONITION_RE, '').trimStart();
        if (stripped !== first) {
          return { ...el, props: { ...el.props, children: [stripped, ...inner.slice(1)] } };
        }
      }
    }
    return child;
  });
}

const ADMONITION_STYLES: Record<
  AdmonitionKind,
  {
    icon: typeof Info;
    label: string;
    /** Tailwind classes — left-bar color, soft tint background, label
     *  color, icon color. Picked to read clearly in both themes
     *  without screaming for attention; tuned to the existing
     *  qcode-prose palette. */
    border: string;
    bg: string;
    text: string;
    iconColor: string;
  }
> = {
  note: {
    icon: Info,
    label: 'Note',
    border: 'border-sky-500/60',
    bg: 'bg-sky-500/[0.06]',
    text: 'text-sky-600 dark:text-sky-300',
    iconColor: 'text-sky-500 dark:text-sky-400',
  },
  tip: {
    icon: Lightbulb,
    label: 'Tip',
    border: 'border-emerald-500/60',
    bg: 'bg-emerald-500/[0.06]',
    text: 'text-emerald-600 dark:text-emerald-300',
    iconColor: 'text-emerald-500 dark:text-emerald-400',
  },
  important: {
    icon: Sparkles,
    label: 'Important',
    border: 'border-violet-500/60',
    bg: 'bg-violet-500/[0.06]',
    text: 'text-violet-600 dark:text-violet-300',
    iconColor: 'text-violet-500 dark:text-violet-400',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    border: 'border-amber-500/60',
    bg: 'bg-amber-500/[0.07]',
    text: 'text-amber-600 dark:text-amber-300',
    iconColor: 'text-amber-500 dark:text-amber-400',
  },
  caution: {
    icon: ShieldAlert,
    label: 'Caution',
    border: 'border-rose-500/60',
    bg: 'bg-rose-500/[0.06]',
    text: 'text-rose-600 dark:text-rose-300',
    iconColor: 'text-rose-500 dark:text-rose-400',
  },
};

function Callout({
  kind,
  children,
}: {
  kind: AdmonitionKind;
  children: React.ReactNode;
}) {
  const style = ADMONITION_STYLES[kind];
  const Icon = style.icon;
  return (
    <div
      className={cn(
        'my-3 rounded-r-md border-l-[3px] py-2.5 pl-3.5 pr-4',
        style.border,
        style.bg,
      )}
      role="note"
      aria-label={style.label}
    >
      <div
        className={cn(
          'mb-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider',
          style.text,
        )}
      >
        <Icon className={cn('h-3.5 w-3.5', style.iconColor)} />
        {style.label}
      </div>
      <div className="text-[14px] leading-[1.6] text-foreground/90 [&_p]:my-1.5 [&_p:last-child]:mb-0 [&_p:first-child]:mt-0">
        {children}
      </div>
    </div>
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

// Cache: (theme|lang|code) -> rendered HTML. Theme is part of the
// key so a dark→light swap doesn't return stale tokens; the cache
// holds both variants side-by-side once both have been requested.
const HIGHLIGHT_CACHE = new Map<string, string>();

/** Reactively track the dark-mode class on <html> so code blocks
 *  re-highlight when the user flips themes. The MutationObserver
 *  is shared across all CodeBlock instances. */
function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const isDark = useIsDarkMode();
  const theme = isDark ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
  const langLabel = lang || 'text';
  // Filename detection — agent code blocks routinely lead with a
  // path comment (`// src/foo.ts`, `# foo.py`, `<!-- foo.html -->`,
  // `-- foo.sql`). Promote the path into the header so the user
  // doesn't need to read the first line to know what file they're
  // looking at. Anthropic Console + GitHub Gist do this and it makes
  // every snippet self-locating. The original line stays in the code
  // body — stripping would surprise users who copy the block.
  const filename = useMemo(() => detectFilename(langLabel, code), [langLabel, code]);
  const cacheKey = `${theme}|${langLabel}|${code}`;
  const [highlighted, setHighlighted] = useState<string | null>(() => {
    return HIGHLIGHT_CACHE.get(cacheKey) ?? null;
  });

  useEffect(() => {
    const cached = HIGHLIGHT_CACHE.get(cacheKey);
    if (cached) {
      setHighlighted(cached);
      return;
    }
    let cancelled = false;
    void getShiki().then(async (shiki) => {
      if (!shiki || cancelled) return;
      try {
        const html = await shiki.codeToHtml(code, { lang: langLabel, theme });
        if (cancelled) return;
        HIGHLIGHT_CACHE.set(cacheKey, html);
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
  }, [code, langLabel, theme, cacheKey]);

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <FadeBlock>
      <div className="group my-3 overflow-hidden rounded-lg border border-border/60 bg-[#0d1117] dark:bg-[#0d1117]">
        <header className="flex items-center justify-between gap-2 border-b border-white/5 bg-[#161b22] px-3.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/55">
              {langLabel}
            </span>
            {filename && (
              <>
                <span className="shrink-0 text-white/20" aria-hidden>·</span>
                <span
                  className="truncate font-mono text-[11.5px] text-white/75"
                  title={filename}
                >
                  {filename}
                </span>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setWrap((v) => !v)}
              className={cn(
                'flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider transition-all',
                wrap
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'text-white/55 hover:border-white/20 hover:bg-white/5 hover:text-white',
              )}
              aria-label={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
              aria-pressed={wrap}
              title={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
            >
              <WrapText className="h-3 w-3" />
              <span className="hidden sm:inline">{wrap ? 'Wrap' : 'Wrap'}</span>
            </button>
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
          </div>
        </header>
        <div
          className={cn(
            'qcode-shiki max-h-[420px] overflow-auto text-[12.5px] leading-[1.55]',
            // Soft wrap mode: pre wraps at the container's edge with
            // a hanging indent so wrapped continuations align under
            // the start of the line. Default keeps long lines on a
            // single horizontal-scroll line — matches every IDE's
            // off-state.
            wrap
              ? '[&_pre]:!whitespace-pre-wrap [&_pre]:!break-words'
              : '[&_pre]:!whitespace-pre',
          )}
        >
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

// First-line filename detection. Coding agents almost always lead a
// code block with a path comment so the user knows where the snippet
// goes. Recognize the common shapes per language family.
//
//   //  src/foo.ts                 (C-family: ts/js/rs/go/java/cpp/...)
//   #   foo.py                     (script: py/sh/rb/yaml/toml/...)
//   --  foo.sql                    (SQL)
//   <!-- foo.html -->              (HTML/XML)
//   /* foo.css */                  (CSS — covered by C-family below too)
//
// Returns null when nothing on the first line resembles a path. The
// path is plucked out (no leading comment marker) and rendered in the
// header. The line stays in the code body to preserve copy fidelity.
function detectFilename(lang: string, code: string): string | null {
  const firstLine = code.split('\n', 1)[0]?.trim();
  if (!firstLine) return null;
  // C-family double slash: "// path/to/foo.ts" possibly with trailing
  // comment text. Take the first token that looks like a path.
  // Hash-comment family: "# path/to/foo.py".
  // SQL: "-- path/to/foo.sql".
  // HTML: "<!-- path/to/foo.html -->".
  // CSS block comment: "/* path/to/foo.css */".
  const patterns: RegExp[] = [
    /^\/\/\s*([\w./@-]+\.[a-zA-Z0-9]{1,8})\b/,
    /^#\s*([\w./@-]+\.[a-zA-Z0-9]{1,8})\b/,
    /^--\s*([\w./@-]+\.[a-zA-Z0-9]{1,8})\b/,
    /^<!--\s*([\w./@-]+\.[a-zA-Z0-9]{1,8})\s*-->/,
    /^\/\*\s*([\w./@-]+\.[a-zA-Z0-9]{1,8})\s*\*\//,
  ];
  for (const re of patterns) {
    const m = re.exec(firstLine);
    if (m && m[1]) {
      // Sanity check: the path's extension should plausibly match
      // the language hint when both are present. Prevents false
      // positives like a python block whose first line happens to
      // mention ".tsx" in prose.
      const ext = m[1].split('.').pop()?.toLowerCase();
      if (ext && lang && lang !== 'text') {
        if (!extMatchesLang(ext, lang)) continue;
      }
      return m[1];
    }
  }
  return null;
}

// Loose extension/language compatibility. Returns true on a clear
// match, true on unknown languages (don't false-reject obscure langs),
// false on a clear mismatch. Used only as a tiebreaker in
// detectFilename so a few false negatives are fine.
function extMatchesLang(ext: string, lang: string): boolean {
  const l = lang.toLowerCase();
  const groups: Record<string, string[]> = {
    ts: ['ts', 'tsx', 'typescript'],
    tsx: ['ts', 'tsx', 'typescript'],
    js: ['js', 'jsx', 'javascript', 'mjs', 'cjs'],
    jsx: ['js', 'jsx', 'javascript'],
    mjs: ['js', 'mjs', 'javascript'],
    cjs: ['js', 'cjs', 'javascript'],
    py: ['py', 'python'],
    rs: ['rs', 'rust'],
    go: ['go'],
    java: ['java'],
    rb: ['rb', 'ruby'],
    php: ['php'],
    c: ['c'],
    cpp: ['cpp', 'cxx', 'cc', 'c++', 'h', 'hpp'],
    hpp: ['cpp', 'cxx', 'hpp', 'h'],
    h: ['c', 'cpp', 'h', 'hpp'],
    sql: ['sql'],
    yaml: ['yaml', 'yml'],
    yml: ['yaml', 'yml'],
    toml: ['toml'],
    json: ['json'],
    md: ['md', 'markdown'],
    sh: ['sh', 'bash', 'shell', 'zsh'],
    bash: ['sh', 'bash', 'shell'],
    css: ['css'],
    html: ['html', 'htm'],
    xml: ['xml', 'html'],
    docker: ['docker', 'dockerfile'],
    dockerfile: ['docker', 'dockerfile'],
  };
  const accepts = groups[ext];
  if (!accepts) return true; // unknown ext — let it through
  return accepts.includes(l);
}
