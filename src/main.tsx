import React from "react";
import ReactDOM from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./ui/theme/radix-colors.css";
import "./ui/theme/semantic-tokens.css";
import "./index.css";
import App from "./ui/App";
import { initTheme } from "./theme/themeStore";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

initTheme();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Theme appearance="dark" accentColor="indigo" grayColor="slate" radius="medium" scaling="100%">
      <App />
    </Theme>
  </React.StrictMode>
);
