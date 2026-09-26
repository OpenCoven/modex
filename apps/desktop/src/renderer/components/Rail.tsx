import { IconButton } from "./ui/IconButton";

/**
 * The 48 px icon rail. Modex has one surface (chat), so the rail holds exactly that plus Settings;
 * Codex's other rail entries have no Modex feature behind them and are deliberately absent.
 */
export function Rail({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <nav className="rail" aria-label="Surfaces" data-testid="rail">
      <IconButton icon="home" label="Chat" size="lg" className="rail-btn active" aria-current="page" data-testid="rail-chat" tooltipSide="bottom" />
      <span className="spacer" />
      <IconButton icon="gear" label="Settings" size="lg" className="rail-btn" data-testid="open-settings" tooltipSide="top" onClick={onOpenSettings} />
    </nav>
  );
}
