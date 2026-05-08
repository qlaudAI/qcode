// qlaud-deploy-cloudflare skill — appended to claude-code's system
// prompt when the user asks to deploy / publish / ship their project
// to Cloudflare.
//
// Two modes documented here. Detection at runtime (skill text below
// walks the agent through it):
//
//   1. MANAGED (qlaud platform, default for non-technical users)
//        Calls api.qlaud.ai/v1/apps/:id/deploy. The qlaud edge
//        worker provisions a per-app D1 + Workers-for-Platforms
//        script + custom hostname under {slug}.qlaud.app. User
//        sees the live URL when the call returns. Authentication is
//        the user's qcode session token; userId is locked server-side
//        from the bearer (same pattern as qlaud-tools' execute call).
//        --- NOTE: managed endpoints are still under construction.
//        Until they ship, default to BYO mode below.
//
//   2. BYO (Bring Your Own Cloudflare account)
//        Direct wrangler against the user's own CF account. They
//        supply CLOUDFLARE_API_TOKEN via .env.local; we never store
//        third-party provider tokens. Works today.
//
// User preference is recorded once at .qcode/deploy.json so we don't
// re-ask. Skill text walks the agent through a one-time picker if
// the file is absent.
//
// Why a skill (not a tool / sub-agent / Tauri command): same logic
// as video-creator. Deployment is shell + curl. The agent already
// has Bash, Read, Write, and our managed APIs are HTTP. A skill
// teaches the recipe; we add zero infrastructure to the desktop /
// web codebase. When managed APIs ship, only this markdown changes.

export const QLAUD_DEPLOY_CLOUDFLARE_SKILL = `qcode deploy-cloudflare skill — ship the user's project to Cloudflare.

When the user says "deploy", "publish", "ship it", "put it live", "go live", "make it live" — DO IT. Don't ask "which provider?" unless the user explicitly mentioned one we don't support yet (Vercel, Netlify, Render, Fly, AWS, GCP). For now we deploy to Cloudflare only.

────────────────────────────────────────────────────────────────────
STEP 0 — Pick the deployment mode (one-time per workspace)

Read .qcode/deploy.json if it exists. Schema:
  { "provider": "qlaud-managed" | "byo-cloudflare", "appId"?: string, "slug"?: string }

If the file is absent:
  • If the user is non-technical (asked us to "make a website / app / game / saas") and didn't mention Cloudflare/Vercel/etc, default to qlaud-managed.
  • If the user mentioned their own Cloudflare account, account ID, or wrangler.toml exists in the project root, default to byo-cloudflare.
  • Otherwise ASK ONCE: "Want me to host this for you (qlaud-managed, free until your usage hits the plan limit, custom domain {slug}.qlaud.app), or deploy to your own Cloudflare account?"
Write the answer to .qcode/deploy.json and proceed.

LIMITATION: managed mode currently supports framework="worker" ONLY (a single bundled JS module). Static sites + Next.js + Vite SPAs need byo-cloudflare for now — the managed deploy doesn't accept Pages-style asset bundles yet. If the project is Worker-shaped, prefer managed; otherwise fall back to BYO. This evolves; check by trying the managed deploy and reading the error if it rejects the framework.

────────────────────────────────────────────────────────────────────
STEP 1 — Identify what we're shipping

Inspect the project. Decision tree:

  Has next.config.{js,ts,mjs} or app/ + page.tsx?
    → Next.js. Deploy via @cloudflare/next-on-pages.
       output: Cloudflare Pages with edge runtime.

  Has vite.config.{js,ts} + a frontend framework (React/Vue/Svelte)?
    → SPA. Deploy via wrangler pages deploy <dist-dir>.
       output: Cloudflare Pages, static.

  Has wrangler.toml or wrangler.jsonc + src/index.ts that exports a fetch handler?
    → Cloudflare Worker. Deploy via wrangler deploy.

  Has wrangler.toml AND a Pages project?
    → Pages-with-Functions. Deploy via wrangler pages deploy.

  Has only static HTML/CSS/JS files?
    → Static site. Deploy via wrangler pages deploy.

  None of the above?
    → ASK the user what they intend before scaffolding. Don't guess.

Detect the package manager (bun.lock → bun, pnpm-lock.yaml → pnpm,
yarn.lock → yarn, otherwise npm). Use it consistently for install + build.

────────────────────────────────────────────────────────────────────
MODE A — qlaud-managed (default for non-technical users)

qlaud-edge provisions a Cloudflare Worker in our managed Workers-for-
Platforms namespace, auto-creates a per-app D1 database, and routes
{slug}.qlaud.app to it via a dispatcher. The user authenticates with
their qcode session token; userId is locked server-side from the
bearer (same pattern as the qlaud-tools skill), so we never send a
user_id field.

Today the managed flow accepts framework="worker" only — a single
bundled JS module that exports default { fetch }. Pages-style static
bundles + Next.js are coming; until then, fall back to byo-cloudflare
for those.

1. Bundle the project to a single JS module.

   For a fresh worker (no wrangler.toml yet — qcode generated it):
     # The user's src/index.ts already has 'export default { fetch: ... }'.
     # Use wrangler dry-run to bundle deps, tree-shake, and produce a
     # ready-to-upload module:
     bunx wrangler@latest deploy --dry-run --outdir=/tmp/qlaud-build src/index.ts
     # Output: /tmp/qlaud-build/index.js  (single bundled module)

   For a project that already has wrangler.toml:
     bunx wrangler@latest deploy --dry-run --outdir=/tmp/qlaud-build
     # Reads main from wrangler.toml; output goes to /tmp/qlaud-build/

   Either way you end with a single .js file (typically index.js)
   ready to upload. The qlaud-edge handler caps at 10MB per main file.

2. Resolve the app id. Read .qcode/deploy.json.appId — if present,
   re-use it. Otherwise register a new app:

     curl -s https://api.qlaud.ai/v1/apps \\
       -H "x-api-key: $ANTHROPIC_API_KEY" \\
       -H "content-type: application/json" \\
       -d '{"name":"<friendly-name>","framework":"worker"}'

   Response shape:
     {
       "id": "app_<24hex>",
       "slug": "<adj>-<noun>-<4digits>",       e.g. "sleek-jaguar-8071"
       "framework": "worker",
       "status": "created",
       "live_url": null,                        null until first deploy
       ...
     }

   Save the id + slug to .qcode/deploy.json so subsequent deploys
   re-use them and don't allocate new slugs.

3. Deploy via multipart POST. Server runs the full provision-and-
   publish ceremony and streams SSE progress events back.

     APP_ID=$(jq -r .appId < .qcode/deploy.json)
     curl -s -N -X POST "https://api.qlaud.ai/v1/apps/$APP_ID/deploy" \\
       -H "x-api-key: $ANTHROPIC_API_KEY" \\
       -F 'manifest={"framework":"worker","main":"index.js","compatibility_date":"'$(date +%Y-%m-%d)'"};type=application/json' \\
       -F 'index.js=@/tmp/qlaud-build/index.js;filename=index.js;type=application/javascript+module'

   IMPORTANT details:
     • The "filename=index.js" suffix on the file part is REQUIRED.
       Without it the server can't match the multipart entry to
       manifest.main and rejects with "main file missing".
     • -N tells curl not to buffer the SSE stream so progress
       lines surface as they arrive.
     • The form field name (left of the @) must match manifest.main.

4. Parse the SSE response. The server emits this exact sequence:
     event: progress  data: {"phase":"received","message":"...","percent":5}
     event: progress  data: {"phase":"provisioning_d1",...,"percent":20}    (first deploy only)
     event: progress  data: {"phase":"migrating_db",...,"percent":30}        (only with manifest.migrations)
     event: progress  data: {"phase":"uploading_script",...,"percent":50}
     event: progress  data: {"phase":"binding_resources",...,"percent":70}
     event: progress  data: {"phase":"syncing_dispatcher",...,"percent":90}
     event: progress  data: {"phase":"live",...,"percent":100}
     event: complete  data: {"deploy_id":"dep_...","live_url":"https://<slug>.qlaud.app","script_version":"..."}

   Failure shape:
     event: error  data: {"code":"<code>","message":"<human readable>"}

   Surface progress messages to the user as they arrive — DON'T let
   the prompt sit silent for 20+ seconds while the deploy streams.
   Print each phase so the user sees forward motion.

5. On success — print the live URL. Tell the user "your app is live
   at https://<slug>.qlaud.app — try it." Optionally offer to open it.

6. On error — surface error.message verbatim. The server returns
   structured codes:
     cf_10121         → managed platform misconfigured (qlaud bug, not user's)
     deploy_error     → CF API rejected the upload (often a JS syntax error)
     not_found_error  → app id not in user's account; check .qcode/deploy.json

   For plan-limit errors (status 402): the message says exactly what
   to do — relay it. "You've hit your Free plan's 1-app limit. Archive
   an existing app or upgrade at qlaud.ai/billing."

7. Optional: include database migrations. If the project has
   migrations/*.sql files, list them in manifest.migrations[] (in
   execution order) and add each as a multipart field:

     -F 'manifest={"framework":"worker","main":"index.js","migrations":["0001_init.sql","0002_users.sql"]};type=application/json' \\
     -F '0001_init.sql=@migrations/0001_init.sql;filename=0001_init.sql;type=text/plain' \\
     -F '0002_users.sql=@migrations/0002_users.sql;filename=0002_users.sql;type=text/plain' \\
     -F 'index.js=@/tmp/qlaud-build/index.js;filename=index.js;type=application/javascript+module'

   Server tracks applied migrations per-app in a _qlaud_migrations
   table inside the user's D1, so re-deploys are idempotent. The
   "migrating_db" phase runs the unapplied ones.

8. Optional: include plain (non-secret) env vars in manifest.vars:

     -F 'manifest={"framework":"worker","main":"index.js","vars":{"ENVIRONMENT":"production","API_VERSION":"v1"}};type=application/json' ...

   For SECRET values (API keys, tokens), there's no client-side API
   yet — direct the user to set them via the dashboard at
   qlaud.ai/apps/<id>/env once that lands. For now, plain vars only.

────────────────────────────────────────────────────────────────────
MODE B — byo-cloudflare (Bring Your Own CF account)

Pure local execution. We never store the user's CF token. They put
it in .env.local and wrangler reads it from the env at deploy time.

1. Verify wrangler is available (bundled bun ships bunx, which can
   spawn wrangler on demand):
     bunx wrangler@latest --version
     # If first run takes 10-20s downloading wrangler — that's normal.

2. Verify the user is authenticated. Two paths:
     a) API token in .env.local:
          test -f .env.local && grep -q '^CLOUDFLARE_API_TOKEN=' .env.local
        If absent: tell the user
          "I need a Cloudflare API token to deploy to your own account.
           Create one at https://dash.cloudflare.com/profile/api-tokens
           with 'Edit Cloudflare Workers' template, then add this line
           to .env.local:
             CLOUDFLARE_API_TOKEN=<paste-here>
           Optionally also: CLOUDFLARE_ACCOUNT_ID=<your-account-id>
           Then say 'deploy' again."
     b) Or: bunx wrangler login (opens browser).

3. Scaffold wrangler config if absent.

   For a Pages project (most SPAs / Next):
     # No wrangler.toml needed for Pages. Just deploy:
     bunx wrangler pages deploy <dist-dir> --project-name=<derived-from-package-name>

   For a Worker, generate wrangler.toml:
     name = "<derived-from-package-name>"
     main = "src/index.ts"
     compatibility_date = "$(date +%Y-%m-%d)"
     compatibility_flags = ["nodejs_compat"]
     # If the project has a package.json with "main" pointing to a built
     # file, prefer that. If it has a "build" script, run it first.

4. If the project needs storage (looks for D1 / R2 / KV imports),
   provision the bindings before first deploy:

     # D1
     bunx wrangler d1 create <project-name>-db
     # Append the returned database_id to wrangler.toml under [[d1_databases]]
     # Run any migrations:
     bunx wrangler d1 execute <project-name>-db --file=migrations/0001_init.sql

     # R2
     bunx wrangler r2 bucket create <project-name>-assets
     # Append [[r2_buckets]] to wrangler.toml

     # KV
     bunx wrangler kv namespace create <PROJECT_NAME>_KV
     # Append [[kv_namespaces]] to wrangler.toml

   Show the user the new wrangler.toml diff before applying.

5. If the project has secrets (API keys, signing keys), set them
   via wrangler secret. Read .env.local lines that look like
   secrets (KEYS that aren't part of CLOUDFLARE_*) and offer to
   upload them:

     echo "<secret-value>" | bunx wrangler secret put SECRET_NAME

6. Deploy.
   • Pages:  bunx wrangler pages deploy <dist-dir> --project-name=<name>
   • Worker: bunx wrangler deploy

   Both stream their own progress to stdout. Tail it back to the user.

7. Custom domain (Pages, optional). User's domain must already be
   on Cloudflare (zone in their account):
     bunx wrangler pages domain add --project-name=<name> <domain>

8. On success: print the live workers.dev or pages.dev URL plus any
   custom domain. Save the CF project name + URL to .qcode/deploy.json
   so subsequent deploys hit the same project.

────────────────────────────────────────────────────────────────────
COMMON FAILURES + FIXES

"You don't have permission to perform this action"
  → Token missing scope. Re-create with "Edit Cloudflare Workers"
    template, not "Read".

"workers.dev domain is not enabled"
  → User's first deploy on this account. Open
    https://dash.cloudflare.com/?to=/:account/workers/onboarding
    and have them enable a workers.dev subdomain (one click).

"D1 database not found"
  → wrangler.toml has stale database_id. Re-run wrangler d1 list,
    update the id, redeploy.

"Account ID is required"
  → Add CLOUDFLARE_ACCOUNT_ID=<id> to .env.local. Find the id at
    dash.cloudflare.com → right sidebar.

"Module not found: 'cloudflare:workers'"
  → User's bundler isn't externalizing CF runtime modules. For
    Workers, use wrangler's built-in bundler (don't pre-bundle
    with vite/esbuild). For Pages, ensure compatibility_date is
    recent and compatibility_flags includes "nodejs_compat".

"Build failed: …" (Pages)
  → Read the build log. Most common: missing build command in
    wrangler.toml or package.json. Add a "build" script.

────────────────────────────────────────────────────────────────────
WHAT NOT TO DO

  ✗ Don't store CLOUDFLARE_API_TOKEN anywhere except .env.local on
    the user's machine. NEVER send it to qlaud.
  ✗ Don't auto-deploy without showing the user what will deploy
    (file count, build size, target URL) and getting a "yes."
  ✗ Don't run wrangler login in non-interactive flows — it opens
    a browser and the agent can't complete the OAuth on the user's
    behalf. Recommend the API token path.
  ✗ Don't overwrite an existing wrangler.toml without showing the
    diff first. Users may have customized it.
  ✗ Don't mix qlaud-managed and byo-cloudflare in one workspace.
    .qcode/deploy.json picks one path; stick with it for the
    workspace lifetime unless the user explicitly switches.

────────────────────────────────────────────────────────────────────
QUICK REFERENCE

  Detect framework:    look for next.config / vite.config / wrangler.toml / index.html
  Build worker:        bunx wrangler deploy --dry-run --outdir=/tmp/qlaud-build [src/index.ts]

  qlaud-managed register:
    curl -s https://api.qlaud.ai/v1/apps -H "x-api-key: $ANTHROPIC_API_KEY" \\
      -H "content-type: application/json" \\
      -d '{"name":"<name>","framework":"worker"}'

  qlaud-managed deploy:
    curl -s -N -X POST "https://api.qlaud.ai/v1/apps/<APP_ID>/deploy" \\
      -H "x-api-key: $ANTHROPIC_API_KEY" \\
      -F 'manifest={"framework":"worker","main":"index.js"};type=application/json' \\
      -F 'index.js=@/tmp/qlaud-build/index.js;filename=index.js;type=application/javascript+module'
    # SSE response — phase events stream until "complete" with live_url

  qlaud-managed list:  curl https://api.qlaud.ai/v1/apps -H "x-api-key: $ANTHROPIC_API_KEY"
  qlaud-managed get:   curl https://api.qlaud.ai/v1/apps/<APP_ID> -H "x-api-key: $ANTHROPIC_API_KEY"
  qlaud-managed history: curl https://api.qlaud.ai/v1/apps/<APP_ID>/deployments -H "x-api-key: $ANTHROPIC_API_KEY"

  BYO Pages:           bunx wrangler pages deploy <dir> --project-name=<name>
  BYO Worker:          bunx wrangler deploy
  BYO Create D1:       bunx wrangler d1 create <name>
  BYO Run migration:   bunx wrangler d1 execute <name> --file=migrations/<file>.sql
  BYO Set secret:      echo "<value>" | bunx wrangler secret put <NAME>
  BYO Custom domain:   bunx wrangler pages domain add --project-name=<n> <domain>
`;
