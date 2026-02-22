import { Card, Dialog, Flex, Heading, SegmentedControl, Switch, Text } from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  amber,
  amberDark,
  blue,
  blueDark,
  bronze,
  bronzeDark,
  cyan,
  cyanDark,
  grass,
  grassDark,
  gray,
  grayDark,
  green,
  greenDark,
  indigo,
  indigoDark,
  iris,
  irisDark,
  jade,
  jadeDark,
  mauve,
  mauveDark,
  orange,
  orangeDark,
  plum,
  plumDark,
  red,
  redDark,
  slate,
  slateDark,
  tomato,
  tomatoDark,
  yellow,
  yellowDark,
} from "@radix-ui/colors";
import { mutate, query } from "../rpc/clientSingleton";
import {
  DEFAULT_SEMANTIC_COLORS,
  type SemanticColorKey,
  applySemanticColorVars,
  normalizeSemanticColorMap,
} from "../domain/semanticColors";
import {
  DEFAULT_THEME_TOKENS,
  type ThemeTokenOverrides,
  type ThemeTokenKey,
  applyThemeTokenVars,
  clearThemeTokenVars,
  normalizeThemeTokenOverrides,
  readThemeTokensFromComputed,
} from "../domain/themeTokens";
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  FONT_SOURCE_KEYS,
  type FontSourceKey,
  type TypographySettings,
  applyTypographySettings,
  normalizeTypographySettings,
} from "../domain/typographySettings";
import {
  DEFAULT_WORKDAY_END_HOUR,
  DEFAULT_WORKDAY_START_HOUR,
  formatHourLabel,
  normalizeWorkdayHours,
} from "../domain/workHours";
import {
  isHexColor,
  normalizeUserColorMap,
  resolveUserColor,
} from "../domain/userColors";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";
import SampleDataPanel from "./SampleDataPanel";
import { AppButton, AppIconButton, AppInput, AppSelect } from "./controls";

type SettingsWindowProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsChanged?: () => void;
  onSeeded: (projectId: string) => void;
};

type UserOption = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
};

type SettingsSection = "theme" | "scheduling" | "behavior" | "data";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "theme", label: "Theme" },
  { id: "scheduling", label: "Scheduling" },
  { id: "behavior", label: "Behavior" },
  { id: "data", label: "Data" },
];

const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "custom", label: "Custom" },
];

const SEMANTIC_COLOR_LABELS: Array<{ key: SemanticColorKey; label: string }> = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "tertiary", label: "Tertiary" },
  { key: "milestone", label: "Milestone" },
  { key: "task", label: "Task" },
  { key: "scheduled", label: "Scheduled" },
  { key: "deadline", label: "Deadline" },
];

const THEME_TOKEN_LABELS: Array<{ key: ThemeTokenKey; label: string }> = [
  { key: "bg", label: "Background" },
  { key: "panel", label: "Panel" },
  { key: "panel2", label: "Panel 2" },
  { key: "text", label: "Text" },
  { key: "muted", label: "Muted Text" },
  { key: "border", label: "Border" },
  { key: "borderHover", label: "Border Hover" },
  { key: "accent", label: "Accent" },
  { key: "accentText", label: "Accent Text" },
  { key: "accentBorder", label: "Accent Border" },
  { key: "danger", label: "Danger" },
  { key: "warning", label: "Warning" },
  { key: "success", label: "Success" },
  { key: "glassBg", label: "Glass Background" },
  { key: "glassBorder", label: "Glass Border" },
  { key: "glassHighlight", label: "Glass Highlight" },
  { key: "overlayScrim", label: "Overlay Scrim" },
];

const START_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  label: formatHourLabel(hour),
}));
const END_HOUR_OPTIONS = Array.from({ length: 24 }, (_, offset) => {
  const hour = offset + 1;
  return {
    hour,
    label: formatHourLabel(hour),
  };
});

const FONT_SOURCE_LABELS: Record<Exclude<FontSourceKey, "custom1" | "custom2">, string> =
  {
    ibmMono: "IBM Plex Mono",
    systemSans: "System Sans",
    systemSerif: "System Serif",
  };

const FONT_SIZE_OPTIONS = Array.from({ length: 31 }, (_, index) => {
  const value = index + 10;
  return { value: String(value), label: `${value}px` };
});

const FONT_WEIGHT_OPTIONS = [300, 400, 500, 600, 700, 800].map((value) => ({
  value: String(value),
  label: String(value),
}));

type ColorSelectionMode = "picker" | "radix";

type RadixColorFamily = {
  key: string;
  label: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};

const RADIX_COLOR_SWATCH_STEPS = [3, 4, 5, 6, 7, 8, 9, 10, 11];

const RADIX_COLOR_FAMILIES: RadixColorFamily[] = [
  { key: "gray", label: "Gray", light: gray, dark: grayDark },
  { key: "mauve", label: "Mauve", light: mauve, dark: mauveDark },
  { key: "slate", label: "Slate", light: slate, dark: slateDark },
  { key: "bronze", label: "Bronze", light: bronze, dark: bronzeDark },
  { key: "blue", label: "Blue", light: blue, dark: blueDark },
  { key: "indigo", label: "Indigo", light: indigo, dark: indigoDark },
  { key: "iris", label: "Iris", light: iris, dark: irisDark },
  { key: "jade", label: "Jade", light: jade, dark: jadeDark },
  { key: "cyan", label: "Cyan", light: cyan, dark: cyanDark },
  { key: "green", label: "Green", light: green, dark: greenDark },
  { key: "grass", label: "Grass", light: grass, dark: grassDark },
  { key: "yellow", label: "Yellow", light: yellow, dark: yellowDark },
  { key: "amber", label: "Amber", light: amber, dark: amberDark },
  { key: "orange", label: "Orange", light: orange, dark: orangeDark },
  { key: "tomato", label: "Tomato", light: tomato, dark: tomatoDark },
  { key: "red", label: "Red", light: red, dark: redDark },
  { key: "plum", label: "Plum", light: plum, dark: plumDark },
];

const SettingsWindow: FC<SettingsWindowProps> = ({
  open,
  onOpenChange,
  onSettingsChanged,
  onSeeded,
}) => {
  const [activeSection, setActiveSection] = useState<SettingsSection>("theme");
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [autoArchive, setAutoArchive] = useState(false);
  const [workStartHour, setWorkStartHour] = useState(
    DEFAULT_WORKDAY_START_HOUR
  );
  const [workEndHour, setWorkEndHour] = useState(DEFAULT_WORKDAY_END_HOUR);
  const [workHoursError, setWorkHoursError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [userColorMap, setUserColorMap] = useState<Record<string, string>>({});
  const [userColorsError, setUserColorsError] = useState<string | null>(null);
  const [semanticColors, setSemanticColors] = useState(DEFAULT_SEMANTIC_COLORS);
  const [semanticColorsError, setSemanticColorsError] = useState<string | null>(
    null
  );
  const [themeTokens, setThemeTokens] = useState(DEFAULT_THEME_TOKENS);
  const [themeTokenOverrides, setThemeTokenOverrides] =
    useState<ThemeTokenOverrides>({});
  const themeTokenOverridesRef = useRef<ThemeTokenOverrides>({});
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const [typography, setTypography] = useState<TypographySettings>(
    DEFAULT_TYPOGRAPHY_SETTINGS
  );
  const [typographyError, setTypographyError] = useState<string | null>(null);
  const [themeTokensError, setThemeTokensError] = useState<string | null>(null);
  const [savingWorkHours, setSavingWorkHours] = useState(false);
  const [savingUserColors, setSavingUserColors] = useState(false);
  const [savingSemanticColors, setSavingSemanticColors] = useState(false);
  const [savingThemeTokens, setSavingThemeTokens] = useState(false);
  const [savingTypography, setSavingTypography] = useState(false);
  const [colorSelectionMode, setColorSelectionMode] =
    useState<ColorSelectionMode>("picker");
  const [activeColorPanel, setActiveColorPanel] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setThemeState(loadTheme());
    let mounted = true;
    query<Record<string, unknown>>("getSettings", {})
      .then((settings) => {
        if (!mounted) {
          return;
        }
        setAutoArchive(settings["ui.auto_archive_on_complete"] === true);
        const normalizedHours = normalizeWorkdayHours(
          settings["ui.workday_start_hour"],
          settings["ui.workday_end_hour"]
        );
        setWorkStartHour(normalizedHours.startHour);
        setWorkEndHour(normalizedHours.endHour);
        setUserColorMap(normalizeUserColorMap(settings["ui.user_colors"]));
        const nextSemanticColors = normalizeSemanticColorMap(
          settings["ui.semantic_colors"]
        );
        setSemanticColors(nextSemanticColors);
        const nextThemeTokenOverrides = normalizeThemeTokenOverrides(
          settings["ui.theme_tokens"]
        );
        const nextTypography = normalizeTypographySettings(
          settings["ui.typography"]
        );
        setTypography(nextTypography);
        themeTokenOverridesRef.current = nextThemeTokenOverrides;
        setThemeTokenOverrides(nextThemeTokenOverrides);
        if (typeof document !== "undefined") {
          applySemanticColorVars(document.documentElement, nextSemanticColors);
          clearThemeTokenVars(document.documentElement);
          applyThemeTokenVars(
            document.documentElement,
            nextThemeTokenOverrides
          );
          applyTypographySettings(document.documentElement, nextTypography);
          const computedTokens = readThemeTokensFromComputed(
            document.documentElement
          );
          setThemeTokens({
            ...computedTokens,
            ...nextThemeTokenOverrides,
          });
        } else {
          setThemeTokens({
            ...DEFAULT_THEME_TOKENS,
            ...nextThemeTokenOverrides,
          });
          setThemeTokenOverrides(nextThemeTokenOverrides);
        }
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        setAutoArchive(false);
        setWorkStartHour(DEFAULT_WORKDAY_START_HOUR);
        setWorkEndHour(DEFAULT_WORKDAY_END_HOUR);
        setUserColorMap({});
        setSemanticColors(DEFAULT_SEMANTIC_COLORS);
        setTypography(DEFAULT_TYPOGRAPHY_SETTINGS);
        if (typeof document !== "undefined") {
          applySemanticColorVars(document.documentElement, DEFAULT_SEMANTIC_COLORS);
          clearThemeTokenVars(document.documentElement);
          setThemeTokens(readThemeTokensFromComputed(document.documentElement));
          setThemeTokenOverrides({});
          themeTokenOverridesRef.current = {};
          applyTypographySettings(
            document.documentElement,
            DEFAULT_TYPOGRAPHY_SETTINGS
          );
        } else {
          setThemeTokens(DEFAULT_THEME_TOKENS);
          setThemeTokenOverrides({});
          themeTokenOverridesRef.current = {};
        }
      });

    query<{ users: UserOption[] }>("users_list", {})
      .then((result) => {
        if (!mounted) {
          return;
        }
        setUsers(result.users ?? []);
      })
      .catch(() => {
        if (mounted) {
          setUsers([]);
        }
      });

    return () => {
      mounted = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const node = mainScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = 0;
  }, [activeSection, open]);

  const startHourOptions = useMemo(
    () =>
      START_HOUR_OPTIONS.map((option) => ({
        value: String(option.hour),
        label: option.label,
        disabled: option.hour >= workEndHour,
      })),
    [workEndHour]
  );
  const endHourOptions = useMemo(
    () =>
      END_HOUR_OPTIONS.map((option) => ({
        value: String(option.hour),
        label: option.label,
        disabled: option.hour <= workStartHour,
      })),
    [workStartHour]
  );

  const currentSectionLabel = useMemo(
    () =>
      SETTINGS_SECTIONS.find((section) => section.id === activeSection)?.label ??
      "Settings",
    [activeSection]
  );

  const fontSourceOptions = useMemo(
    () =>
      FONT_SOURCE_KEYS.map((key) => ({
        value: key,
        label:
          key === "custom1"
            ? typography.customFonts.custom1.label || "Custom Font 1"
            : key === "custom2"
            ? typography.customFonts.custom2.label || "Custom Font 2"
            : FONT_SOURCE_LABELS[key],
      })),
    [typography.customFonts.custom1.label, typography.customFonts.custom2.label]
  );

  const handleThemeChange = (value: string) => {
    const next = THEME_OPTIONS.find((option) => option.value === value);
    if (!next) {
      return;
    }
    setThemeState(next.value);
    setTheme(next.value);
  };

  const resolveRadixScale = (family: RadixColorFamily) =>
    theme === "dark" ? family.dark : family.light;

  const getRadixColor = (family: RadixColorFamily, step: number) => {
    const scale = resolveRadixScale(family);
    const key = `${family.key}${step}`;
    return scale[key] ?? null;
  };

  const handleColorSelectionModeChange = (value: string) => {
    const nextMode: ColorSelectionMode = value === "radix" ? "radix" : "picker";
    setColorSelectionMode(nextMode);
    if (nextMode !== "radix") {
      setActiveColorPanel(null);
    }
  };

  const handleAutoArchiveChange = (checked: boolean) => {
    const previous = autoArchive;
    setAutoArchive(checked);
    mutate("set_setting", {
      key: "ui.auto_archive_on_complete",
      value: checked,
    })
      .then(() => onSettingsChanged?.())
      .catch(() => {
        setAutoArchive(previous);
      });
  };

  const handleWorkStartChange = (value: string) => {
    const nextStart = Number.parseInt(value, 10);
    if (!Number.isFinite(nextStart)) {
      return;
    }
    const normalized = normalizeWorkdayHours(nextStart, workEndHour);
    setWorkStartHour(normalized.startHour);
    setWorkEndHour(normalized.endHour);
    setWorkHoursError(null);
  };

  const handleWorkEndChange = (value: string) => {
    const nextEnd = Number.parseInt(value, 10);
    if (!Number.isFinite(nextEnd)) {
      return;
    }
    const normalized = normalizeWorkdayHours(workStartHour, nextEnd);
    setWorkStartHour(normalized.startHour);
    setWorkEndHour(normalized.endHour);
    setWorkHoursError(null);
  };

  const handleSaveWorkHours = async () => {
    setSavingWorkHours(true);
    setWorkHoursError(null);
    try {
      await Promise.all([
        mutate("set_setting", {
          key: "ui.workday_start_hour",
          value: workStartHour,
        }),
        mutate("set_setting", {
          key: "ui.workday_end_hour",
          value: workEndHour,
        }),
      ]);
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setWorkHoursError(message);
    } finally {
      setSavingWorkHours(false);
    }
  };

  const handleUserColorChange = (userId: string, color: string) => {
    const normalized = color.trim().toLowerCase();
    if (!isHexColor(normalized)) {
      return;
    }
    setUserColorMap((prev) => ({ ...prev, [userId]: normalized }));
    setUserColorsError(null);
  };

  const handleSaveUserColors = async () => {
    setSavingUserColors(true);
    setUserColorsError(null);
    try {
      await mutate("set_setting", {
        key: "ui.user_colors",
        value: userColorMap,
      });
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUserColorsError(message);
    } finally {
      setSavingUserColors(false);
    }
  };

  const handleResetUserColors = async () => {
    setSavingUserColors(true);
    setUserColorsError(null);
    try {
      await mutate("set_setting", {
        key: "ui.user_colors",
        value: {},
      });
      setUserColorMap({});
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUserColorsError(message);
    } finally {
      setSavingUserColors(false);
    }
  };

  const handleSemanticColorChange = (key: SemanticColorKey, color: string) => {
    const normalized = color.trim().toLowerCase();
    if (!isHexColor(normalized)) {
      return;
    }
    setSemanticColors((prev) => {
      const next = {
        ...prev,
        [key]: normalized,
      };
      if (typeof document !== "undefined") {
        applySemanticColorVars(document.documentElement, next);
      }
      return next;
    });
    setSemanticColorsError(null);
  };

  const handleSaveSemanticColors = async () => {
    setSavingSemanticColors(true);
    setSemanticColorsError(null);
    try {
      await mutate("set_setting", {
        key: "ui.semantic_colors",
        value: semanticColors,
      });
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSemanticColorsError(message);
    } finally {
      setSavingSemanticColors(false);
    }
  };

  const handleResetSemanticColors = async () => {
    setSavingSemanticColors(true);
    setSemanticColorsError(null);
    try {
      await mutate("set_setting", {
        key: "ui.semantic_colors",
        value: DEFAULT_SEMANTIC_COLORS,
      });
      setSemanticColors(DEFAULT_SEMANTIC_COLORS);
      if (typeof document !== "undefined") {
        applySemanticColorVars(document.documentElement, DEFAULT_SEMANTIC_COLORS);
      }
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSemanticColorsError(message);
    } finally {
      setSavingSemanticColors(false);
    }
  };

  const handleThemeTokenChange = (key: ThemeTokenKey, color: string) => {
    const normalized = color.trim().toLowerCase();
    if (!isHexColor(normalized)) {
      return;
    }
    const nextOverrides = {
      ...themeTokenOverridesRef.current,
      [key]: normalized,
    };
    themeTokenOverridesRef.current = nextOverrides;
    setThemeTokens((prev) => ({
      ...prev,
      [key]: normalized,
    }));
    setThemeTokenOverrides(nextOverrides);
    if (typeof document !== "undefined") {
      clearThemeTokenVars(document.documentElement);
      applyThemeTokenVars(document.documentElement, nextOverrides);
    }
    setThemeTokensError(null);
  };

  const handleSaveThemeTokens = async () => {
    setSavingThemeTokens(true);
    setThemeTokensError(null);
    try {
      await mutate("set_setting", {
        key: "ui.theme_tokens",
        value: themeTokenOverridesRef.current,
      });
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setThemeTokensError(message);
    } finally {
      setSavingThemeTokens(false);
    }
  };

  const handleResetThemeTokens = async () => {
    setSavingThemeTokens(true);
    setThemeTokensError(null);
    try {
      await mutate("set_setting", {
        key: "ui.theme_tokens",
        value: {},
      });
      if (typeof document !== "undefined") {
        clearThemeTokenVars(document.documentElement);
        setThemeTokens(readThemeTokensFromComputed(document.documentElement));
        setThemeTokenOverrides({});
        themeTokenOverridesRef.current = {};
      } else {
        setThemeTokens(DEFAULT_THEME_TOKENS);
        setThemeTokenOverrides({});
        themeTokenOverridesRef.current = {};
      }
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setThemeTokensError(message);
    } finally {
      setSavingThemeTokens(false);
    }
  };

  const applyTypographyPreview = (next: TypographySettings) => {
    setTypography(next);
    if (typeof document !== "undefined") {
      applyTypographySettings(document.documentElement, next);
    }
    setTypographyError(null);
  };

  const handleTypographyFieldChange = (
    key:
      | "bodyFont"
      | "headingFont"
      | "bodySizePx"
      | "labelSizePx"
      | "titleSizePx"
      | "bodyWeight"
      | "headingWeight",
    value: string
  ) => {
    if (key === "bodyFont" || key === "headingFont") {
      if (!FONT_SOURCE_KEYS.includes(value as FontSourceKey)) {
        return;
      }
      applyTypographyPreview({
        ...typography,
        [key]: value as FontSourceKey,
      });
      return;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }
    applyTypographyPreview({
      ...typography,
      [key]: parsed,
    } as TypographySettings);
  };

  const handleCustomFontChange = (
    key: "custom1" | "custom2",
    field: "label" | "family" | "url",
    value: string
  ) => {
    const next = normalizeTypographySettings({
      ...typography,
      customFonts: {
        ...typography.customFonts,
        [key]: {
          ...typography.customFonts[key],
          [field]: value,
        },
      },
    });
    applyTypographyPreview(next);
  };

  const handleSaveTypography = async () => {
    setSavingTypography(true);
    setTypographyError(null);
    try {
      const normalized = normalizeTypographySettings(typography);
      await mutate("set_setting", {
        key: "ui.typography",
        value: normalized,
      });
      applyTypographyPreview(normalized);
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setTypographyError(message);
    } finally {
      setSavingTypography(false);
    }
  };

  const handleResetTypography = async () => {
    setSavingTypography(true);
    setTypographyError(null);
    try {
      await mutate("set_setting", {
        key: "ui.typography",
        value: DEFAULT_TYPOGRAPHY_SETTINGS,
      });
      applyTypographyPreview(DEFAULT_TYPOGRAPHY_SETTINGS);
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setTypographyError(message);
    } finally {
      setSavingTypography(false);
    }
  };

  const renderColorControl = (
    panelId: string,
    value: string,
    onChange: (color: string) => void
  ) => (
    <Flex direction="column" align="end" gap="2">
      <Flex align="center" gap="2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{
            width: 44,
            minWidth: 44,
            height: 28,
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            background: "var(--color-panel)",
            padding: "2px",
          }}
        />
        {colorSelectionMode === "radix" ? (
          <AppButton
            type="button"
            variant="ghost"
            onClick={() =>
              setActiveColorPanel((prev) => (prev === panelId ? null : panelId))
            }
          >
            {activeColorPanel === panelId ? "Hide panel" : "Radix panel"}
          </AppButton>
        ) : null}
        <Text size="1" color="gray">
          {value}
        </Text>
      </Flex>
      {colorSelectionMode === "radix" && activeColorPanel === panelId ? (
        <div className="radix-color-panel">
          {RADIX_COLOR_FAMILIES.map((family) => (
            <div key={`${panelId}-${family.key}`} className="radix-color-family">
              <Text size="1" color="gray" className="radix-color-family-label">
                {family.label}
              </Text>
              <div className="radix-color-swatch-grid">
                {RADIX_COLOR_SWATCH_STEPS.map((step) => {
                  const swatch = getRadixColor(family, step);
                  if (!swatch) {
                    return null;
                  }
                  const isActive = swatch.toLowerCase() === value.toLowerCase();
                  return (
                    <button
                      key={`${panelId}-${family.key}-${step}`}
                      type="button"
                      className={
                        isActive
                          ? "radix-color-swatch is-active"
                          : "radix-color-swatch"
                      }
                      style={{ backgroundColor: swatch }}
                      aria-label={`${family.label} ${step}`}
                      title={`${family.label} ${step}`}
                      onClick={() => onChange(swatch)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Flex>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="settings-window-content">
        <div className="settings-window-header">
          <div>
            <Dialog.Title className="settings-window-title">Settings</Dialog.Title>
            <Text size="1" color="gray">
              {currentSectionLabel}
            </Text>
          </div>
          <AppIconButton
            type="button"
            variant="ghost"
            aria-label="Close settings"
            onClick={() => onOpenChange(false)}
          >
            ✕
          </AppIconButton>
        </div>
        <div className="settings-window-shell">
          <aside className="settings-window-sidebar">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={
                  section.id === activeSection
                    ? "settings-nav-button is-active"
                    : "settings-nav-button"
                }
                onClick={() => setActiveSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </aside>
          <section ref={mainScrollRef} className="settings-window-main">
            {activeSection === "theme" ? (
              <Flex direction="column" gap="4">
                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Theme Mode</Heading>
                    <Text size="2" color="gray">
                      Choose the base appearance for the workspace.
                    </Text>
                    <SegmentedControl.Root
                      value={theme}
                      onValueChange={handleThemeChange}
                    >
                      {THEME_OPTIONS.map((option) => (
                        <SegmentedControl.Item
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
                        </SegmentedControl.Item>
                      ))}
                    </SegmentedControl.Root>
                  </Flex>
                </Card>

                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Typography</Heading>
                    <Text size="2" color="gray">
                      Set fonts, size, and weight by usage in the app.
                    </Text>
                    <Flex direction="column" gap="3">
                      <Flex align="center" justify="between" gap="3" wrap="wrap">
                        <label style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <Text size="1" color="gray">
                            Body font
                          </Text>
                          <AppSelect
                            value={typography.bodyFont}
                            onChange={(value) =>
                              handleTypographyFieldChange("bodyFont", value)
                            }
                            options={fontSourceOptions}
                          />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <Text size="1" color="gray">
                            Heading font
                          </Text>
                          <AppSelect
                            value={typography.headingFont}
                            onChange={(value) =>
                              handleTypographyFieldChange("headingFont", value)
                            }
                            options={fontSourceOptions}
                          />
                        </label>
                      </Flex>

                      <Flex align="center" justify="between" gap="3" wrap="wrap">
                        <label style={{ display: "grid", gap: 6, minWidth: 160 }}>
                          <Text size="1" color="gray">
                            Body size
                          </Text>
                          <AppSelect
                            value={String(typography.bodySizePx)}
                            onChange={(value) =>
                              handleTypographyFieldChange("bodySizePx", value)
                            }
                            options={FONT_SIZE_OPTIONS}
                          />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 160 }}>
                          <Text size="1" color="gray">
                            Label size
                          </Text>
                          <AppSelect
                            value={String(typography.labelSizePx)}
                            onChange={(value) =>
                              handleTypographyFieldChange("labelSizePx", value)
                            }
                            options={FONT_SIZE_OPTIONS}
                          />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 160 }}>
                          <Text size="1" color="gray">
                            Title size
                          </Text>
                          <AppSelect
                            value={String(typography.titleSizePx)}
                            onChange={(value) =>
                              handleTypographyFieldChange("titleSizePx", value)
                            }
                            options={FONT_SIZE_OPTIONS}
                          />
                        </label>
                      </Flex>

                      <Flex align="center" justify="between" gap="3" wrap="wrap">
                        <label style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <Text size="1" color="gray">
                            Body weight
                          </Text>
                          <AppSelect
                            value={String(typography.bodyWeight)}
                            onChange={(value) =>
                              handleTypographyFieldChange("bodyWeight", value)
                            }
                            options={FONT_WEIGHT_OPTIONS}
                          />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <Text size="1" color="gray">
                            Heading weight
                          </Text>
                          <AppSelect
                            value={String(typography.headingWeight)}
                            onChange={(value) =>
                              handleTypographyFieldChange("headingWeight", value)
                            }
                            options={FONT_WEIGHT_OPTIONS}
                          />
                        </label>
                      </Flex>
                    </Flex>

                    <Flex direction="column" gap="3">
                      {(["custom1", "custom2"] as const).map((slotKey) => (
                        <Flex
                          key={slotKey}
                          direction="column"
                          gap="2"
                          style={{
                            padding: "10px",
                            border: "1px solid var(--color-border)",
                            borderRadius: "var(--radius)",
                          }}
                        >
                          <Text size="2" weight="bold">
                            {slotKey === "custom1" ? "Custom Font 1" : "Custom Font 2"}
                          </Text>
                          <label style={{ display: "grid", gap: 6 }}>
                            <Text size="1" color="gray">
                              Display name
                            </Text>
                            <AppInput
                              value={typography.customFonts[slotKey].label}
                              onChange={(event) =>
                                handleCustomFontChange(
                                  slotKey,
                                  "label",
                                  event.target.value
                                )
                              }
                            />
                          </label>
                          <label style={{ display: "grid", gap: 6 }}>
                            <Text size="1" color="gray">
                              Font family stack
                            </Text>
                            <AppInput
                              value={typography.customFonts[slotKey].family}
                              onChange={(event) =>
                                handleCustomFontChange(
                                  slotKey,
                                  "family",
                                  event.target.value
                                )
                              }
                              placeholder='"Inter", -apple-system, sans-serif'
                            />
                          </label>
                          <label style={{ display: "grid", gap: 6 }}>
                            <Text size="1" color="gray">
                              Stylesheet URL (optional)
                            </Text>
                            <AppInput
                              value={typography.customFonts[slotKey].url}
                              onChange={(event) =>
                                handleCustomFontChange(slotKey, "url", event.target.value)
                              }
                              placeholder="https://fonts.googleapis.com/css2?family=Inter:wght@400;600"
                            />
                          </label>
                        </Flex>
                      ))}
                    </Flex>

                    <Flex align="center" gap="2">
                      <AppButton
                        type="button"
                        variant="surface"
                        onClick={() => void handleSaveTypography()}
                        disabled={savingTypography}
                      >
                        {savingTypography ? "Saving..." : "Save typography"}
                      </AppButton>
                      <AppButton
                        type="button"
                        variant="ghost"
                        onClick={() => void handleResetTypography()}
                        disabled={savingTypography}
                      >
                        Reset typography defaults
                      </AppButton>
                    </Flex>
                    {typographyError ? (
                      <Text size="1" color="red">
                        {typographyError}
                      </Text>
                    ) : null}
                  </Flex>
                </Card>

                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Color Selection</Heading>
                    <Text size="2" color="gray">
                      Choose how you want to pick colors in settings.
                    </Text>
                    <SegmentedControl.Root
                      value={colorSelectionMode}
                      onValueChange={handleColorSelectionModeChange}
                    >
                      <SegmentedControl.Item value="picker">
                        Native picker
                      </SegmentedControl.Item>
                      <SegmentedControl.Item value="radix">
                        Radix panel
                      </SegmentedControl.Item>
                    </SegmentedControl.Root>
                  </Flex>
                </Card>

                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Workspace Colors</Heading>
                    <Text size="2" color="gray">
                      Set the global UI colors used across the app.
                    </Text>
                    <Flex direction="column" gap="2">
                      {THEME_TOKEN_LABELS.map((entry) => (
                        <Flex key={entry.key} align="center" justify="between" gap="3">
                          <Text size="2">{entry.label}</Text>
                          {renderColorControl(
                            `theme-token-${entry.key}`,
                            themeTokens[entry.key],
                            (color) => handleThemeTokenChange(entry.key, color)
                          )}
                        </Flex>
                      ))}
                    </Flex>
                    <Flex align="center" gap="2">
                      <AppButton
                        type="button"
                        variant="surface"
                        onClick={() => void handleSaveThemeTokens()}
                        disabled={savingThemeTokens}
                      >
                        {savingThemeTokens ? "Saving..." : "Save workspace colors"}
                      </AppButton>
                      <AppButton
                        type="button"
                        variant="ghost"
                        onClick={() => void handleResetThemeTokens()}
                        disabled={savingThemeTokens}
                      >
                        Reset workspace defaults
                      </AppButton>
                    </Flex>
                    {themeTokensError ? (
                      <Text size="1" color="red">
                        {themeTokensError}
                      </Text>
                    ) : null}
                  </Flex>
                </Card>

                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Semantic Colors</Heading>
                    <Text size="2" color="gray">
                      Control task, milestone, scheduled block, and deadline role
                      colors.
                    </Text>
                    <Flex direction="column" gap="2">
                      {SEMANTIC_COLOR_LABELS.map((entry) => (
                        <Flex key={entry.key} align="center" justify="between" gap="3">
                          <Text size="2">{entry.label}</Text>
                          {renderColorControl(
                            `semantic-color-${entry.key}`,
                            semanticColors[entry.key],
                            (color) => handleSemanticColorChange(entry.key, color)
                          )}
                        </Flex>
                      ))}
                    </Flex>
                    <Flex align="center" gap="2">
                      <AppButton
                        type="button"
                        variant="surface"
                        onClick={() => void handleSaveSemanticColors()}
                        disabled={savingSemanticColors}
                      >
                        {savingSemanticColors ? "Saving..." : "Save semantic colors"}
                      </AppButton>
                      <AppButton
                        type="button"
                        variant="ghost"
                        onClick={() => void handleResetSemanticColors()}
                        disabled={savingSemanticColors}
                      >
                        Reset semantic defaults
                      </AppButton>
                    </Flex>
                    {semanticColorsError ? (
                      <Text size="1" color="red">
                        {semanticColorsError}
                      </Text>
                    ) : null}
                  </Flex>
                </Card>

                <Card size="2">
                  <Flex direction="column" gap="3">
                    <Heading size="3">Assignee Colors</Heading>
                    <Text size="2" color="gray">
                      Set calendar colors per assignee.
                    </Text>
                    {users.length === 0 ? (
                      <Text size="1" color="gray">
                        No assignees yet. Colors appear after users are assigned.
                      </Text>
                    ) : (
                      <Flex direction="column" gap="2">
                        {users.map((user) => {
                          const color = resolveUserColor(user.user_id, userColorMap);
                          return (
                            <Flex
                              key={user.user_id}
                              align="center"
                              justify="between"
                              gap="3"
                            >
                              <Text size="2">{user.display_name}</Text>
                              {renderColorControl(
                                `user-color-${user.user_id}`,
                                color,
                                (nextColor) =>
                                  handleUserColorChange(user.user_id, nextColor)
                              )}
                            </Flex>
                          );
                        })}
                      </Flex>
                    )}
                    <Flex align="center" gap="2">
                      <AppButton
                        type="button"
                        variant="surface"
                        onClick={() => void handleSaveUserColors()}
                        disabled={savingUserColors}
                      >
                        {savingUserColors ? "Saving..." : "Save assignee colors"}
                      </AppButton>
                      <AppButton
                        type="button"
                        variant="ghost"
                        onClick={() => void handleResetUserColors()}
                        disabled={savingUserColors}
                      >
                        Reset assignee defaults
                      </AppButton>
                    </Flex>
                    {userColorsError ? (
                      <Text size="1" color="red">
                        {userColorsError}
                      </Text>
                    ) : null}
                  </Flex>
                </Card>
              </Flex>
            ) : null}

            {activeSection === "scheduling" ? (
              <Card size="2">
                <Flex direction="column" gap="3">
                  <Heading size="3">Work Hours</Heading>
                  <Text size="2" color="gray">
                    Set the calendar scheduling range for your day.
                  </Text>
                  <Flex align="end" gap="3" wrap="wrap">
                    <label style={{ display: "grid", gap: 6, minWidth: 120 }}>
                      <Text size="1" color="gray">
                        Start
                      </Text>
                      <AppSelect
                        value={String(workStartHour)}
                        onChange={handleWorkStartChange}
                        options={startHourOptions}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6, minWidth: 120 }}>
                      <Text size="1" color="gray">
                        End
                      </Text>
                      <AppSelect
                        value={String(workEndHour)}
                        onChange={handleWorkEndChange}
                        options={endHourOptions}
                      />
                    </label>
                    <AppButton
                      type="button"
                      variant="surface"
                      onClick={() => void handleSaveWorkHours()}
                      disabled={savingWorkHours}
                    >
                      {savingWorkHours ? "Saving..." : "Save hours"}
                    </AppButton>
                  </Flex>
                  {workHoursError ? (
                    <Text size="1" color="red">
                      {workHoursError}
                    </Text>
                  ) : null}
                </Flex>
              </Card>
            ) : null}

            {activeSection === "behavior" ? (
              <Card size="2">
                <Flex direction="column" gap="3">
                  <Heading size="3">Behavior</Heading>
                  <Flex align="center" justify="between" gap="3">
                    <div>
                      <Text size="2" weight="bold">
                        Auto-archive on complete
                      </Text>
                      <Text size="1" color="gray">
                        Move items into archive when marked done.
                      </Text>
                    </div>
                    <Switch
                      checked={autoArchive}
                      onCheckedChange={handleAutoArchiveChange}
                    />
                  </Flex>
                </Flex>
              </Card>
            ) : null}

            {activeSection === "data" ? (
              <Card size="2">
                <Flex direction="column" gap="3">
                  <Heading size="3">Sample Data</Heading>
                  <Text size="2" color="gray">
                    Seed a complete sample project with milestones, tasks, and
                    scheduled blocks.
                  </Text>
                  <SampleDataPanel
                    onSeeded={onSeeded}
                    onRefresh={() => onSettingsChanged?.()}
                  />
                </Flex>
              </Card>
            ) : null}
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default SettingsWindow;
