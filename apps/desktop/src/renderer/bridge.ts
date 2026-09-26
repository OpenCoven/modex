import type { ModexBridge, ThreadEvent } from "../shared/types";
import { DEFAULT_ROUTING } from "../shared/types";

declare global {
  interface Window {
    modex?: ModexBridge;
  }
}

/** In the browser (vite dev without Electron) fall back to an inert bridge so the layout can be worked on. */
const inert: ModexBridge = {
  platform: "web",
  async invoke(channel) {
    if (channel === "state:get") return { version: 1, projects: [], threads: [], settings: { default_backend: "codex", default_mode: "agent", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", routing: DEFAULT_ROUTING } } as never;
    throw new Error("Modex bridge unavailable: open this UI inside the Electron app.");
  },
  onEvent(_cb: (e: ThreadEvent) => void) {
    return () => {};
  },
};

export const bridge: ModexBridge = window.modex ?? inert;
