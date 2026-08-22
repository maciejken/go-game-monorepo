import { createContext, useContext } from 'react';

export interface DialogContextValue {
  // Resolves true/false for Confirm/Cancel — the caller supplies the
  // confirm button's own label (e.g. "Delete") since a generic "OK" would
  // undersell a destructive action.
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  alert: (message: string) => Promise<void>;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used within a DialogProvider');
  }
  return ctx;
}
