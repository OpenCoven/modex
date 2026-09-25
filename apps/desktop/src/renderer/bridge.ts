import type { ModexBridge, ThreadEvent } from "../shared/types";

declare global {
  interface Window {
    modex?: ModexBridge;
  }
}

/** In the browser (vite dev without Electron) fall back to an inert bridge so the layout can be worked on. */
const inert: ModexBridge = {
  platform: "web",
  async invoke(channel) {
    if (channel === "state:get") return { version: 1, projects: [], threads: [], settings: { provider: "openai", base_url: "", api_key_env: "OPENAI_API_KEY", default_model: "gpt-5-codex", default_mode: "agent" } } as never;
    throw new Error("Modex bridge unavailable: open this UI inside the Electron app.");
  },
  onEvent(_cb: (e: ThreadEvent) => void) {
    return () => {};
  },
};

export const bridge: ModexBridge = window.modex ?? inert;
