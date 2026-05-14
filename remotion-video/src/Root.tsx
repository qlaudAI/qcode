import {Composition} from 'remotion';
import {IntroVideo} from './IntroVideo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Intro"
      component={IntroVideo}
      durationInFrames={240}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{title: 'Built with Remotion', subtitle: 'Created for you in qcode'}}
    />
  );
};
