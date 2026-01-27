import {
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
} from "react";
import { query } from "../data/api";
import { AppButton, AppInput } from "./controls";

export type ItemLite = {
  id: string;
  title: string;
  item_type: string;
  parent_id: string | null;
  due_at: number | null;
  completed_at: number | null;
};

type ItemAutocompleteProps = {
  scopeId?: string | null;
  excludeIds?: string[];
  onSelect: (item: ItemLite) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
};

const MIN_QUERY_LENGTH = 1;
const DEBOUNCE_MS = 180;

export const ItemAutocomplete: FC<ItemAutocompleteProps> = ({
  scopeId,
  excludeIds,
  onSelect,
  placeholder,
  autoFocus,
  className,
}) => {
  const [value, setValue] = useState("");
  const [items, setItems] = useState<ItemLite[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const timeoutId = useRef<number | null>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, []);

  useEffect(() => {
    const queryText = value.trim();
    if (queryText.length < MIN_QUERY_LENGTH) {
      setItems([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    setOpen(true);
    if (timeoutId.current) {
      window.clearTimeout(timeoutId.current);
    }
    const currentRequest = ++requestId.current;
    timeoutId.current = window.setTimeout(() => {
      query<{ items: ItemLite[] }>("searchItems", {
        q: queryText,
        limit: 12,
        scopeId,
      })
        .then((data) => {
          if (currentRequest !== requestId.current) {
            return;
          }
          const exclude = new Set(excludeIds ?? []);
          const filtered = (data.items ?? []).filter(
            (item) => !exclude.has(item.id)
          );
          setItems(filtered);
          setActiveIndex(filtered.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (currentRequest !== requestId.current) {
            return;
          }
          setItems([]);
          setActiveIndex(-1);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timeoutId.current) {
        window.clearTimeout(timeoutId.current);
      }
    };
  }, [excludeIds, scopeId, value]);

  const handleSelect = (item: ItemLite) => {
    onSelect(item);
    setValue("");
    setItems([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || items.length === 0) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % items.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = items[activeIndex] ?? items[0];
      if (target) {
        handleSelect(target);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className={`autocomplete ${className ?? ""}`.trim()} ref={containerRef}>
      <AppInput
        rootClassName="autocomplete-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {open && items.length > 0 ? (
        <div className="autocomplete-list" role="listbox">
          {items.map((item, index) => {
            const isActive = index === activeIndex;
            return (
              <AppButton
                key={item.id}
                type="button"
                variant="ghost"
                className={`autocomplete-option ${isActive ? "is-active" : ""}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleSelect(item);
                }}
              >
                <span className="autocomplete-title">{item.title}</span>
                <span className="autocomplete-meta">{item.item_type}</span>
              </AppButton>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
