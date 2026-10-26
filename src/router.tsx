import { createHashRouter, Navigate } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { BrowsePage } from "./pages/BrowsePage";
import { SearchPage } from "./pages/SearchPage";

// Hash routing: the bundled app is served from tauri://, where deep paths
// would otherwise 404 on reload.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/browse/douyu" replace /> },
      { path: "browse/:platform", element: <BrowsePage /> },
      {
        path: "room/:platform/:roomId",
        // The player (xgplayer + flv/hls) is most of the bundle; load it on demand.
        lazy: async () => ({ Component: (await import("./pages/RoomPage")).RoomPage }),
      },
      { path: "search", element: <SearchPage /> },
    ],
  },
]);
