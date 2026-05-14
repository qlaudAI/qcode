// BorderBeam — MagicUI-style traveling gradient stroke.
//
// Renders a thin colored arc that travels around the parent
// container's border. Used on the composer when it's active OR when
// the model is mid-generation — gives a subtle "this thing is alive"
// signal without a loud spinner.
//
// CSS-only animation (no JS rAF loop). Stays cheap; the keyframe
// runs on the compositor. Pointer-events-none so the beam never
// intercepts clicks.

import { useId } from 'react';

type Props = {
  /** Pixel width of the beam stroke. Default 1.5 — Apple-restrained. */
  size?: number;
  /** Animation duration in seconds. Default 12s — slow enough to read
   *  as ambient, not anxious. */
  duration?: number;
  /** Whether the beam is animating. When false, the border collapses
   *  to a static subtle ring. Drives the on/off via the parent's
   *  prop (e.g. `active={composerFocused || streaming}`). */
  active?: boolean;
  /** CSS color value for the beam — supports CSS variables. */
  color?: string;
  className?: string;
};

export function BorderBeam({
  size = 1.5,
  duration = 12,
  active = true,
  color = 'hsl(var(--primary))',
  className,
}: Props) {
  // Unique id so multiple instances on the page don't share the
  // same keyframe namespace (React StrictMode double-renders are
  // safe because the id changes per mount).
  const id = useId().replace(/:/g, '');
  if (!active) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] ${className ?? ''}`}
    >
      <style>
        {`
          @keyframes border-beam-${id} {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          .border-beam-${id} {
            position: absolute;
            inset: -100%;
            background: conic-gradient(
              from 0deg,
              transparent 0deg,
              ${color} 30deg,
              ${color} 60deg,
              transparent 90deg,
              transparent 360deg
            );
            animation: border-beam-${id} ${duration}s linear infinite;
          }
          .border-beam-mask-${id} {
            position: absolute;
            inset: ${size}px;
            border-radius: inherit;
            background: hsl(var(--background));
          }
        `}
      </style>
      <div className={`border-beam-${id}`} />
      <div className={`border-beam-mask-${id}`} />
    </div>
  );
}
