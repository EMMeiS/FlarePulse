import { useEffect, useRef, useState } from "react";
import More from "reicon-react/icons/More";

/**
 * Row actions behind one `⋯` trigger (transitions.dev 05). Three lists were
 * carrying two or three buttons per row; the buttons are the same buttons, moved
 * into a panel that scales and fades out of the corner it is anchored to.
 *
 * `aria-haspopup` plus `aria-expanded` on a real button over real buttons — and
 * deliberately not `role="menu"`/`menuitem`, for the reason DECISIONS #6 gives
 * for the switchers: menu roles promise arrow-key navigation, and a screen
 * reader that switches into menu mode would stop Tab from working. Tab is what
 * this panel actually supports, so it claims nothing else.
 *
 * The catalogue's own common-mistakes list names the bug this component exists
 * to avoid: the closing class has to be cleared by a timer, or the next open
 * starts from the closing scale instead of the resting one.
 *
 * The list this sits in has to carry `glass-popover`: a plain `.glass` surface
 * clips its own overflow, so the last row's panel would be cut off at the card
 * edge.
 */
const CLOSE_MS = 150; // --dropdown-close-dur

export interface RowAction {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export function RowMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);

  useEffect(() => () => globalThis.clearTimeout(timer.current), []);

  const close = (refocus = false) => {
    setOpen(false);
    setClosing(true);
    globalThis.clearTimeout(timer.current);
    timer.current = globalThis.setTimeout(() => setClosing(false), CLOSE_MS);
    if (refocus) trigger.current?.focus();
  };

  // Pointer down rather than click, so the panel is gone before whatever was
  // clicked underneath it reacts. Escape returns focus to the trigger; a plain
  // outside click leaves focus wherever the pointer put it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={root}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground hover:bg-foreground/8 grid size-8 place-items-center rounded-full transition-colors"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <More className="size-4" aria-hidden />
      </button>

      <div
        className={`t-dropdown glass absolute top-full right-0 z-20 mt-1 grid w-44 gap-0.5 rounded-xl border p-2 ${
          open ? "is-open" : closing ? "is-closing" : ""
        }`}
        data-origin="top-right"
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={action.disabled}
            className={`hover:bg-foreground/8 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
              action.destructive === true ? "text-destructive" : ""
            }`}
            onClick={() => {
              close();
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
