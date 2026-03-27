import type { CapacitorConfig } from "@capacitor/cli";

const defaultServerUrl = "https://you-chat-production.up.railway.app";
const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim() || defaultServerUrl;
const enableAndroidWebDebug =
  process.env.CAPACITOR_DEBUG_WEBVIEW?.trim() === "true"
  || /^http:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(serverUrl);

const config: CapacitorConfig = {
  appId: "com.hiawoood.youchat",
  appName: "You Chat",
  webDir: "dist",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
      }
    : undefined,
  android: {
    allowMixedContent: enableAndroidWebDebug && serverUrl.startsWith("http://"),
    webContentsDebuggingEnabled: enableAndroidWebDebug,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
    },
  },
};

export default config;
