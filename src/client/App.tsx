import { useState, useEffect } from "react";
import { useSession } from "./lib/auth";
import { api } from "./lib/api";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import CookieSetup from "./pages/CookieSetup";

export default function App() {
  const { data: session, isPending } = useSession();
  const [hasCredentials, setHasCredentials] = useState<boolean | null>(null);
  const [checkingCredentials, setCheckingCredentials] = useState(false);

  useEffect(() => {
    if (session?.user) {
      setCheckingCredentials(true);
      api.getCredentials()
        .then((result) => setHasCredentials(result.hasCredentials))
        .catch(() => setHasCredentials(false))
        .finally(() => setCheckingCredentials(false));
    }
  }, [session?.user]);

  if (isPending || checkingCredentials) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!session?.user) {
    return <Login />;
  }

  if (hasCredentials === false) {
    return <CookieSetup onComplete={() => setHasCredentials(true)} />;
  }

  return <Chat />;
}
