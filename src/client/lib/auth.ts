import { createAuthClient } from "better-auth/react";

// Use current origin for both local and tunnel access
const baseURL = typeof window !== "undefined" ? window.location.origin : "";

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    // Disable automatic refetch on window focus/visibility change
    // This prevents the app from resetting state when switching desktops on Mac
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
});

export const { useSession, signIn, signUp, signOut } = authClient;
