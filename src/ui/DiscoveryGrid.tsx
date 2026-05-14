// Discovery grid — vibesdk-style showcase of what qlaud generates.
//
// Modeled on vibesdk's `<AppListContainer>` (`/Users/robeltegegne/
// dev/vibesdk/src/components/shared/AppListContainer.tsx` + AppCard).
// Same responsive grid shape (1/2/3/4 cols across breakpoints),
// same hover/elevation language. Differences from the source:
//
//   - Built around video as the primary surface (qlaud is being
//     positioned as motion-video generation). Each card has an
//     optional `videoSrc` that plays on hover; the still image is
//     a fallback / poster.
//   - No framer-motion dependency (qcode doesn't ship it). CSS
//     transitions and keyframes cover the entry + hover motion.
//   - Data is currently curated (DISCOVERY_ITEMS const below).
//     Designed so a future swap to a real backend feed (paginated
//     /v1/discovery endpoint) is just replacing the array reference
//     with a fetched list.
//
// Used by:
//   - SignInGate (replaces the prior 3-tier pricing cards). New
//     visitors see "what qlaud can produce" before any payment
//     conversation.
//   - (Future) the qcode in-app New Chat surface — when a thread
//     is fresh and the user hasn't typed yet, show this grid as a
//     suggestion / template gallery.

import { useRef, useState } from 'react';
import { Play } from 'lucide-react';

// CDN base for showcase assets. Today these live in qlaud-dashboard's
// public/ folder and are served from qlaud.ai. Tomorrow they'll move
// to a dedicated CDN host (cdn.qlaud.ai or an R2 bucket exposed via
// a custom domain). Centralized so the swap is one constant change.
const ASSET_BASE = 'https://qlaud.ai';

export type DiscoveryItem = {
  id: string;
  title: string;
  /** One-line subhead — what was generated, in plain language. */
  subtitle: string;
  /** Category badge. Drives the small pill in the corner. */
  badge: 'Video' | 'Site' | 'App' | 'Slides';
  /** Thumbnail (poster). Absolute URL — see ASSET_BASE above. */
  image: string;
  /** Optional hover-play video — muted loop while the cursor is on
   *  the card. The actual click navigates to `href`. */
  videoSrc?: string;
  /** Click target. App / video URL, etc. */
  href: string;
  /** Author handle. Optional — placeholder cards omit. */
  author?: string;
  /** Placeholder card invites the visitor to ship their own. */
  placeholder?: boolean;
};

// Curated for now. Six entries gives us a clean 2×3 on lg screens,
// 1×6 on mobile, 2×3 on tablet, 3×2 on xl. Mix of media types so the
// grid reads as "qlaud builds anything", not "qlaud builds videos."
//
// All URLs absolute so this same module works whether qcode-web is
// served from qcode.qlaud.ai (today) or qlaud.ai/<thread-uuid>
// (post-cutover). No origin-relative paths.
export const DISCOVERY_ITEMS: DiscoveryItem[] = [
  {
    id: 'launch-reel',
    title: 'Cinematic launch reel',
    subtitle: '59-second product video. Voiceover, captions, b-roll. One prompt.',
    badge: 'Video',
    image: `${ASSET_BASE}/qcode-video-thumb.jpg`,
    videoSrc: `${ASSET_BASE}/qcode-launch-video.mp4`,
    href: `${ASSET_BASE}/qcode-launch-video.mp4`,
    author: '@qlaud',
  },
  {
    id: 'qlaud-site',
    title: 'qlaud.ai',
    subtitle: 'This site. Designed, coded, deployed in qcode. Chat to live URL.',
    badge: 'Site',
    image: `${ASSET_BASE}/qcode-tools-bg.png`,
    href: 'https://qlaud.ai',
    author: '@qlaud',
  },
  {
    id: 'saas-app',
    title: 'Vibecoded SaaS app',
    subtitle: 'Idea → working app → first paying user. All in one afternoon.',
    badge: 'App',
    image: `${ASSET_BASE}/qcode-models-bg.png`,
    href: 'https://qlaud.ai/sign-up',
    author: '@maker',
  },
  {
    id: 'marketing-pages',
    title: 'Marketing landing pages',
    subtitle: 'Conversion-tuned hero + copy + deploy. From a Slack message.',
    badge: 'Site',
    image: `${ASSET_BASE}/qcode-cta-bg.png`,
    href: 'https://qlaud.ai',
    author: '@team',
  },
  {
    id: 'agent-dashboard',
    title: 'AI agent dashboard',
    subtitle: 'Internal tool that routes across every frontier model.',
    badge: 'App',
    image: `${ASSET_BASE}/qcode-capabilities-bg.png`,
    href: 'https://qlaud.ai/dashboard',
    author: '@builder',
  },
  {
    id: 'your-next',
    title: 'Your project here',
    subtitle: 'Type a prompt above. Watch it ship. We host the link.',
    badge: 'App',
    image: `${ASSET_BASE}/qcode-gateway-bg.png`,
    href: '#composer',
    placeholder: true,
  },
];

/** The grid. Responsive: 1 col → 2 → 3 → 4 across breakpoints. */
export function DiscoveryGrid({
  items = DISCOVERY_ITEMS,
  className = '',
}: {
  items?: DiscoveryItem[];
  className?: string;
}) {
  return (
    <div
      className={
        'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ' +
        className
      }
    >
      {items.map((item, i) => (
        <DiscoveryCard key={item.id} item={item} index={i} />
      ))}
    </div>
  );
}

function DiscoveryCard({ item, index }: { item: DiscoveryItem; index: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovered, setHovered] = useState(false);

  // Inline-play on hover. Mirrors the ShowcaseCard pattern but
  // wrapped in state so we can also drive the play indicator
  // (the Play icon overlay fades out while the video runs).
  const onEnter = () => {
    setHovered(true);
    const el = videoRef.current;
    if (!el) return;
    el.play().catch(() => {
      // Autoplay blocked — the user clicks through to the full video.
      // Don't error-log; this is normal on first interaction in
      // some browsers (Safari especially).
    });
  };
  const onLeave = () => {
    setHovered(false);
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  };

  return (
    <a
      href={item.href}
      target={item.href.startsWith('http') ? '_blank' : undefined}
      rel={item.href.startsWith('http') ? 'noreferrer' : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // Staggered fade-in. Each card delays by 60ms × its index so
      // the grid reveals as a wave rather than all at once. Capped
      // around 0.5s for the last visible card on the largest grid
      // (xl with 4 cols × 2 rows = 8 cards × 60ms = 480ms).
      style={{ animationDelay: `${Math.min(index * 60, 480)}ms` }}
      className="discovery-card group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-lg"
    >
      {/* Thumbnail / video container — 16:9 aspect, gradient fallback
       *  underneath in case the image fails to load (the placeholder
       *  card especially leans on this). */}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-br from-primary/15 via-card to-muted">
        <img
          src={item.image}
          alt={item.title}
          loading="lazy"
          decoding="async"
          className={
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ' +
            (item.videoSrc && hovered ? 'opacity-0' : 'opacity-100') +
            (item.placeholder ? ' opacity-40' : '')
          }
          onError={(e) => {
            // Image failed — drop the broken-image icon, let the
            // gradient backdrop carry the visual.
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />

        {/* Video layer — only mounted when this card has a videoSrc.
         *  preload=metadata avoids a network hit until hover. muted
         *  is required for browsers to allow programmatic play(). */}
        {item.videoSrc && (
          <video
            ref={videoRef}
            src={item.videoSrc}
            muted
            loop
            playsInline
            preload="metadata"
            className={
              'absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ' +
              (hovered ? 'opacity-100' : 'opacity-0')
            }
          />
        )}

        {/* Play indicator overlay — visible only for cards that
         *  have a videoSrc AND aren't currently hovering (the video
         *  itself takes over the surface mid-hover). */}
        {item.videoSrc && (
          <div
            className={
              'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 ' +
              (hovered ? 'opacity-0' : 'opacity-100')
            }
          >
            <div className="grid h-12 w-12 place-items-center rounded-full bg-white/90 text-black shadow-lg transition-transform duration-300 group-hover:scale-90">
              <Play className="h-4 w-4 translate-x-0.5 fill-current" />
            </div>
          </div>
        )}

        {/* Category badge — top-left corner. Same micro-pill the
         *  vibesdk AppCard uses, tuned to our color tokens. */}
        <div className="absolute left-3 top-3 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/80 backdrop-blur">
          {item.badge}
        </div>
      </div>

      {/* Body — title, subtitle, author. Tight padding so cards
       *  don't grow past their thumbnails on the smaller breakpoints. */}
      <div className="flex flex-1 flex-col gap-1 p-3.5">
        <h3 className="line-clamp-1 text-[13px] font-semibold tracking-tight text-foreground">
          {item.title}
        </h3>
        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {item.subtitle}
        </p>
        {item.author && (
          <div className="mt-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {item.author}
          </div>
        )}
      </div>

      {/* Card-level entrance animation. Inline keyframe because we
       *  don't want a global stylesheet edit just for this. */}
      <style>{`
        .discovery-card {
          opacity: 0;
          animation: discovery-card-in 0.5s ease-out forwards;
        }
        @keyframes discovery-card-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .discovery-card {
            opacity: 1;
            animation: none;
          }
        }
      `}</style>
    </a>
  );
}
