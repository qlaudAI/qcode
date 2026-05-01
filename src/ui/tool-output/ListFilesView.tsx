import { File, Folder } from 'lucide-react';

// list_files emits one entry per line; directories end with `/`. We
// split, classify, and render with native icons. Truncation trailers
// like "…(N more entries truncated)" pass through as a footer note.

export function ListFilesView({ output }: { output: string }) {
  const { entries, trailer } = parse(output);
  if (entries.length === 0) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
        Empty directory.
      </div>
    );
  }
  return (
    <div className="py-1.5">
      <ul className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
        {entries.map((e, i) => (
          <li
            key={i}
            className="flex items-center gap-1.5 px-3 py-0.5 text-[11.5px]"
          >
            {e.isDir ? (
              <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <File className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate text-foreground/90">{e.name}</span>
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

function parse(output: string): {
  entries: { name: string; isDir: boolean }[];
  trailer: string | null;
} {
  const lines = output.split('\n').filter((l) => l.length);
  const entries: { name: string; isDir: boolean }[] = [];
  let trailer: string | null = null;
  for (const line of lines) {
    if (line.startsWith('…')) {
      trailer = line;
      continue;
    }
    const isDir = line.endsWith('/');
    entries.push({ name: isDir ? line.slice(0, -1) : line, isDir });
  }
  // Directories first, alpha within.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries, trailer };
}
