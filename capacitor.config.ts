import type { CapacitorConfig } from "@capacitor/cli";

const defaultServerUrl = "https://you-chat-production.up.railway.app";
const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim() || defaultServerUrl;

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
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
    },
  },
};

export default config;
