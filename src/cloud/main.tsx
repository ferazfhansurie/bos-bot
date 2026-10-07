// Dev entry for the slice 1 cloud room client. Off unless BOS_CLOUD_ROOMS=1.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CloudRoomScreen } from "./CloudRoomScreen";
import { cloudRoomsEnabled } from "./flag";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {cloudRoomsEnabled() ? <CloudRoomScreen baseUrl={window.location.origin} /> : <p className="p-6 text-sm">cloud rooms are off.</p>}
  </StrictMode>,
);
