import "@radix-ui/themes/styles.css";
import "../src/ui/theme/radix-colors.css";
import "../src/ui/theme/semantic-tokens.css";
import "../src/index.css";
import "../src/ui/app.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "MakeWhen",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
