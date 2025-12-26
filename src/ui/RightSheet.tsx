import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type RightSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
};

const TRANSITION_MS = 220;

const RightSheet: FC<RightSheetProps> = ({ open, onOpenChange, title, children }) => {
  const [isActive, setIsActive] = useState(open);
  const [isVisible, setIsVisible] = useState(open);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setIsActive(true);
      const raf = requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (isActive) {
      setIsVisible(false);
      const timer = window.setTimeout(() => setIsActive(false), TRANSITION_MS);
      return () => window.clearTimeout(timer);
    }
    return;
  }, [open, isActive]);

  useEffect(() => {
    if (!open) {
      return;
    }
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusable = getFocusableElements(contentRef.current);
    const first = focusable[0] ?? contentRef.current;
    first?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const nodes = getFocusableElements(contentRef.current);
      if (nodes.length === 0) {
        event.preventDefault();
        contentRef.current?.focus();
        return;
      }
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === firstNode) {
        event.preventDefault();
        lastNode.focus();
        return;
      }
      if (!event.shiftKey && active === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      lastFocusedRef.current?.focus();
    };
  }, [open, onOpenChange]);

  const portalRoot = useMemo(() => document.body, []);

  if (!isActive) {
    return null;
  }

  return createPortal(
    <div className="sheet-root" aria-hidden={!open}>
      <div
        className={`sheet-overlay${isVisible ? " is-open" : ""}`}
        onClick={() => onOpenChange(false)}
      />
      <div
        className={`sheet-content${isVisible ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={contentRef}
        tabIndex={-1}
      >
        <div className="sheet-header">
          <h2 className="sheet-title">{title}</h2>
          <button
            type="button"
            className="button button-ghost"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    portalRoot
  );
};

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const getFocusableElements = (root: HTMLElement | null) => {
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => !node.hasAttribute("disabled") && node.tabIndex !== -1
  );
};

export default RightSheet;
