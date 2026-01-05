"use client";

import ThemeRoot from "../src/ui/ThemeRoot";
import QueryProvider from "../src/ui/QueryProvider";
import App from "../src/ui/App";

const AppRoot = () => (
  <QueryProvider>
    <ThemeRoot>
      <App />
    </ThemeRoot>
  </QueryProvider>
);

export default AppRoot;
