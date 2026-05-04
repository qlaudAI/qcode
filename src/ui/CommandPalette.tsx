import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CornerDownLeft,
  FileText,
  FolderOpen,
  LogOut,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { fuzzyScore } from '../lib/fuzzy';
import { useTextModels } from '../lib/queries';
import { listAllFiles, type Workspace } from '../lib/workspace';

// Cmd-K palette. macOS Spotlight / VS Code-style: search files in
// the open workspace + a curated list of actions. Keyboard nav with
// up/down/enter; Esc closes.
//
// File index is loaded lazily on first open and cached in a ref —
// re-opening is instant. Invalidates on workspace change.

export type Action = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Used to widen fuzzy match — synonyms etc. */
  keywords?: string;
  run: () => void;
};

type Item =
  | { kind: 'action'; action: Action }
  | { kind: 'file'; path: string }
  | { kind: 'model'; slug: string; label: string; provider: string };

type Props = {
  open: boolean;
  onClose: () => void;
  workspace: Workspace | null;
  onOpenFolder: () => void;
  onNewChat: () => void;
  onSwitchModel: (slug: string) => void;
  onOpenSettings: () => void;
  onRefreshBalance: () => void;
  onSignOut: () => void;
};

export function CommandPalette(props: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesLoadedFor = useRef<string | null>(null);
  // Live catalog drives the model fuzzy-match. Stays current with
  // qlaud's catalog without a qcode rebuild.
  const models = useTextModels();

  // Load (and cache) file list on first open per workspace.
  useEffect(() => {
    if (!props.open) return;
    if (filesLoadedFor.current === props.workspace?.path) return;
    filesLoadedFor.current = props.workspace?.path ?? null;
    if (!props.workspace) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void listAllFiles(props.workspace.path).then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.workspace]);

  // Reset query + focus when opening.
  useEffect(() => {
    if (props.open) {
      setQuery('');
      setActive(0);
      // Defer focus so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [props.open]);

  const actions = useMemo<Action[]>(
    () => [
      {
        id: 'new_chat',
        label: 'New chat',
        hint: '⌘N',
        icon: MessageSquarePlus,
        keywords: 'thread conversation start',
        run: props.onNewChat,
      },
      {
        id: 'open_folder',
        label: props.workspace ? 'Switch folder' : 'Open folder',
        hint: '⌘O',
        icon: FolderOpen,
        keywords: 'workspace project',
        run: props.onOpenFolder,
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: '⌘,',
        icon: SettingsIcon,
        keywords: 'preferences config',
        run: props.onOpenSettings,
      },
      {
        id: 'refresh_balance',
        label: 'Refresh wallet balance',
        icon: RefreshCw,
        keywords: 'spend qlaud money',
        run: props.onRefreshBalance,
      },
      {
        id: 'sign_out',
        label: 'Sign out',
        icon: LogOut,
        keywords: 'logout',
        run: props.onSignOut,
      },
    ],
    [props],
  );

  const items = useMemo<Item[]>(() => {
    if (!query.trim()) {
      // Empty query → recent actions + first 30 files.
      return [
        ...actions.map<Item>((a) => ({ kind: 'action', action: a })),
        ...files.slice(0, 30).map<Item>((p) => ({ kind: 'file', path: p })),
      ];
    }
    const scored: Array<{ item: Item; score: number }> = [];
    for (const a of actions) {
      const s = fuzzyScore(query, `${a.label} ${a.keywords ?? ''}`);
      if (s !== null) scored.push({ item: { kind: 'action', action: a }, score: s + 5 });
    }
    for (const m of models) {
      const s = fuzzyScore(query, `${m.label} ${m.provider}`);
      if (s !== null)
        scored.push({
          item: { kind: 'model', slug: m.slug, label: m.label, provider: m.provider },
          score: s,
        });
    }
    for (const p of files) {
      const s = fuzzyScore(query, p);
      if (s !== null) scored.push({ item: { kind: 'file', path: p }, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((x) => x.item);
  }, [query, actions, files, models]);

  // Clamp active when items change.
  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items, active]);

  function runItem(item: Item) {
    if (item.kind === 'action') item.action.run();
    else if (item.kind === 'model') props.onSwitchModel(item.slug);
    else if (item.kind === 'file') {
      // Future: opening a file in qcode would invoke read_file in
      // the active thread. For v0 we stub to "open in editor" via
      // shell.open since that's the existing FileLink behavior.
      const ws = props.workspace;
      if (ws) {
        void import('../lib/tauri').then((m) => m.openExternal(`${ws.path}/${item.path}`));
      }
    }
    props.onClose();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) runItem(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/15 pt-[14vh] backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="w-[600px] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-background shadow-[0_4px_16px_rgba(0,0,0,0.06),0_24px_64px_rgba(0,0,0,0.18)]"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search files, models, or actions…"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            esc
          </span>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No matches.
            </li>
          ) : (
            items.map((item, i) => (
              <ItemRow
                key={i}
                item={item}
                active={i === active}
                onPick={() => runItem(item)}
                onHover={() => setActive(i)}
              />
            ))
          )}
        </ul>

        <Footer activeKind={items[active]?.kind} />
      </div>
    </div>
  );
}

function ItemRow({
  item,
  active,
  onPick,
  onHover,
}: {
  item: Item;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  if (item.kind === 'action') {
    const Icon = item.action.icon;
    return (
      <li>
        <button
          onMouseEnter={onHover}
          onClick={onPick}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
            active && 'bg-muted/70',
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm">{item.action.label}</span>
          {item.action.hint && (
            <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {item.action.hint}
            </span>
          )}
        </button>
      </li>
    );
  }
  if (item.kind === 'file') {
    return (
      <li>
        <button
          onMouseEnter={onHover}
          onClick={onPick}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
            active && 'bg-muted/70',
          )}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[12.5px] text-foreground/90">
            {item.path}
          </span>
          <ArrowRight className="ml-auto h-3 w-3 text-muted-foreground/50" />
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        onMouseEnter={onHover}
        onClick={onPick}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
          active && 'bg-muted/70',
        )}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm">
          Switch model · <span className="font-medium">{item.label}</span>
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {item.provider}
        </span>
      </button>
    </li>
  );
}

function Footer({ activeKind }: { activeKind: Item['kind'] | undefined }) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 bg-muted/20 px-4 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <CornerDownLeft className="h-3 w-3" />
        {activeKind === 'file'
          ? 'open in editor'
          : activeKind === 'model'
            ? 'switch model'
            : 'run'}
      </span>
      <span className="flex items-center gap-3">
        <kbd className="rounded border border-border bg-background px-1 font-mono">↑↓</kbd>
        navigate
      </span>
    </div>
  );
}
