import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '../lib/cn';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';

// Renders a parsed markdown block tree. Code blocks get a copy
// button + language label; everything else is straight text styling.
//
// Safety: we never set innerHTML. All rendering goes through React,
// which escapes by default. Links default to target="_blank" with
// noopener/noreferrer — the agent runs locally but the URL it
// emits could be anything.

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.type === 'heading') {
    const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3') as
      | 'h1'
      | 'h2'
      | 'h3';
    const classes = {
      1: 'text-base font-semibold tracking-tight',
      2: 'text-[15px] font-semibold tracking-tight',
      3: 'text-[14px] font-semibold tracking-tight',
    } as const;
    return <Tag className={classes[block.level]}>{block.text}</Tag>;
  }
  if (block.type === 'code_block') {
    return <CodeBlock lang={block.lang} code={block.code} />;
  }
  if (block.type === 'list') {
    if (block.ordered) {
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines tokens={item} />
            </li>
          ))}
        </ol>
      );
    }
    return (
      <ul className="list-disc space-y-1 pl-5">
        {block.items.map((item, i) => (
          <li key={i}>
            <Inlines tokens={item} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="leading-relaxed">
      <Inlines tokens={block.tokens} />
    </p>
  );
}

function Inlines({ tokens }: { tokens: Inline[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <InlineNode key={i} node={t} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  if (node.type === 'text') return <>{node.text}</>;
  if (node.type === 'code') {
    return (
      <code className="rounded border border-border/60 bg-muted/60 px-1 py-px font-mono text-[12.5px] text-foreground">
        {node.text}
      </code>
    );
  }
  if (node.type === 'bold') {
    return (
      <strong className="font-semibold">
        <Inlines tokens={node.tokens} />
      </strong>
    );
  }
  if (node.type === 'italic') {
    return (
      <em className="italic">
        <Inlines tokens={node.tokens} />
      </em>
    );
  }
  return (
    <a
      href={node.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline-offset-2 hover:underline"
    >
      <Inlines tokens={node.tokens} />
    </a>
  );
}

// ─── Code block ─────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-[#0a0a0a] text-foreground">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
          {lang || 'text'}
        </span>
        <button
          onClick={copy}
          className={cn(
            'flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[10px] text-white/60 transition-colors hover:border-white/20 hover:text-white',
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 max-h-[400px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-snug text-[#e0e0e0]">
        {code}
      </pre>
    </div>
  );
}
