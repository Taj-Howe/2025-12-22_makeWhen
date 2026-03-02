import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import "@radix-ui/themes/styles.css";
import "./ui/theme/radix-colors.css";
import "./ui/theme/semantic-tokens.css";
import "./index.css";
import App from "./ui/App";
import ThemeRoot from "./ui/ThemeRoot";
import { AUTH_MODE, CLERK_PUBLISHABLE_KEY } from "./auth/authConfig";
import { ClerkBridgeSync } from "./auth/clerkBridge";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const appTree = (
  <ThemeRoot>
    <App />
  </ThemeRoot>
);

const withAuthProvider = () => {
  if (AUTH_MODE !== "clerk") {
    return appTree;
  }
  if (!CLERK_PUBLISHABLE_KEY) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required when VITE_AUTH_MODE=clerk.");
  }
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <ClerkBridgeSync />
      {appTree}
    </ClerkProvider>
  );
};

ReactDOM.createRoot(root).render(<React.StrictMode>{withAuthProvider()}</React.StrictMode>);
