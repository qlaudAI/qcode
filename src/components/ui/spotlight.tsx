// Spotlight — Aceternity-style ambient radial gradient.
//
// Renders a soft glow behind the hero empty-state composer. Positioned
// once, animated subtly via framer-motion (already in our deps via
// `motion`). Pointer-events-none so it never intercepts clicks.
//
// Used at LOW OPACITY — Apple-design discipline. The glow is meant to
// suggest "this is the focal element" not "look at this animation."

import { motion } from 'motion/react';

type Props = {
  className?: string;
  fill?: string;
};

export function Spotlight({ className, fill = 'hsl(var(--primary))' }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.18 }}
      transition={{ duration: 1.6, ease: 'easeOut' }}
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${className ?? ''}`}
      aria-hidden
    >
      <svg
        className="absolute -top-1/4 left-1/2 -translate-x-1/2"
        width="1200"
        height="900"
        viewBox="0 0 1200 900"
        fill="none"
      >
        <ellipse
          cx="600"
          cy="450"
          rx="520"
          ry="340"
          fill={fill}
          filter="url(#spotlight-blur)"
        />
        <defs>
          <filter
            id="spotlight-blur"
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation="120" />
          </filter>
        </defs>
      </svg>
    </motion.div>
  );
}
