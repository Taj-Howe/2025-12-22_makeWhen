import type { FC, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

type RightSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
};

const RightSheet: FC<RightSheetProps> = ({ open, onOpenChange, title, children }) => {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content">
          <div className="sheet-header">
            <Dialog.Title className="sheet-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="button button-ghost" aria-label="Close">
                ✕
              </button>
            </Dialog.Close>
          </div>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default RightSheet;
