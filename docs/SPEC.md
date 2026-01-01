# UI Style Settings Spec (v1)

Goal: provide a Minimal Theme Settings-style customization layer without rewriting UI. Settings are stored in `settings` under the worker-owned key `ui.settings` as JSON and applied at runtime by resolving CSS variables + body classes + optional CSS snippets.

## Settings JSON (UiSettingsV1)

```
{
  "version": 1,
  "presetBundleId": "minimal" | "traditional" | "code",
  "colorThemeId": "radix_slate" | "radix_amber" | "radix_crimson",
  "colorMode": "light" | "dark" | "system",
  "lightSchemeId": "slate" | "amber" | "crimson",
  "darkSchemeId": "slate" | "amber" | "crimson",
  "backgroundContrast": "low" | "default" | "high" | "true_black",
  "accent": { "hue": string, "saturation": number },
  "fontPackId": "traditional" | "minimal" | "code",
  "fontSizeScale": 1.0 | 1.05 | 1.1,
  "weightProfileId": "slim" | "medium" | "bold",
  "shapeProfileId": "slim" | "medium" | "bold",
  "overrides": {
    "radiusPx"?: number,
    "borderWidthPx"?: number,
    "density"?: "compact" | "comfortable"
  },
  "snippets": {
    "enabledIds": string[],
    "order": string[]
  }
}
```

Default value lives in worker (`DEFAULT_UI_SETTINGS`) and is inserted into `settings` if missing.

## Token list (CSS variables)

These are the semantic tokens the UI should read. Values are resolved from Radix color scales + presets + overrides:

- Color surface/text:
  - `--color-bg`
  - `--color-panel`
  - `--color-panel-2`
  - `--color-text`
  - `--color-muted-text`
  - `--color-border`
  - `--color-border-hover`
  - `--color-accent`
  - `--color-accent-text`
  - `--color-accent-border`
  - `--color-danger`
  - `--color-warning`
  - `--color-success`
  - `--shadow-color`

- Typography:
  - `--font-sans`
  - `--font-mono`
  - `--font-size-base`
  - `--line-height`

- Shape/spacing:
  - `--radius`
  - `--border-width`
  - `--density`

These map onto existing semantic tokens in `src/ui/theme/semantic-tokens.css`.

## Body classes (profiles)

Body classes provide coarse-grained style switches. The resolver returns a list of classes to apply.

- Bundle preset:
  - `ui-bundle-minimal`
  - `ui-bundle-traditional`
  - `ui-bundle-code`
- Weight profile:
  - `ui-weight-slim`
  - `ui-weight-medium`
  - `ui-weight-bold`
- Shape profile:
  - `ui-shape-slim`
  - `ui-shape-medium`
  - `ui-shape-bold`
- Density:
  - `ui-density-compact`
  - `ui-density-comfortable`
- Contrast:
  - `ui-contrast-low`
  - `ui-contrast-default`
  - `ui-contrast-high`
  - `ui-contrast-true-black`
- Color mode:
  - `ui-mode-light`
  - `ui-mode-dark`
  - `ui-mode-system`

## Preset + override resolution

Resolution order is deterministic and additive:

1) Base tokens (default theme)
2) Bundle preset (`presetBundleId`)
3) Independent selectors (color mode/scheme, font pack, weight, shape)
4) Overrides (`radiusPx`, `borderWidthPx`, `density`)
5) Snippets (in `snippets.order`)

Independent selectors override bundle-provided values when both are present.

## Snippet behavior

Snippets are additive overrides applied after token resolution:

- Snippets are stored in the `ui_snippets` table (id, name, css, is_enabled, sort_order).
- Enabled snippets apply in sort_order; disabled snippets are ignored.
- `snippets.enabledIds` / `snippets.order` remain in settings for future compatibility, but `ui_snippets` is the current source of truth.

## Worker settings key

- Key: `ui.settings`
- Stored in `settings.value_json` as UiSettingsV1
- Default is inserted during worker init if missing

## Runtime resolver signature (worker scaffold)

```
resolveUiThemeRuntime(uiSettings) => {
  cssVars: { [name: string]: string },
  bodyClasses: string[],
  fontLinks: string[],
  snippetCss: string[]
}
```

This will be used by the UI layer to apply variables, classes, and optional font/snippet assets.
