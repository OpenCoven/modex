import { createContext, useContext, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";

type MenuRole = "menu" | "listbox";
export type MenuCloseReason = "escape" | "outside" | "tab";

interface MenuProps {
  open: boolean;
  onClose: (reason: MenuCloseReason) => void;
  /** The trigger. Clicks on it don't count as "outside", and Escape returns focus to it. */
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  /** `listbox` for single-choice pickers (model), `menu` for command lists. */
  role?: MenuRole;
  placement?: "top-start" | "bottom-start" | "top-end" | "bottom-end";
  className?: string;
  testId?: string;
  children: ReactNode;
}

const ITEM = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const MenuContext = createContext<MenuRole>("menu");

/**
 * Popover list anchored to a trigger. Owns the behaviour every popover in the app shares:
 * - focus moves to the first item on open (in a listbox picker: the selected one);
 * - ArrowUp/ArrowDown move between items (wrapping), Home/End jump to the ends;
 * - Escape closes and returns focus to the trigger; Tab closes and lets focus move on;
 * - a pointer press outside the menu and trigger closes it.
 * Position it by placing it inside a `position: relative` wrapper next to the trigger.
 */
export function Menu({ open, onClose, anchorRef, label, role = "menu", placement = "top-start", className, testId, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? []).filter((el) => !el.hasAttribute("disabled"));
    const initial = (role === "listbox" ? items().find((el) => el.getAttribute("aria-selected") === "true") : undefined) ?? items()[0];
    initial?.focus({ preventScroll: false });

    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close.current("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current("escape");
        anchorRef.current?.focus();
        return;
      }
      if (!ref.current?.contains(document.activeElement)) return;
      if (e.key === "Tab") {
        close.current("tab");
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown" ? list[(at + 1) % list.length]
        : e.key === "ArrowUp" ? list[(at - 1 + list.length) % list.length]
        : e.key === "Home" ? list[0]
        : e.key === "End" ? list[list.length - 1]
        : undefined;
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchorRef, role]);

  if (!open) return null;
  return (
    <MenuContext.Provider value={role}>
      <div ref={ref} role={role} aria-label={label} data-testid={testId} className={`menu ${placement}${className ? ` ${className}` : ""}`}>
        {children}
      </div>
    </MenuContext.Provider>
  );
}

interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> {
  /** Marks the current choice: aria-selected in a listbox, aria-checked in a menu. */
  selected?: boolean;
  /** Reserve a leading check column: a single choice among siblings (radio). */
  checkable?: boolean;
  /** An on/off setting (menuitemcheckbox); `selected` is its state. */
  toggle?: boolean;
  children: ReactNode;
}

/** One row of a Menu. Its ARIA role follows the parent (option in a listbox, menuitem/menuitemradio in a menu). */
export function MenuItem({ selected, checkable, toggle, className, children, type = "button", ...rest }: MenuItemProps) {
  const parent = useContext(MenuContext);
  const aria =
    parent === "listbox" ? { role: "option", "aria-selected": Boolean(selected) }
    : toggle ? { role: "menuitemcheckbox", "aria-checked": Boolean(selected) }
    : checkable ? { role: "menuitemradio", "aria-checked": Boolean(selected) }
    : { role: "menuitem" };
  return (
    <button type={type} tabIndex={-1} className={`menu-item${selected ? " selected" : ""}${className ? ` ${className}` : ""}`} {...aria} {...rest}>
      {(checkable || toggle) && <span className="menu-check">{selected ? <Icon name="check" size={14} /> : null}</span>}
      {children}
    </button>
  );
}

/** A non-interactive heading over a group of items. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label" role="presentation">{children}</div>;
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}
