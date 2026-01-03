import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
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
      setOpen(false);
      onClose?.();
    };
    window.addEventListener("mousedown", handlePointer);
    return () => window.removeEventListener("mousedown", handlePointer);
  }, [onClose, open]);

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
      {open ? (
        <div className="user-select-popover">
          <AppInput
            rootClassName="user-select-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={placeholder}
            autoFocus
          />
          {error ? <div className="user-select-error">{error}</div> : null}
          <div className="user-select-list">
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
                  setOpen(false);
                  onClose?.();
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
                    setOpen(false);
                    onClose?.();
                  }}
                >
                  {user.display_name}
                </AppButton>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default UserSelect;
