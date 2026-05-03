import { useState } from 'react';
import { Check, Copy, FileText } from 'lucide-react';

import { cn } from '../../../lib/cn';

// read_file output is the full file body. We render it with line
// numbers + a copy button + a soft cap so a 200KB file doesn't lock
// the chat. Path comes from the call's input.path.

const PREVIEW_LINE_CAP = 400;

export function ReadFileView({
  path,
  output,
}: {
  path?: string;
  output: string;
}) {
  const [copied, setCopied] = useState(false);
  const lines = output.split('\n');
  const truncated = lines.length > PREVIEW_LINE_CAP;
  const visible = truncated ? lines.slice(0, PREVIEW_LINE_CAP) : lines;

  function copy() {
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5">
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[11px] text-foreground/85">
          {path ?? '—'}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {lines.length} lines
        </span>
        <button
          onClick={copy}
          className={cn(
            'flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground',
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="max-h-72 overflow-auto bg-[#0a0a0a]">
        <pre className="m-0 grid grid-cols-[44px_1fr] font-mono text-[11.5px] leading-snug text-[#e0e0e0]">
          {visible.map((line, i) => (
            <Line key={i} no={i + 1} content={line} />
          ))}
        </pre>
        {truncated && (
          <div className="border-t border-white/10 px-3 py-1 text-[10px] text-white/50">
            …{lines.length - PREVIEW_LINE_CAP} more lines (use Copy to grab the whole file)
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ no, content }: { no: number; content: string }) {
  return (
    <>
      <span className="select-none border-r border-white/10 px-2 text-right tabular-nums text-white/30">
        {no}
      </span>
      <span className="overflow-x-auto whitespace-pre px-3">{content || ' '}</span>
    </>
  );
}
