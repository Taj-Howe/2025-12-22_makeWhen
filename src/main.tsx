import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./ui/App";
import "./index.css";
import { applyTheme } from "./theme/applyTheme";
import { loadTheme } from "./theme/themeStore";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

applyTheme(loadTheme());

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
