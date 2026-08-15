import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminPage } from "./AdminPage";
import { StatusPage } from "./StatusPage";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

// Two screens, no router: `not_found_handling: "single-page-application"` already
// serves /admin from index.html, and one `startsWith` is the whole routing need.
const Page = location.pathname.startsWith("/admin") ? AdminPage : StatusPage;

createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
