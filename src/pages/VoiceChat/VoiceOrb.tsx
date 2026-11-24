import { Button, Image, View } from "@tarojs/components";

import orbSurface from "../../assets/voice/orb-mist.png";

import "./VoiceOrb.scss";

export type VoiceOrbState = "idle" | "recording" | "processing" | "speaking" |
  "repeat-recording" | "loading" | "blocked" | "error";

type VoiceOrbProps = {
  state: VoiceOrbState;
  onClick: () => void;
  disabled: boolean;
  label: string;
};

/** Decorative motion indicates the current action, not microphone volume. */
export default function VoiceOrb({ state, onClick, disabled, label }: VoiceOrbProps) {
  const waveform = state === "idle" || state === "error" || state === "speaking";
  const recording = state === "recording" || state === "repeat-recording";

  return (
    <View className={`voice-orb-stage voice-orb-stage--${state}`}>
      <View className='voice-orb__ripple voice-orb__ripple--first' />
      <View className='voice-orb__ripple voice-orb__ripple--second' />
      <Button
        className={`voice-chat__mic voice-orb voice-orb--${state}`}
        data-state={state}
        ariaLabel={label}
        disabled={disabled}
        hoverClass='voice-orb--pressed'
        hoverStartTime={0}
        hoverStayTime={90}
        onClick={onClick}
      >
        <Image className='voice-orb__surface' src={orbSurface} mode='aspectFit' />
        {(recording || state === "speaking") && <View className='voice-orb__stop' />}
        {waveform && <View className='voice-orb__wave'>
          {[0, 1, 2, 3, 4].map(index => <View className={`voice-orb__bar voice-orb__bar--${index}`} key={index} />)}
        </View>}
        {state === "repeat-recording" && <View className='voice-orb__repeat' />}
        {(state === "processing" || state === "loading") && <View className='voice-orb__spinner' />}
        {state === "processing" && <View className='voice-orb__dots'>
          {[0, 1, 2].map(index => <View className={`voice-orb__dot voice-orb__dot--${index}`} key={index} />)}
        </View>}
        {state === "blocked" && <View className='voice-orb__lock'>
          <View className='voice-orb__lock-shackle' />
          <View className='voice-orb__lock-body' />
        </View>}
        {state === "error" && <View className='voice-orb__error-mark'>
          <View className='voice-orb__error-stroke' />
          <View className='voice-orb__error-dot' />
        </View>}
      </Button>
    </View>
  );
}
