import "@radix-ui/themes/styles.css";
import "../src/ui/theme/radix-colors.css";
import "../src/ui/theme/semantic-tokens.css";
import "../src/ui/app.css";

export const metadata = {
  title: "MakeWhen",
  description: "Offline-first personal project management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
