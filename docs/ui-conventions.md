## UI Conventions (Radix Themes First)

- Use `@radix-ui/themes` components for interactive controls (Button, Select, TextField, Switch, Dialog, Tabs).
- Keep layout primitives as plain HTML + existing CSS classes (Flex/Grid from Radix is OK when it simplifies).
- Styling should come from semantic tokens; avoid one-off control styles in app CSS.
- ThemeRoot remains the single place where Radix Theme props are set.
