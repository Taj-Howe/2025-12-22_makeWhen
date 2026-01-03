import { Card, Flex, Heading, SegmentedControl, Switch, Text } from "@radix-ui/themes";
import { useEffect, useState, type FC } from "react";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";
import { mutate, query } from "../rpc/clientSingleton";

const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "amber", label: "Amber" },
];

const ThemeSettings: FC = () => {
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [autoArchive, setAutoArchive] = useState(false);

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
      })
      .catch(() => {
        if (mounted) {
          setAutoArchive(false);
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
    setAutoArchive(checked);
    mutate("set_setting", {
      key: "ui.auto_archive_on_complete",
      value: checked,
    }).catch(() => {
      setAutoArchive(checked);
    });
  };

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
    </Card>
  );
};

export default ThemeSettings;
