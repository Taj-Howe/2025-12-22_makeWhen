import { Card, Flex, Heading, SegmentedControl, Switch, Text } from "@radix-ui/themes";
import { useEffect, useMemo, useState, type FC } from "react";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";
import { mutate, query } from "../rpc/clientSingleton";
import {
  DEFAULT_WORKDAY_END_HOUR,
  DEFAULT_WORKDAY_START_HOUR,
  formatHourLabel,
  normalizeWorkdayHours,
} from "../domain/workHours";
import { AppButton, AppSelect } from "./controls";

const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "amber", label: "Amber" },
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

type ThemeSettingsProps = {
  onSettingsChanged?: () => void;
};

const ThemeSettings: FC<ThemeSettingsProps> = ({ onSettingsChanged }) => {
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [autoArchive, setAutoArchive] = useState(false);
  const [workStartHour, setWorkStartHour] = useState(
    DEFAULT_WORKDAY_START_HOUR
  );
  const [workEndHour, setWorkEndHour] = useState(DEFAULT_WORKDAY_END_HOUR);
  const [savingWorkHours, setSavingWorkHours] = useState(false);
  const [workHoursError, setWorkHoursError] = useState<string | null>(null);

  useEffect(() => {
    setThemeState(loadTheme());
  }, []);

  useEffect(() => {
    let mounted = true;
    query<Record<string, unknown>>("getSettings", {})
      .then((settings) => {
        if (!mounted) {
          return;
        }
        setAutoArchive(settings["ui.auto_archive_on_complete"] === true);
        const normalized = normalizeWorkdayHours(
          settings["ui.workday_start_hour"],
          settings["ui.workday_end_hour"]
        );
        setWorkStartHour(normalized.startHour);
        setWorkEndHour(normalized.endHour);
      })
      .catch(() => {
        if (mounted) {
          setAutoArchive(false);
          setWorkStartHour(DEFAULT_WORKDAY_START_HOUR);
          setWorkEndHour(DEFAULT_WORKDAY_END_HOUR);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleChange = (value: string) => {
    const next = THEME_OPTIONS.find((option) => option.value === value);
    if (!next) {
      return;
    }
    setThemeState(next.value);
    setTheme(next.value);
  };

  const handleAutoArchiveChange = (checked: boolean) => {
    const previous = autoArchive;
    setAutoArchive(checked);
    mutate("set_setting", {
      key: "ui.auto_archive_on_complete",
      value: checked,
    })
      .then(() => {
        onSettingsChanged?.();
      })
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

  const workHoursSummary = `${formatHourLabel(workStartHour)}-${formatHourLabel(
    workEndHour
  )}`;

  return (
    <Card size="2">
      <Flex direction="column" gap="3">
        <Heading size="3">Theme</Heading>
        <Text size="2" color="gray">
          Choose the base appearance for the UI.
        </Text>
        <SegmentedControl.Root value={theme} onValueChange={handleChange}>
          {THEME_OPTIONS.map((option) => (
            <SegmentedControl.Item key={option.value} value={option.value}>
              {option.label}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">Behavior</Heading>
        <Flex align="center" justify="between" gap="3">
          <div>
            <Text size="2" weight="bold">
              Auto-archive on complete
            </Text>
            <Text size="1" color="gray">
              Move items into Archive when marked done.
            </Text>
          </div>
          <Switch
            checked={autoArchive}
            onCheckedChange={handleAutoArchiveChange}
          />
        </Flex>
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">Work Hours</Heading>
        <Text size="2" color="gray">
          Set the day range used by calendar scheduling. Current range:{" "}
          {workHoursSummary}
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
  );
};

export default ThemeSettings;
