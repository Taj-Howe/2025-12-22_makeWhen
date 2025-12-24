import { useEffect, useMemo, useState, type FC } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as RadioGroup from "@radix-ui/react-radio-group";
import * as Select from "@radix-ui/react-select";
import {
  ACCENT_OPTIONS,
  DEFAULT_THEME,
  NEUTRAL_OPTIONS,
  RADIUS_OPTIONS,
} from "../theme/themeRegistry";
import type { Theme } from "../theme/themeTypes";
import { applyTheme } from "../theme/applyTheme";
import { loadTheme, saveTheme } from "../theme/themeStore";

const ThemeSettings: FC = () => {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setTheme(loadTheme());
  }, []);

  const applyAndSave = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };

  const radiusOptions = useMemo(
    () => RADIUS_OPTIONS.map((value) => String(value)),
    []
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="button">
          Theme
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="theme-overlay" />
        <Dialog.Content className="theme-dialog">
          <div className="theme-header">
            <Dialog.Title className="theme-title">Theme</Dialog.Title>
            <Dialog.Close className="button button-ghost">Close</Dialog.Close>
          </div>

          <div className="theme-section">
            <div className="theme-label">Mode</div>
            <RadioGroup.Root
              className="theme-radio-group"
              value={theme.mode}
              onValueChange={(value) =>
                applyAndSave({
                  ...theme,
                  mode: value === "light" ? "light" : "dark",
                })
              }
            >
              <label className="theme-radio-item">
                <RadioGroup.Item value="light" className="theme-radio" />
                Light
              </label>
              <label className="theme-radio-item">
                <RadioGroup.Item value="dark" className="theme-radio" />
                Dark
              </label>
            </RadioGroup.Root>
          </div>

          <div className="theme-section">
            <div className="theme-label">Accent</div>
            <Select.Root
              value={theme.accent}
              onValueChange={(value) =>
                applyAndSave({ ...theme, accent: value })
              }
            >
              <Select.Trigger className="theme-select">
                <Select.Value />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className="theme-select-content">
                  <Select.Viewport>
                    {ACCENT_OPTIONS.map((option) => (
                      <Select.Item
                        key={option}
                        value={option}
                        className="theme-select-item"
                      >
                        <Select.ItemText>{option}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>

          <div className="theme-section">
            <div className="theme-label">Neutral</div>
            <Select.Root
              value={theme.neutral}
              onValueChange={(value) =>
                applyAndSave({ ...theme, neutral: value })
              }
            >
              <Select.Trigger className="theme-select">
                <Select.Value />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className="theme-select-content">
                  <Select.Viewport>
                    {NEUTRAL_OPTIONS.map((option) => (
                      <Select.Item
                        key={option}
                        value={option}
                        className="theme-select-item"
                      >
                        <Select.ItemText>{option}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>

          <div className="theme-section">
            <div className="theme-label">Radius</div>
            <Select.Root
              value={String(theme.radius)}
              onValueChange={(value) =>
                applyAndSave({ ...theme, radius: Number(value) })
              }
            >
              <Select.Trigger className="theme-select">
                <Select.Value />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content className="theme-select-content">
                  <Select.Viewport>
                    {radiusOptions.map((value) => (
                      <Select.Item
                        key={value}
                        value={value}
                        className="theme-select-item"
                      >
                        <Select.ItemText>{value}px</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>

          <div className="theme-actions">
            <button
              type="button"
              className="button"
              onClick={() => applyAndSave({ ...DEFAULT_THEME })}
            >
              Reset to default
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ThemeSettings;
