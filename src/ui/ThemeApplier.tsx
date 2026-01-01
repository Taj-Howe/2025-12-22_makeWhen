import { useEffect, useMemo, useRef, useState } from "react";
import { query } from "../rpc/clientSingleton";

type UiThemeRuntime = {
  cssVars: Record<string, string>;
  bodyClasses: string[];
  fontLinks: Array<{ id: string; href: string }>;
  snippetCss: Array<{ id: string; css: string }>;
};

type ThemeApplierProps = {
  onModeChange?: (mode: "light" | "dark") => void;
};

const applyCssVars = (
  target: HTMLElement,
  nextVars: Record<string, string>,
  previousKeys: Set<string>
) => {
  const nextKeys = new Set(Object.keys(nextVars));
  for (const key of previousKeys) {
    if (!nextKeys.has(key)) {
      target.style.removeProperty(key);
    }
  }
  for (const [key, value] of Object.entries(nextVars)) {
    target.style.setProperty(key, value);
  }
  return nextKeys;
};

const applyBodyClasses = (
  target: HTMLElement,
  nextClasses: string[],
  previousClasses: Set<string>
) => {
  for (const cls of previousClasses) {
    target.classList.remove(cls);
  }
  for (const cls of nextClasses) {
    target.classList.add(cls);
  }
  return new Set(nextClasses);
};

const applyFontLinks = (
  target: HTMLElement,
  nextLinks: Array<{ id: string; href: string }>
) => {
  const existing = new Map<string, HTMLLinkElement>();
  target
    .querySelectorAll<HTMLLinkElement>('link[data-ui-font="true"]')
    .forEach((node) => {
      const id = node.dataset.fontId;
      if (id) {
        existing.set(id, node);
      }
    });

  const nextIds = new Set(nextLinks.map((link) => link.id));
  for (const [id, node] of existing.entries()) {
    if (!nextIds.has(id)) {
      node.remove();
    }
  }

  for (const link of nextLinks) {
    const current = existing.get(link.id);
    if (current) {
      if (current.href !== link.href) {
        current.href = link.href;
      }
      continue;
    }
    const node = document.createElement("link");
    node.rel = "stylesheet";
    node.href = link.href;
    node.dataset.uiFont = "true";
    node.dataset.fontId = link.id;
    target.appendChild(node);
  }
};

const applySnippets = (
  target: HTMLElement,
  snippets: Array<{ id: string; css: string }>
) => {
  const existing = new Map<string, HTMLStyleElement>();
  target
    .querySelectorAll<HTMLStyleElement>('style[data-ui-snippet="true"]')
    .forEach((node) => {
      const id = node.dataset.snippetId;
      if (id) {
        existing.set(id, node);
      }
    });

  const nextIds = new Set(snippets.map((snippet) => snippet.id));
  for (const [id, node] of existing.entries()) {
    if (!nextIds.has(id)) {
      node.remove();
    }
  }

  snippets.forEach((snippet) => {
    const current = existing.get(snippet.id);
    if (current) {
      if (current.textContent !== snippet.css) {
        current.textContent = snippet.css;
      }
      current.remove();
      target.appendChild(current);
      return;
    }
    const node = document.createElement("style");
    node.dataset.uiSnippet = "true";
    node.dataset.snippetId = snippet.id;
    node.textContent = snippet.css;
    target.appendChild(node);
  });
};

const ThemeApplier = ({ onModeChange }: ThemeApplierProps) => {
  const [runtime, setRuntime] = useState<UiThemeRuntime | null>(null);
  const appliedVars = useRef<Set<string>>(new Set());
  const appliedClasses = useRef<Set<string>>(new Set());

  const safeTheme = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("safeTheme") === "1";
  }, []);

  const systemMode = useMemo(() => {
    if (typeof window === "undefined") {
      return "dark";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchRuntime = async (modeOverride?: "light" | "dark") => {
      const args = modeOverride ? { mode: modeOverride } : {};
      try {
        const result = await query<UiThemeRuntime>("ui_theme_runtime", {
          ...args,
          safe: safeTheme,
        });
        if (!isMounted) {
          return;
        }
        setRuntime(result);
      } catch {
        if (isMounted) {
          setRuntime(null);
        }
      }
    };
    void fetchRuntime(systemMode);

    return () => {
      isMounted = false;
    };
  }, [safeTheme, systemMode]);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    const root = document.documentElement;
    const body = document.body;
    appliedVars.current = applyCssVars(root, runtime.cssVars, appliedVars.current);
    appliedClasses.current = applyBodyClasses(
      body,
      runtime.bodyClasses,
      appliedClasses.current
    );
    applyFontLinks(document.head, runtime.fontLinks);
    applySnippets(document.head, runtime.snippetCss);

    const resolvedMode = runtime.bodyClasses.includes("ui-mode-dark")
      ? "dark"
      : "light";
    root.dataset.theme = resolvedMode;
    onModeChange?.(resolvedMode);
  }, [runtime, onModeChange]);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    if (!runtime.bodyClasses.includes("ui-mode-system")) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const nextMode = media.matches ? "dark" : "light";
      void query<UiThemeRuntime>("ui_theme_runtime", {
        mode: nextMode,
        safe: safeTheme,
      })
        .then((result) => setRuntime(result))
        .catch(() => {});
    };
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, [runtime, safeTheme]);

  useEffect(() => {
    const handleThemeChange = () => {
      const currentMode = runtime?.bodyClasses.includes("ui-mode-dark")
        ? "dark"
        : runtime?.bodyClasses.includes("ui-mode-light")
        ? "light"
        : systemMode;
      void query<UiThemeRuntime>("ui_theme_runtime", {
        mode: currentMode,
        safe: safeTheme,
      })
        .then((result) => setRuntime(result))
        .catch(() => {});
    };
    window.addEventListener("ui-theme-changed", handleThemeChange);
    return () => {
      window.removeEventListener("ui-theme-changed", handleThemeChange);
    };
  }, [runtime, safeTheme, systemMode]);

  return null;
};

export default ThemeApplier;
