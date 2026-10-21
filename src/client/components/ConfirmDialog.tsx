import { useEffect, useRef } from "preact/hooks";

type Props = {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
};

// A native modal <dialog>: the browser traps focus, closes it on Esc and returns
// focus to the button that opened it. Unlike confirm(), it doesn't freeze timers.
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", danger, onConfirm, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => opener?.focus();
  }, []);

  return (
    <dialog
      ref={dialog}
      class="confirm"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      {body && <p>{body}</p>}
      <div class="confirm-actions">
        <button ref={cancel} type="button" class="secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" class={danger ? "danger" : undefined} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
