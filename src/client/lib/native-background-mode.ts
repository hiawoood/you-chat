import { Capacitor } from "@capacitor/core";

interface CordovaBackgroundModePlugin {
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
  setDefaults(options: {
    title?: string;
    text?: string;
    resume?: boolean;
    silent?: boolean;
    hidden?: boolean;
  }): void;
  disableWebViewOptimizations?(): void;
  moveToForeground?(): void;
}

declare global {
  interface Window {
    cordova?: {
      plugins?: {
        backgroundMode?: CordovaBackgroundModePlugin;
      };
    };
  }
}

function getBackgroundModePlugin(): CordovaBackgroundModePlugin | null {
  if (typeof window === "undefined") return null;
  if (!Capacitor.isNativePlatform()) return null;
  return window.cordova?.plugins?.backgroundMode || null;
}

let backgroundModeConfigured = false;

export function enableNativeBackgroundMode() {
  const plugin = getBackgroundModePlugin();
  if (!plugin) return;

  if (!backgroundModeConfigured) {
    plugin.setDefaults({
      title: "You Chat",
      text: "TTS playback is active",
      resume: true,
      silent: true,
      hidden: false,
    });
    plugin.disableWebViewOptimizations?.();
    backgroundModeConfigured = true;
  }

  if (!plugin.isEnabled()) {
    plugin.enable();
  }
}

export function disableNativeBackgroundMode() {
  const plugin = getBackgroundModePlugin();
  if (!plugin) return;

  if (plugin.isEnabled()) {
    plugin.disable();
  }
}
