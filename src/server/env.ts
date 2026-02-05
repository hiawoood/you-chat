// Load .env file if present - must be imported first
// On Railway, env vars are injected directly, so .env is optional
try {
  const envFile = Bun.file(".env");
  if (await envFile.exists()) {
    const content = await envFile.text();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        const value = trimmed.slice(eqIdx + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
    console.log("Loaded .env file");
  }
} catch (e) {
  // No .env file - that's fine, Railway injects env vars directly
}

// Validate required env vars
if (!process.env.YOU_API_KEY) {
  console.error("⚠️  YOU_API_KEY is not set! Set it as an environment variable.");
}
if (!process.env.BETTER_AUTH_SECRET) {
  console.error("⚠️  BETTER_AUTH_SECRET is not set! Set it as an environment variable.");
}

export {};
