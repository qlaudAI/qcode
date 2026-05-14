import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

type IntroVideoProps = {
  title: string;
  subtitle: string;
};

export const IntroVideo: React.FC<IntroVideoProps> = ({title, subtitle}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const titleProgress = spring({
    frame,
    fps,
    from: 0,
    durationInFrames: 45,
  });

  const subtitleOpacity = interpolate(frame, [45, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const pulse = 1 + 0.03 * Math.sin(frame / 8);

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 20% 20%, #1e3a8a, #0f172a 55%, #020617)',
        color: '#e2e8f0',
        fontFamily: 'Inter, system-ui, sans-serif',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          transform: `scale(${0.9 + 0.1 * titleProgress}) scale(${pulse})`,
          opacity: titleProgress,
          padding: '24px 48px',
          borderRadius: 24,
          border: '1px solid rgba(148, 163, 184, 0.35)',
          background: 'rgba(15, 23, 42, 0.5)',
          backdropFilter: 'blur(4px)',
          boxShadow: '0 30px 80px rgba(2, 6, 23, 0.5)',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 120,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: -2,
          }}
        >
          {title}
        </h1>
        <p
          style={{
            marginTop: 18,
            marginBottom: 0,
            fontSize: 44,
            fontWeight: 500,
            opacity: subtitleOpacity,
            color: '#cbd5e1',
          }}
        >
          {subtitle}
        </p>
      </div>
    </AbsoluteFill>
  );
};
