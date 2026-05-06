import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';

import { cn } from '../lib/cn';
import { readDir, type FileNode } from '../lib/workspace';
import { useWorkspaceRevision } from '../lib/workspace-revision';

// Lazy-expanding tree. Each folder loads its children on first
// expand; we cache them in component state so collapsing + reopening
// is instant. Folders unsorted come back sort-stable (dirs first,
// then alpha) from workspace.readDir.

type TreeState = {
  expanded: Set<string>;
  children: Map<string, FileNode[]>;
};

export function FileTree({ rootPath }: { rootPath: string }) {
  const [state, setState] = useState<TreeState>(() => ({
    expanded: new Set([rootPath]),
    children: new Map(),
  }));

  const ensureChildren = useCallback(
    async (path: string) => {
      if (state.children.has(path)) return;
      const items = await readDir(path);
      setState((s) => {
        const next = new Map(s.children);
        next.set(path, items);
        return { ...s, children: next };
      });
    },
    [state.children],
  );

  useEffect(() => {
    void ensureChildren(rootPath);
  }, [rootPath, ensureChildren]);

  // Workspace revision: bumps when the agent does anything that
  // might modify files. Re-fetch children for every currently-
  // expanded path so newly-created files / directories appear
  // without the user manually collapsing + reopening. Cheap —
  // typically only 2-5 expanded paths at any time.
  const workspaceRev = useWorkspaceRevision();
  useEffect(() => {
    if (workspaceRev === 0) return; // skip the initial mount
    let cancelled = false;
    const expanded = Array.from(state.expanded);
    void Promise.all(
      expanded.map(async (path) => {
        try {
          const items = await readDir(path);
          return [path, items] as const;
        } catch {
          return [path, [] as FileNode[]] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setState((s) => {
        const next = new Map(s.children);
        for (const [path, items] of results) next.set(path, items);
        return { ...s, children: next };
      });
    });
    return () => {
      cancelled = true;
    };
    // state.expanded intentionally excluded from deps — including
    // it would cause re-fetches on every toggle, which already
    // gets a targeted ensureChildren call. We ONLY want
    // revision-driven refresh here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRev]);

  function toggle(path: string) {
    setState((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...s, expanded: next };
    });
    void ensureChildren(path);
  }

  return (
    <div className="text-[13px] leading-snug">
      <Node
        node={{ name: rootName(rootPath), path: rootPath, isDir: true }}
        depth={0}
        expanded={state.expanded}
        children_={state.children}
        onToggle={toggle}
      />
    </div>
  );
}

function Node({
  node,
  depth,
  expanded,
  children_,
  onToggle,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  children_: Map<string, FileNode[]>;
  onToggle: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const items = isOpen ? children_.get(node.path) : undefined;
  const Icon = node.isDir ? (isOpen ? FolderOpen : Folder) : FileText;

  return (
    <div>
      <button
        onClick={() => (node.isDir ? onToggle(node.path) : undefined)}
        className={cn(
          'group flex w-full items-center gap-1 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted/60',
          !node.isDir && 'cursor-default',
        )}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        {node.isDir ? (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            node.isDir ? 'text-muted-foreground' : 'text-muted-foreground/70',
          )}
        />
        <span className="truncate text-foreground/90">{node.name}</span>
      </button>
      {isOpen && items && (
        <div>
          {items.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              children_={children_}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function rootName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}
