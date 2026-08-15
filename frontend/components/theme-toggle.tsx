import { useEffect, useRef, useState } from "react";
import Desktop from "reicon-react/icons/Desktop";
import Moon from "reicon-react/icons/Moon";
import Sun from "reicon-react/icons/Sun";

export type Theme = "system" | "light" | "dark";

/** Shared with the inline boot script in index.html, which prevents a flash. */
export const THEME_KEY = "flarepulse-theme";

/**
 * The theme control (transitions.dev 20, plus 09 on its glyph). It used to be a
 * blind three-state cycle: one button, one icon, and the only way to learn the
 * options was to press it three times. Now the round trigger's own box grows
 * into the panel that lists System, Light and Dark — which is the case the
 * recipe names for choosing a morph over a dropdown, since the panel is the
 * trigger rather than something that appears beside it.
 *
 * `--morph-w-open`/`--morph-h-open` are hardcoded, as recipe 20 warns they must
 * be: the box animates to a size, so it cannot also be `auto`. They are set to
 * this control's own footprint — three 36px rows, two 2px gaps, 8px of padding —
 * plus the 1px border on each side, since the panel fills the padding box. The
 * padding is what keeps the hovered row's pill off the panel border, and the
 * border is what it landed on when the tokens ignored it; both belong in that
 * arithmetic.
 *
 * The glyph exchange is recipe 09 with three icons in one grid cell instead of
 * the recipe's pair; `.t-icon-swap` matches on a name, so one selector covers
 * all three. Deviation, recorded in DECISIONS #12.
 */
const THEMES: { value: Theme; label: string; slot: string; Icon: typeof Desktop }[] = [
  { value: "system", label: "System", slot: "a", Icon: Desktop },
  { value: "light", label: "Light", slot: "b", Icon: Sun },
  { value: "dark", label: "Dark", slot: "c", Icon: Moon },
];

const SLOT: Record<Theme, string> = { system: "a", light: "b", dark: "c" };
const LABEL: Record<Theme, string> = {
  system: "Theme: system",
  light: "Theme: light",
  dark: "Theme: dark",
};

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function prefersDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && matchMedia(SYSTEM_DARK).matches);
}

export function ThemeToggle() {
  // Rendered on the server in the smoke tests, where there is no localStorage.
  const [theme, setTheme] = useState<Theme>(() =>
    typeof localStorage === "undefined"
      ? "system"
      : ((localStorage.getItem(THEME_KEY) as Theme | null) ?? "system"),
  );
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", prefersDark(theme));
    localStorage.setItem(THEME_KEY, theme);

    if (theme !== "system") return;
    const query = matchMedia(SYSTEM_DARK);
    const sync = () => document.documentElement.classList.toggle("dark", query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [theme]);

  // The trigger fades out and leaves the tab order as the panel arrives, so the
  // keyboard has to be handed somewhere: the option that is already selected.
  useEffect(() => {
    if (!open) return;
    current.current?.focus();

    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="relative size-9 shrink-0" ref={root}>
      <div className="t-morph glass border" data-open={open ? "true" : "false"}>
        <button
          ref={trigger}
          type="button"
          className="t-morph-plus text-foreground"
          title={LABEL[theme]}
          aria-label={LABEL[theme]}
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="t-icon-swap" data-state={SLOT[theme]} aria-hidden>
            {THEMES.map(({ value, slot, Icon }) => (
              <Icon key={value} className="t-icon size-4" data-icon={slot} />
            ))}
          </span>
        </button>

        <div className="t-morph-menu grid gap-0.5 p-2" role="group" aria-label="Theme">
          {THEMES.map(({ value, label, Icon }) => (
            <button
              key={value}
              ref={value === theme ? current : undefined}
              type="button"
              aria-pressed={value === theme}
              className="hover:bg-foreground/8 aria-pressed:bg-foreground/10 flex h-9 items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors"
              onClick={() => {
                setTheme(value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
