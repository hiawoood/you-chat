import { Capacitor, registerPlugin } from "@capacitor/core";

type BackgroundAudioPlugin = {
  enable(): Promise<void>;
  disable(): Promise<void>;
};

const backgroundAudio = registerPlugin<BackgroundAudioPlugin>("BackgroundAudio");

export async function enableNativeBackgroundMode() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await backgroundAudio.enable();
  } catch {
    // Ignore native background mode failures and keep web playback working.
  }
}

export async function disableNativeBackgroundMode() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await backgroundAudio.disable();
  } catch {
    // Ignore native background mode failures.
  }
}
