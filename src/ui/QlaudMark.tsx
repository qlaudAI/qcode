// Canonical qlaud monogram. Same artwork as qlaud.ai/icon.svg —
// dark rounded square with a white lowercase 'q' and a red period
// accent. Anywhere qcode renders a brand mark, this is the source
// of truth so the app, the web build, and qlaud.ai stay visually
// identical. (Easy to forget when shipping new screens — import
// this instead of dropping in a Sparkles or random Lucide glyph.)

export function QlaudMark({
  className,
  /** Whether to render an inverted (light-bg, dark q) variant. The
   *  Tauri title bar uses the dark default; certain marketing
   *  contexts prefer the inverted look. */
  inverted = false,
}: {
  className?: string;
  inverted?: boolean;
}) {
  const bg = inverted ? '#ffffff' : '#0a0a0a';
  const ink = inverted ? '#0a0a0a' : '#ffffff';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect width="64" height="64" rx="14" fill={bg} />
      <circle
        cx="23"
        cy="28"
        r="10"
        stroke={ink}
        strokeWidth="5"
        fill="none"
      />
      <rect x="33" y="22" width="7" height="32" fill={ink} />
      <circle cx="50" cy="50" r="3.5" fill="#ef4444" />
    </svg>
  );
}
