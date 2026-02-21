import { Card, Flex, Heading, SegmentedControl, Switch, Text } from "@radix-ui/themes";
import { useEffect, useMemo, useState, type FC } from "react";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";
import { mutate, query, request } from "../rpc/clientSingleton";
import {
  DEFAULT_WORKDAY_END_HOUR,
  DEFAULT_WORKDAY_START_HOUR,
  formatHourLabel,
  normalizeWorkdayHours,
} from "../domain/workHours";
import {
  STORAGE_BACKEND_ENV_KEY,
  normalizeStorageBackendPreference,
} from "../domain/storageRuntime";
import {
  normalizeUserColorMap,
  resolveUserColor,
} from "../domain/userColors";
import { AppButton, AppInput, AppSelect } from "./controls";

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

type DbInfo = {
  ok: boolean;
  storageBackend?: string;
  persistent?: boolean;
  preference?: string;
  fallbackFrom?: string | null;
  fallbackReason?: string | null;
  vfs?: string;
  filename?: string;
  schemaVersion?: number;
  error?: string;
};

type UserLite = {
  user_id: string;
  display_name: string;
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
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncServerUrl, setSyncServerUrl] = useState("");
  const [savingSync, setSavingSync] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [userColors, setUserColors] = useState<Record<string, string>>({});
  const [savingUserColors, setSavingUserColors] = useState(false);
  const [userColorsError, setUserColorsError] = useState<string | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [dbInfoError, setDbInfoError] = useState<string | null>(null);

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
        setSyncEnabled(settings["sync.enabled"] === true);
        setSyncServerUrl(
          typeof settings["sync.server_url"] === "string"
            ? (settings["sync.server_url"] as string)
            : ""
        );
        setUserColors(normalizeUserColorMap(settings["ui.user_colors"]));
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
          setSyncEnabled(false);
          setSyncServerUrl("");
          setUserColors({});
          setWorkStartHour(DEFAULT_WORKDAY_START_HOUR);
          setWorkEndHour(DEFAULT_WORKDAY_END_HOUR);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    request<DbInfo>("dbInfo")
      .then((info) => {
        if (!mounted) {
          return;
        }
        setDbInfo(info);
        setDbInfoError(null);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setDbInfo(null);
        setDbInfoError(message);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    query<{ users: UserLite[] }>("users_list", {})
      .then((result) => {
        if (!mounted) {
          return;
        }
        setUsers(result.users ?? []);
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        setUsers([]);
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

  const handleSaveSyncSettings = async () => {
    setSavingSync(true);
    setSyncError(null);
    try {
      await Promise.all([
        mutate("set_setting", {
          key: "sync.enabled",
          value: syncEnabled,
        }),
        mutate("set_setting", {
          key: "sync.server_url",
          value: syncServerUrl.trim() || null,
        }),
      ]);
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSyncError(message);
    } finally {
      setSavingSync(false);
    }
  };

  const handleUserColorChange = (userId: string, color: string) => {
    setUserColors((prev) => ({ ...prev, [userId]: color }));
    setUserColorsError(null);
  };

  const handleSaveUserColors = async () => {
    setSavingUserColors(true);
    setUserColorsError(null);
    try {
      await mutate("set_setting", {
        key: "ui.user_colors",
        value: normalizeUserColorMap(userColors),
      });
      onSettingsChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUserColorsError(message);
    } finally {
      setSavingUserColors(false);
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
  const envPreference = normalizeStorageBackendPreference(
    import.meta.env[STORAGE_BACKEND_ENV_KEY]
  );
  const dbStorageSummary = dbInfo?.ok
    ? dbInfo.storageBackend === "sqlite-opfs"
      ? "SQLite WASM + OPFS (persistent local data)"
      : "SQLite WASM in memory (non-persistent fallback)"
    : "Unavailable";
  const dbStorageDetail = dbInfo?.ok
    ? `${dbInfo.vfs ?? "unknown"} · schema v${dbInfo.schemaVersion ?? "?"}`
    : dbInfo?.error ?? dbInfoError ?? "Unavailable";

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
        <Heading size="3">Storage</Heading>
        <Text size="2" color="gray">
          Default mode is local-first SQLite in OPFS. Native desktop/mobile
          builds should use platform SQLite with the same sync protocol.
        </Text>
        <Text size="2">
          Active backend: {dbStorageSummary}
        </Text>
        <Text size="1" color="gray">
          {dbStorageDetail}
        </Text>
        <Text size="1" color="gray">
          Build preference ({STORAGE_BACKEND_ENV_KEY}): {envPreference}
        </Text>
        {dbInfo?.ok && dbInfo.fallbackFrom ? (
          <Text size="1" color="orange">
            OPFS unavailable at runtime. Falling back to in-memory SQLite
            ({dbInfo.fallbackReason ?? "unknown reason"}).
          </Text>
        ) : null}
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">User Colors</Heading>
        <Text size="2" color="gray">
          Set calendar block colors per assignee.
        </Text>
        {users.length === 0 ? (
          <Text size="1" color="gray">
            No users found yet.
          </Text>
        ) : (
          users.map((user) => {
            const color = userColors[user.user_id] ?? resolveUserColor(user.user_id, userColors);
            return (
              <div key={user.user_id} className="settings-user-color-row">
                <Text size="2">{user.display_name}</Text>
                <input
                  className="settings-color-input"
                  type="color"
                  value={color}
                  onChange={(event) =>
                    handleUserColorChange(user.user_id, event.target.value)
                  }
                />
              </div>
            );
          })
        )}
        <Flex>
          <AppButton
            type="button"
            variant="surface"
            onClick={() => void handleSaveUserColors()}
            disabled={savingUserColors}
          >
            {savingUserColors ? "Saving..." : "Save user colors"}
          </AppButton>
        </Flex>
        {userColorsError ? (
          <Text size="1" color="red">
            {userColorsError}
          </Text>
        ) : null}
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">Sync</Heading>
        <Text size="2" color="gray">
          Foundation settings for server replica sync. Local app behavior stays
          fully offline-first.
        </Text>
        <Flex align="center" justify="between" gap="3">
          <div>
            <Text size="2" weight="bold">
              Enable sync
            </Text>
            <Text size="1" color="gray">
              Stores sync preference in local settings.
            </Text>
          </div>
          <Switch
            checked={syncEnabled}
            onCheckedChange={(checked) => setSyncEnabled(Boolean(checked))}
          />
        </Flex>
        <label style={{ display: "grid", gap: 6 }}>
          <Text size="1" color="gray">
            Server URL
          </Text>
          <AppInput
            value={syncServerUrl}
            onChange={(event) => setSyncServerUrl(event.target.value)}
            placeholder="https://sync.makewhen.app"
          />
        </label>
        <Flex>
          <AppButton
            type="button"
            variant="surface"
            onClick={() => void handleSaveSyncSettings()}
            disabled={savingSync}
          >
            {savingSync ? "Saving..." : "Save sync settings"}
          </AppButton>
        </Flex>
        {syncError ? (
          <Text size="1" color="red">
            {syncError}
          </Text>
        ) : null}
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
