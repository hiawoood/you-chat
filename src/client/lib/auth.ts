import { createAuthClient } from "better-auth/react";

// Use current origin for both local and tunnel access
const baseURL = typeof window !== "undefined" ? window.location.origin : "";

export const authClient = createAuthClient({
  baseURL,
});

export const { useSession, signIn, signUp, signOut } = authClient;
