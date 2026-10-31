import { AlertIcon, CheckIcon, CloseIcon } from "./Icons.js";

export interface Toast {
  id: number;
  tone: "error" | "success";
  text: string;
}

/** Errors stay until dismissed and are announced as alerts; confirmations fade out on their own. */
export function Toasts({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error" ? <AlertIcon /> : <CheckIcon />}
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
