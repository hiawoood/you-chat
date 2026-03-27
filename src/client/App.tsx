import { useState, useEffect, useRef, Suspense, lazy } from "react";
import { Capacitor } from "@capacitor/core";
import { useSession } from "./lib/auth";
import { api } from "./lib/api";

const Login = lazy(() => import("./pages/Login"));
const Chat = lazy(() => import("./pages/Chat"));
const CookieSetup = lazy(() => import("./pages/CookieSetup"));

function FullScreenSpinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const isNativeApp = Capacitor.isNativePlatform();
    document.body.classList.toggle("native-app", isNativeApp);

    return () => {
      document.body.classList.remove("native-app");
    };
  }, []);

  const { data: session, isPending } = useSession();
  const [hasCredentials, setHasCredentials] = useState<boolean | null>(null);
  const [checkingCredentials, setCheckingCredentials] = useState(false);
  const credentialChecked = useRef(false);

  useEffect(() => {
    // Only check credentials once per session, not on every re-render/refocus
    if (session?.user && !credentialChecked.current) {
      credentialChecked.current = true;
      setCheckingCredentials(true);
      api.getCredentials()
        .then((result) => setHasCredentials(result.hasCredentials))
        .catch(() => setHasCredentials(false))
        .finally(() => setCheckingCredentials(false));
    }
  }, [session?.user]);

  if (isPending || checkingCredentials) {
    return <FullScreenSpinner />;
  }

  if (!session?.user) {
    return (
      <Suspense fallback={<FullScreenSpinner />}>
        <Login />
      </Suspense>
    );
  }

  if (hasCredentials === false) {
    return (
      <Suspense fallback={<FullScreenSpinner />}>
        <CookieSetup
          onComplete={() => {
            credentialChecked.current = true;
            setHasCredentials(true);
          }}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <Chat />
    </Suspense>
  );
}
