import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api.js";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App client={createApiClient()} />
  </StrictMode>,
);
