import { Theme } from "@radix-ui/themes";
import { useEffect, useState, type FC, type ReactNode } from "react";
import { initTheme, subscribeTheme, type ThemeName } from "../theme/themeStore";

type ThemeRootProps = {
  children: ReactNode;
};

const ThemeRoot: FC<ThemeRootProps> = ({ children }) => {
  const [theme, setTheme] = useState<ThemeName>(() => initTheme());
  const [radius, setRadius] = useState<"none" | "small" | "medium" | "large">(
    "medium"
  );
  const [scaling, setScaling] = useState<"90%" | "100%" | "110%">("100%");

  useEffect(() => subscribeTheme(setTheme), []);

  const appearance = theme === "light" || theme === "amber" ? "light" : "dark";
  const accentColor = theme === "amber" ? "amber" : "violet";
  const grayColor = theme === "amber" ? "sand" : "mauve";

  const readRadiusToken = () => {
    if (typeof window === "undefined") {
      return "medium" as const;
    }
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--radius")
      .trim();
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
      return "medium" as const;
    }
    if (value <= 2) {
      return "none" as const;
    }
    if (value <= 6) {
      return "small" as const;
    }
    if (value <= 10) {
      return "medium" as const;
    }
    return "large" as const;
  };

  const readScalingToken = () => {
    if (typeof window === "undefined") {
      return "100%" as const;
    }
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-size-base")
      .trim();
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
      return "100%" as const;
    }
    if (value <= 15) {
      return "90%" as const;
    }
    if (value <= 17) {
      return "100%" as const;
    }
    return "110%" as const;
  };

  useEffect(() => {
    setRadius(readRadiusToken());
    setScaling(readScalingToken());
  }, [theme]);

  return (
    <Theme
      appearance={appearance}
      accentColor={accentColor}
      grayColor={grayColor}
      radius={radius}
      scaling={scaling}
    >
      {children}
    </Theme>
  );
};

export default ThemeRoot;
