import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import { query } from "../rpc/clientSingleton";
import { AppButton, AppInput } from "./controls";

type UserOption = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
};

type UserSelectProps = {
  value: string | null;
  onChange: (value: string | null) => void;
  onClose?: () => void;
  placeholder?: string;
  allowClear?: boolean;
  refreshToken?: number;
};

const VIEWPORT_GAP = 8;
const POPOVER_GAP = 6;
const MIN_LIST_HEIGHT = 96;
const MAX_LIST_HEIGHT = 280;
const POPOVER_CHROME_HEIGHT = 56;

type PopoverLayout = {
  placement: "up" | "down";
  listMaxHeight: number;
  style: CSSProperties;
};

const UserSelect: FC<UserSelectProps> = ({
  value,
  onChange,
  onClose,
  placeholder = "Select assignee",
  allowClear = true,
  refreshToken = 0,
}) => {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverLayout, setPopoverLayout] = useState<PopoverLayout | null>(null);

  const closePopover = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

  const updatePopoverLayout = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const trigger = containerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableBelow = Math.max(
      0,
      viewportHeight - rect.bottom - VIEWPORT_GAP - POPOVER_GAP
    );
    const availableAbove = Math.max(
      0,
      rect.top - VIEWPORT_GAP - POPOVER_GAP
    );
    const placement: "up" | "down" =
      availableBelow < MIN_LIST_HEIGHT && availableAbove > availableBelow
        ? "up"
        : "down";
    const availablePrimary =
      placement === "down" ? availableBelow : availableAbove;
    const listMaxHeight = Math.max(
      MIN_LIST_HEIGHT,
      Math.min(MAX_LIST_HEIGHT, availablePrimary - POPOVER_CHROME_HEIGHT)
    );
    const width = Math.min(rect.width, viewportWidth - VIEWPORT_GAP * 2);
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_GAP),
      viewportWidth - width - VIEWPORT_GAP
    );
    const style: CSSProperties =
      placement === "up"
        ? {
            left: `${left}px`,
            width: `${width}px`,
            bottom: `${Math.max(
              VIEWPORT_GAP,
              viewportHeight - rect.top + POPOVER_GAP
            )}px`,
          }
        : {
            left: `${left}px`,
            width: `${width}px`,
            top: `${Math.max(VIEWPORT_GAP, rect.bottom + POPOVER_GAP)}px`,
          };
    setPopoverLayout({ placement, listMaxHeight, style });
  }, []);

  useEffect(() => {
    let isMounted = true;
    setError(null);
    query<{ users: UserOption[] }>("users_list", {})
      .then((data) => {
        if (isMounted) {
          setUsers(data.users ?? []);
        }
      })
      .catch((err) => {
        if (isMounted) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
          setUsers([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

  useEffect(() => {
    if (!open) {
      setFilter("");
      setPopoverLayout(null);
      return;
    }
    updatePopoverLayout();
    const handleReposition = () => updatePopoverLayout();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, updatePopoverLayout]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (containerRef.current?.contains(target)) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      closePopover();
    };
    window.addEventListener("mousedown", handlePointer);
    return () => window.removeEventListener("mousedown", handlePointer);
  }, [closePopover, open]);

  const selected = useMemo(
    () => users.find((user) => user.user_id === value) ?? null,
    [users, value]
  );

  const filtered = useMemo(() => {
    const queryText = filter.trim().toLowerCase();
    if (!queryText) {
      return users;
    }
    return users.filter((user) =>
      user.display_name.toLowerCase().includes(queryText)
    );
  }, [filter, users]);

  return (
    <div className="user-select" ref={containerRef}>
      <AppButton
        type="button"
        variant="ghost"
        className="user-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected?.display_name ?? "Unassigned"}
      </AppButton>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              className={`user-select-popover ${
                popoverLayout?.placement === "up"
                  ? "user-select-popover--up"
                  : "user-select-popover--down"
              }`}
              style={popoverLayout?.style ?? { visibility: "hidden" }}
            >
              <AppInput
                rootClassName="user-select-input"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={placeholder}
                autoFocus
              />
              {error ? <div className="user-select-error">{error}</div> : null}
              <div
                className="user-select-list"
                style={{
                  maxHeight: `${popoverLayout?.listMaxHeight ?? MAX_LIST_HEIGHT}px`,
                }}
              >
                {allowClear ? (
                  <AppButton
                    type="button"
                    size="1"
                    variant="ghost"
                    className={
                      value === null
                        ? "user-select-option is-active"
                        : "user-select-option"
                    }
                    onClick={() => {
                      onChange(null);
                      closePopover();
                    }}
                  >
                    Unassigned
                  </AppButton>
                ) : null}
                {filtered.length === 0 ? (
                  <div className="user-select-empty">No users found</div>
                ) : (
                  filtered.map((user) => (
                    <AppButton
                      key={user.user_id}
                      type="button"
                      size="1"
                      variant="ghost"
                      className={
                        user.user_id === value
                          ? "user-select-option is-active"
                          : "user-select-option"
                      }
                      onClick={() => {
                        onChange(user.user_id);
                        closePopover();
                      }}
                    >
                      {user.display_name}
                    </AppButton>
                  ))
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
};

export default UserSelect;
