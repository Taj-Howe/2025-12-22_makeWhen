import type { FC, ReactNode } from "react";
import { Dialog } from "@radix-ui/themes";
import { AppIconButton } from "./controls";

type RightSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
};

const RightSheet: FC<RightSheetProps> = ({ open, onOpenChange, title, children }) => {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="sheet-content">
        <div className="sheet-header">
          <Dialog.Title className="sheet-title">{title}</Dialog.Title>
          <Dialog.Close asChild>
            <AppIconButton
              type="button"
              variant="ghost"
              aria-label="Close"
            >
              ✕
            </AppIconButton>
          </Dialog.Close>
        </div>
        <div className="sheet-body">{children}</div>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default RightSheet;
