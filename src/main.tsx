import React from "react";
import ReactDOM from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./ui/theme/radix-colors.css";
import "./ui/theme/semantic-tokens.css";
import "./index.css";
import App from "./ui/App";
import ThemeRoot from "./ui/ThemeRoot";
import QueryProvider from "./ui/QueryProvider";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryProvider>
      <ThemeRoot>
        <App />
      </ThemeRoot>
    </QueryProvider>
  </React.StrictMode>
);
