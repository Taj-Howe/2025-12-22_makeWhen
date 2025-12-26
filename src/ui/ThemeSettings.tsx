import { useEffect, useState, type FC } from "react";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";

const THEME_OPTIONS: ThemeName[] = ["light", "dark", "amber"];

const ThemeSettings: FC = () => {
  const [theme, setThemeState] = useState<ThemeName>("light");

  useEffect(() => {
    setThemeState(loadTheme());
  }, []);

  const handleChange = (value: ThemeName) => {
    setThemeState(value);
    setTheme(value);
  };

  return (
    <div className="theme-settings">
      <div className="theme-title">Theme</div>
      <div className="theme-options">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={
              theme === option
                ? "theme-option theme-option-active"
                : "theme-option"
            }
            onClick={() => handleChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ThemeSettings;
