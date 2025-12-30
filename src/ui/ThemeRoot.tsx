import { Theme } from "@radix-ui/themes";
import { useEffect, useState, type FC, type ReactNode } from "react";
import { initTheme, subscribeTheme, type ThemeName } from "../theme/themeStore";

type ThemeRootProps = {
  children: ReactNode;
};

const ThemeRoot: FC<ThemeRootProps> = ({ children }) => {
  const [theme, setTheme] = useState<ThemeName>(() => initTheme());

  useEffect(() => subscribeTheme(setTheme), []);

  const appearance = theme === "light" || theme === "amber" ? "light" : "dark";

  return (
    <Theme
      appearance={appearance}
      accentColor="violet"
      grayColor="mauve"
      radius="medium"
      scaling="100%"
    >
      {children}
    </Theme>
  );
};

export default ThemeRoot;
