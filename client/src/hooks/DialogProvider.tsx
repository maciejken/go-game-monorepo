import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DialogContext } from './useDialog';

interface DialogState {
  message: string;
  variant: 'confirm' | 'alert';
  confirmLabel: string;
  resolve: (value: boolean) => void;
}

// A single dialog mounted once at the app root, replacing window.confirm /
// window.alert with something styled consistently with the rest of the UI
// — every caller gets it via useDialog() instead of managing its own modal.
export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const confirm = useCallback((message: string, confirmLabel: string) => {
    return new Promise<boolean>((resolve) => {
      setDialog({ message, variant: 'confirm', confirmLabel, resolve });
    });
  }, []);

  const alert = useCallback((message: string) => {
    return new Promise<void>((resolve) => {
      setDialog({ message, variant: 'alert', confirmLabel: 'OK', resolve: () => resolve() });
    });
  }, []);

  const close = useCallback(
    (value: boolean) => {
      dialog?.resolve(value);
      setDialog(null);
    },
    [dialog],
  );

  // Escape cancels a confirm (same as clicking outside) or dismisses an alert.
  useEffect(() => {
    if (!dialog) {
      return;
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [dialog, close]);

  return (
    <DialogContext.Provider value={{ confirm, alert }}>
      {children}
      {dialog && (
        <div className="modal-overlay" onClick={() => close(false)}>
          <div className="modal dialog-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-message">
              <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                <path
                  fill="#d1242f"
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                />
              </svg>
              <p>{dialog.message}</p>
            </div>
            <div className="modal-actions">
              {dialog.variant === 'confirm' && (
                <button type="button" className="modal-action" onClick={() => close(false)}>
                  Cancel
                </button>
              )}
              <button type="button" className="modal-action" autoFocus onClick={() => close(true)}>
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
