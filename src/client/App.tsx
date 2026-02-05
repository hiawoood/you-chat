import { useSession } from "./lib/auth";
import Login from "./pages/Login";
import Chat from "./pages/Chat";

export default function App() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!session?.user) {
    return <Login />;
  }

  return <Chat />;
}
