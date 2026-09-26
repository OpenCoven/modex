import { useEffect, useRef, useState } from "react";

/**
 * Back/forward over thread selections, like a browser: selecting a thread pushes it (dropping any
 * forward entries), and back/forward move through the stack without pushing. Entries for threads that
 * no longer exist are skipped, so deleting a thread never strands the buttons on a dead entry.
 */
export function useSelectionHistory(selected: string | null, select: (id: string) => void, alive: (id: string) => boolean) {
  const hist = useRef<{ stack: string[]; i: number }>({ stack: [], i: -1 });
  const travelling = useRef(false);
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!selected) return;
    const h = hist.current;
    if (travelling.current) travelling.current = false;
    else if (h.stack[h.i] !== selected) {
      h.stack = [...h.stack.slice(0, h.i + 1), selected];
      h.i = h.stack.length - 1;
    }
    rerender((n) => n + 1);
  }, [selected]);

  const target = (dir: -1 | 1): number => {
    const h = hist.current;
    for (let j = h.i + dir; j >= 0 && j < h.stack.length; j += dir) {
      if (h.stack[j] !== selected && alive(h.stack[j]!)) return j;
    }
    return -1;
  };
  const go = (dir: -1 | 1) => {
    const j = target(dir);
    if (j < 0) return;
    hist.current.i = j;
    travelling.current = true;
    select(hist.current.stack[j]!);
  };

  return { canBack: target(-1) >= 0, canForward: target(1) >= 0, back: () => go(-1), forward: () => go(1) };
}
