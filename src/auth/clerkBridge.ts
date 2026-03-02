import { useAuth, useClerk } from "@clerk/clerk-react";
import { useEffect } from "react";

type ClerkBridgeState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  openSignIn: () => void;
};

let bridgeState: ClerkBridgeState | null = null;

export const readClerkBridge = () => bridgeState;

const setBridgeState = (next: ClerkBridgeState | null) => {
  bridgeState = next;
};

export const ClerkBridgeSync = () => {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const clerk = useClerk();

  useEffect(() => {
    setBridgeState({
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      getToken: async () => {
        const token = await getToken();
        return token ?? null;
      },
      signOut: async () => {
        await signOut();
      },
      openSignIn: () => {
        clerk.openSignIn({
          redirectUrl: window.location.href,
        });
      },
    });

    return () => {
      setBridgeState(null);
    };
  }, [clerk, getToken, isLoaded, isSignedIn, signOut, userId]);

  return null;
};
