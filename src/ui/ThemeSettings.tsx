import { Card, Flex, Heading, SegmentedControl, Text } from "@radix-ui/themes";
import { useEffect, useState, type FC } from "react";
import { loadTheme, setTheme, type ThemeName } from "../theme/themeStore";

const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "amber", label: "Amber" },
];

const ThemeSettings: FC = () => {
  const [theme, setThemeState] = useState<ThemeName>("light");
  useEffect(() => {
    setThemeState(loadTheme());
  }, []);

  const handleChange = (value: string) => {
    const next = THEME_OPTIONS.find((option) => option.value === value);
    if (!next) {
      return;
    }
    setThemeState(next.value);
    setTheme(next.value);
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
    </Card>
  );
};

export default ThemeSettings;
