import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";

interface Props {
  label: string;
  /** Keyboard shortcut shown after the label, e.g. "⌘N". */
  shortcut?: string;
  /** Preferred side; flips when there is no room. */
  side?: "top" | "bottom";
  /** A single element that accepts `aria-describedby`. */
  children: ReactElement<{ "aria-describedby"?: string }>;
}

const GAP = 6;

/**
 * Hover/focus tooltip. Rendered in a portal with fixed positioning so scroll containers (the project list,
 * the transcript) never clip it. Opens after --tooltip-delay on hover, immediately on keyboard focus,
 * and closes on leave, blur, or Escape. The child is described by the tooltip for screen readers.
 */
export function Tooltip({ label, shortcut, side = "bottom", children }: Props) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);

  const show = (delayed: boolean) => {
    window.clearTimeout(timer.current);
    const open = () => {
      const el = anchor.current?.firstElementChild ?? anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const roomBelow = window.innerHeight - r.bottom > 40;
      const s = side === "bottom" && !roomBelow ? "top" : side === "top" && r.top < 40 ? "bottom" : side;
      setPos({ x: r.left + r.width / 2, y: s === "bottom" ? r.bottom + GAP : r.top - GAP, side: s });
    };
    if (delayed) {
      const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tooltip-delay")) || 400;
      timer.current = window.setTimeout(open, ms);
    } else open();
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pos]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      ref={anchor}
      className="tooltip-anchor"
      onPointerEnter={() => show(true)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => (e.target as HTMLElement).matches(":focus-visible") && show(false)}
      onBlur={hide}
    >
      {cloneElement(children, { "aria-describedby": id })}
      {pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className={`tooltip ${pos.side}`}
            data-testid="tooltip"
            style={{ left: pos.x, top: pos.y }}
          >
            {label}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
