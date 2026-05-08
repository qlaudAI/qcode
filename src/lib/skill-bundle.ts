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

import { isTauri } from './tauri';
import { QLAUD_DEPLOY_CLOUDFLARE_SKILL } from './skills/deploy-cloudflare';
import { QLAUD_TOOLS_SKILL } from './skills/qlaud-tools';
import { QLAUD_VIDEO_CREATOR_SKILL } from './skills/video-creator';

const SKILLS_DIR_REL = '.qcode/skills';

/** Idempotent — writes / refreshes the bundled skill markdown files
 *  to ~/.qcode/skills/. Safe to call on every app boot or every
 *  claude-code spawn; only writes when the file is missing or its
 *  content has drifted from what we ship in this build.
 *
 *  Why per-app-version: when we update the skill content (better
 *  templates, new patterns, fixed recipes), we want users to get
 *  the new file the next time they launch. A simple SHA check on
 *  the first byte gives us "is the bundled content the live one"
 *  — fast, no manual versioning.
 *
 *  Returns the absolute paths of files written / verified, or null
 *  on web (no fs access). */
export async function ensureSkillsOnDisk(): Promise<string[] | null> {
  if (!isTauri()) return null;
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const { exists, mkdir, readTextFile, writeTextFile } = await import(
      '@tauri-apps/plugin-fs'
    );
    const home = await homeDir();
    const dir = `${home}/${SKILLS_DIR_REL}`;
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    const skills: Array<{ name: string; content: string }> = [
      { name: 'video-creator.md', content: QLAUD_VIDEO_CREATOR_SKILL },
      { name: 'qlaud-tools.md', content: QLAUD_TOOLS_SKILL },
      { name: 'deploy-cloudflare.md', content: QLAUD_DEPLOY_CLOUDFLARE_SKILL },
    ];
    const written: string[] = [];
    for (const s of skills) {
      const path = `${dir}/${s.name}`;
      let needsWrite = true;
      if (await exists(path)) {
        try {
          const current = await readTextFile(path);
          if (current === s.content) needsWrite = false;
        } catch {
          /* read failed — overwrite */
        }
      }
      if (needsWrite) {
        await writeTextFile(path, s.content);
      }
      written.push(path);
    }
    return written;
  } catch {
    // fs failure is non-fatal — the skill pointer falls back to a
    // graceful explanation when the agent can't find the file.
    return null;
  }
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
