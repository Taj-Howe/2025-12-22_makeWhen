import {
  createContext,
  useContext,
  type FC,
  type ReactNode,
} from "react";
import type { Scope } from "../domain/scope";

type ScopeContextValue = {
  scope: Scope;
  setScope: (scope: Scope) => void;
};

const ScopeContext = createContext<ScopeContextValue | null>(null);

export const ScopeProvider: FC<{
  scope: Scope;
  setScope: (scope: Scope) => void;
  children: ReactNode;
}> = ({ scope, setScope, children }) => (
  <ScopeContext.Provider value={{ scope, setScope }}>
    {children}
  </ScopeContext.Provider>
);

export const useScope = () => {
  const ctx = useContext(ScopeContext);
  if (!ctx) {
    throw new Error("useScope must be used within a ScopeProvider");
  }
  return ctx;
};
