import { File } from 'lucide-react';

// glob emits one path per line plus optional truncation trailer.
// Looks the same whether 1 match or 500.

export function GlobView({ output }: { output: string }) {
  const lines = output.split('\n').filter((l) => l.length);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '(no matches)')) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
        No matches.
      </div>
    );
  }
  const paths: string[] = [];
  let trailer: string | null = null;
  for (const line of lines) {
    if (line.startsWith('…')) trailer = line;
    else paths.push(line);
  }
  return (
    <div className="py-1.5">
      <ul>
        {paths.map((p, i) => (
          <li
            key={i}
            className="flex items-center gap-1.5 px-3 py-0.5 text-[11.5px]"
          >
            <File className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono text-foreground/90">{p}</span>
          </li>
        ))}
      </ul>
      {trailer && (
        <p className="mt-1 px-3 py-1 text-[10.5px] text-muted-foreground">
          {trailer}
        </p>
      )}
    </div>
  );
}
