// Skill-on-disk bundling — writes skill markdown files to
// ~/.qcode/skills/ so the agent can `Read` them on demand instead
// of carrying the full ~7-8k tokens in every system prompt.
//
// Pattern: skill catalog (a thin pointer) is always in the system
// prompt. When the user asks for matching work, the agent calls
// Read on the file path. File is cached by claude-code's Read tool
// implementation, so subsequent turns in the same session pay zero.
//
// Token budget impact: ~150-token pointer always-on vs 7-8k tokens
// always-on. ~95% reduction for users who don't trigger the skill,
// near-zero overhead for users who do (single read, then cached).

import { getKey } from './auth';
import { isTauri } from './tauri';
import { QLAUD_DEPLOY_CLOUDFLARE_SKILL } from './skills/deploy-cloudflare';
import { QLAUD_TOOLS_SKILL } from './skills/qlaud-tools';
import { QLAUD_VIDEO_CREATOR_SKILL } from './skills/video-creator';

const SKILLS_DIR_REL = '.qcode/skills';

// API origin for the skill catalog. Same base every other qlaud lib
// in qcode reads from. The endpoints live at /v1/skills (catalog) +
// /v1/skills/:slug (markdown body), added in qlaud_router commit
// for this alpha. Requires an authed qpk_ to read.
const EDGE_BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

// Mapping from local disk filename → server-side skill slug. Local
// filenames came first (qcode-side conventions: dash-case + .md);
// server slugs are short (matching the classifier registry). Server
// is now the source of truth for content. When a server slug exists
// we fetch + overwrite; when it doesn't, we fall back to the
// bundled markdown shipped with this build.
//
// All three are server-backed as of alpha.213 — the bundled markdown
// is now strictly a fallback for offline / pre-auth boots. Updates
// flow via `wrangler deploy` on the edge worker; next desktop boot
// picks them up.
const SERVER_SLUG_BY_FILE: Record<string, string | null> = {
  'video-creator.md': 'video',
  'qlaud-tools.md': 'tools',
  'deploy-cloudflare.md': 'deploy',
};

/** Idempotent — writes / refreshes the bundled skill markdown files
 *  to ~/.qcode/skills/. Safe to call on every app boot or every
 *  claude-code spawn; only writes when the file is missing or its
 *  content has drifted from what we ship in this build.
 *
 *  Returns the absolute paths of files written / verified, or null
 *  on web (no fs access).
 *
 *  Failure modes are LOGGED rather than silently swallowed (an
 *  earlier bug: tauri-plugin-fs path differences between Tauri 1
 *  and Tauri 2 caused the write to throw silently, leaving the
 *  skill pointer in the system prompt referencing files that
 *  didn't exist on disk — agent tried to Read them, got "File
 *  does not exist", and fell back to ad-hoc heuristics). */
export async function ensureSkillsOnDisk(): Promise<string[] | null> {
  if (!isTauri()) return null;
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const fs = await import('@tauri-apps/plugin-fs');
    const home = await homeDir();
    // Tauri's path APIs sometimes drop the trailing slash, sometimes
    // keep it. Normalize.
    const homeClean = home.replace(/\/+$/, '');
    const dir = `${homeClean}/${SKILLS_DIR_REL}`;
    let dirExists = false;
    try {
      dirExists = await fs.exists(dir);
    } catch (e) {
      console.warn('[skill-bundle] exists() check failed for', dir, e);
    }
    if (!dirExists) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (e) {
        console.error('[skill-bundle] mkdir failed for', dir, e);
        return null;
      }
    }
    const skills: Array<{ name: string; content: string }> = [
      { name: 'video-creator.md', content: QLAUD_VIDEO_CREATOR_SKILL },
      { name: 'qlaud-tools.md', content: QLAUD_TOOLS_SKILL },
      { name: 'deploy-cloudflare.md', content: QLAUD_DEPLOY_CLOUDFLARE_SKILL },
    ];

    // alpha.212: refresh each skill from the server when a mapping
    // exists. If the fetch succeeds, swap in the server body before
    // the write-if-changed pass below. Fetch failures (no auth, no
    // network, server miss) fall through silently — the bundled
    // body stays in place. No-op when the user hasn't signed in yet
    // (no key → skipped entirely).
    await refreshSkillsFromServer(skills);
    const written: string[] = [];
    for (const s of skills) {
      const path = `${dir}/${s.name}`;
      let needsWrite = true;
      try {
        if (await fs.exists(path)) {
          try {
            const current = await fs.readTextFile(path);
            if (current === s.content) needsWrite = false;
          } catch {
            /* read failed — overwrite */
          }
        }
      } catch (e) {
        console.warn('[skill-bundle] exists() check failed for', path, e);
      }
      if (needsWrite) {
        try {
          await fs.writeTextFile(path, s.content);
          console.log('[skill-bundle] wrote', path, `${s.content.length} chars`);
        } catch (e) {
          console.error('[skill-bundle] writeTextFile failed for', path, e);
          // Continue to the next skill — one failure shouldn't take
          // out the others.
          continue;
        }
      }
      written.push(path);
    }
    return written;
  } catch (e) {
    console.error('[skill-bundle] ensureSkillsOnDisk failed', e);
    return null;
  }
}

/** Fetch latest skill markdown from the server and mutate the
 *  provided skills array in place. Skills with no server mapping
 *  (qlaud-tools, deploy-cloudflare) are left at their bundled
 *  content. Skills with a mapping but a failed fetch fall back to
 *  bundled too — no-op rather than erase content.
 *
 *  Why mutate in place: keeps ensureSkillsOnDisk's flow simple —
 *  one pass writes whatever we have, server or bundled, with the
 *  same compare-content-then-write logic. The caller doesn't need
 *  to branch.
 *
 *  Auth: needs a qpk_ key (the endpoint requires apiKeyAuth). On
 *  first cold-boot before the user signs in, getKey() returns null
 *  and we skip entirely — bundled content stays, which is fine.
 *  Subsequent boots after sign-in pick up server updates. */
async function refreshSkillsFromServer(
  skills: Array<{ name: string; content: string }>,
): Promise<void> {
  const key = getKey();
  if (!key) {
    // No auth yet — skip the refresh, fall back to bundled. The
    // user will get server updates on the boot after they sign in.
    return;
  }
  await Promise.all(
    skills.map(async (s) => {
      const slug = SERVER_SLUG_BY_FILE[s.name];
      if (!slug) return; // No server source; keep bundled.
      try {
        // Short timeout — skill fetch is best-effort. If the edge
        // worker is slow or unreachable, fall back to bundled
        // rather than block the boot indefinitely.
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${EDGE_BASE}/v1/skills/${slug}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'text/markdown',
          },
          signal: ctl.signal,
        });
        clearTimeout(t);
        if (!r.ok) return; // 401/404/5xx — keep bundled.
        const body = await r.text();
        if (!body || body.length < 100) return; // Sanity guard.
        s.content = body;
      } catch {
        // Network error, abort, parse failure — silent. Bundled
        // content stays.
      }
    }),
  );
}

/** Short markdown snippet appended to claude-code's system prompt.
 *  Tells the agent which skills exist on disk + when to load them.
 *
 *  Three skills today:
 *    qlaud-tools         — discover/call any external tool via the
 *                          meta-tool REST API (search-then-call pattern).
 *                          Covers builtins, MCPs, registered tools.
 *    video-creator       — full video editor workflow (Remotion +
 *                          ffmpeg + asset sourcing + voiceover).
 *    deploy-cloudflare   — ship the project to Cloudflare. Two
 *                          modes: qlaud-managed ({slug}.qlaud.app +
 *                          provisioned D1) or BYO Cloudflare via
 *                          wrangler against the user's own account.
 *
 *  Token cost: ~350 tokens for the pointer block. Tiny vs the
 *  ~20k tokens the full skills would add to every system prompt
 *  if we inlined them. */
export function buildSkillPointer(homeDir: string): string {
  return `qcode skills available on disk — load with the Read tool when the user's request matches:

  ${homeDir}/${SKILLS_DIR_REL}/qlaud-tools.md
    Read when the user asks about external systems: Slack, Linear,
    GitHub, Stripe, Notion, Atlassian, web search, send email, SMS,
    or anything else that might need an integration. Teaches the
    search-then-call pattern via /v1/tools/search → /v1/tools/schemas
    → /v1/tools/execute. Covers per-user MCP credential management
    via /v1/connections. Use this BEFORE asking the user "do you
    have X connected?" — search will tell you.

  ${homeDir}/${SKILLS_DIR_REL}/video-creator.md
    Read when the user wants video creation: explainer / faceless
    YouTube / ad / reel / SaaS demo / documentary. Teaches the full
    workflow (script → voiceover → storyboard → stock+AI sourcing
    → Remotion+ffmpeg → polished MP4 → optional cloud sync).

  ${homeDir}/${SKILLS_DIR_REL}/deploy-cloudflare.md
    Read when the user says "deploy", "publish", "ship it", "go
    live", or asks for a live URL. Two modes: qlaud-managed
    (default for non-technical users — provisions everything under
    {slug}.qlaud.app) and BYO Cloudflare (uses the user's own CF
    account via wrangler). Detects framework (Next / Vite / Worker /
    static), provisions D1/R2/KV bindings, sets secrets, custom
    domains. Records the user's choice once at .qcode/deploy.json.

DO NOT preload these — read only when the user's request actually fits the skill. Skills you read once are cached for the rest of this session.`;
}
