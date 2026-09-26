import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, BackendId, ChangesSnapshot, ModelInfo, Settings, Thread, ThreadEvent, ThreadItem, ThreadPatch } from "../shared/types";
import { bridge } from "./bridge";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { ChangesPanel } from "./components/ChangesPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { EmptyState } from "./components/EmptyState";
import { DraftView, type Draft } from "./components/DraftView";
import { TitleBar } from "./components/TitleBar";
import { Rail } from "./components/Rail";
import { useSelectionHistory } from "./history";

const SIDEBAR_KEY = "modex.sidebar";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, ThreadItem[]>>({});
  const [changes, setChanges] = useState<ChangesSnapshot | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== "closed");
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Partial<Record<BackendId, { models: ModelInfo[]; error?: string }>>>({});
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // A new chat is a draft (renderer-only) until its first send creates the thread.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  // A thread just created from a draft has no history to load, and reloading it could overwrite
  // the first streamed items; the selection effect skips its one load.
  const justCreated = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await bridge.invoke("state:get", undefined);
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh().then((s) => {
      if (!selected && s.threads[0]) setSelected(s.threads[0].id);
    });
  }, [refresh]);

  // Live events from every thread; the selected thread re-renders, others just update status.
  useEffect(() => {
    return bridge.onEvent((e: ThreadEvent) => {
      if (e.type === "item") setItems((m) => ({ ...m, [e.threadId]: [...(m[e.threadId] ?? []), e.item] }));
      else if (e.type === "item_update") setItems((m) => ({ ...m, [e.threadId]: (m[e.threadId] ?? []).map((i) => (i.id === e.id ? ({ ...i, ...e.patch } as ThreadItem) : i)) }));
      else if (e.type === "status") {
        setState((s) => (s ? { ...s, threads: s.threads.map((t) => (t.id === e.threadId ? { ...t, status: e.status } : t)) } : s));
        if (e.status === "idle" || e.status === "error") void loadChanges(e.threadId);
      } else if (e.type === "thread") setState((s) => (s ? { ...s, threads: s.threads.map((t) => (t.id === e.thread.id ? { ...t, ...e.thread, status: t.status } : t)) } : s));
    });
  }, []);

  const loadChanges = useCallback(async (threadId: string) => {
    try {
      setChanges(await bridge.invoke("changes:status", { threadId }));
    } catch (err) {
      setChanges(null);
      setError((err as Error).message);
    }
  }, []);

  // Selecting a thread loads its items and its working-tree state.
  useEffect(() => {
    if (!selected) return;
    if (justCreated.current === selected) {
      justCreated.current = null;
      setItems((m) => ({ ...m, [selected]: m[selected] ?? [] }));
    } else {
      void bridge.invoke("thread:items", { threadId: selected }).then((list) => setItems((m) => ({ ...m, [selected]: list })));
    }
    void loadChanges(selected);
  }, [selected, loadChanges]);

  const thread = useMemo(() => state?.threads.find((t) => t.id === selected) ?? null, [state, selected]);
  /** Choosing a thread (sidebar, history) discards any draft: an unsent draft never becomes a thread. */
  const selectThread = useCallback((id: string) => {
    setDraft(null);
    setSelected(id);
  }, []);
  const history = useSelectionHistory(selected, selectThread, (id) => Boolean(state?.threads.some((t) => t.id === id)));
  const draftDefaults = (s: AppState): Draft["settings"] => ({
    backend: s.settings.default_backend,
    mode: s.settings.default_mode,
    plan: false,
    auto: s.settings.routing.auto_by_default,
    model: s.settings.default_model[s.settings.default_backend] ?? "",
  });
  const openDraft = (projectId: string, worktree = false) => {
    if (!state) return;
    setSelected(null);
    setDraft({ projectId, worktree, settings: draftDefaults(state) });
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  // Nothing selected and no draft, but there are projects (first launch, last thread deleted): open a draft.
  useEffect(() => {
    if (!state || selected || creating) return;
    if (draft && !state.projects.some((p) => p.id === draft.projectId)) setDraft(null);
    else if (!draft && state.projects[0]) setDraft({ projectId: state.projects[0].id, worktree: false, settings: draftDefaults(state) });
  }, [state, selected, draft, creating]);
  useEffect(() => localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "closed"), [sidebarOpen]);

  // Model catalogue per backend, fetched lazily from the CLIs (Codex: live `model/list`).
  useEffect(() => {
    const b = thread?.backend ?? draft?.settings.backend;
    if (!b || models[b]) return;
    void bridge.invoke("models:list", { backend: b }).then((r) => setModels((m) => ({ ...m, [b]: r }))).catch((err) => setModels((m) => ({ ...m, [b]: { models: [], error: (err as Error).message } })));
  }, [thread?.backend, draft?.settings.backend]);

  // A draft, like a thread, always shows a model the CLI knows: the settings default or the CLI's own.
  useEffect(() => {
    if (!draft || !state) return;
    const list = models[draft.settings.backend]?.models;
    if (!list?.length || list.some((m) => m.id === draft.settings.model)) return;
    const preferred = state.settings.default_model[draft.settings.backend];
    const pick = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0]!;
    setDraft({ ...draft, settings: { ...draft.settings, model: pick.id, effort: pick.defaultEffort } });
  }, [draft?.settings.backend, draft?.settings.model, models]);

  // Like the Codex App, a thread always has a concrete model the CLI knows: pick the CLI's
  // default (or the settings default) when the thread has none or names one the CLI no longer lists.
  useEffect(() => {
    if (!thread) return;
    const list = models[thread.backend]?.models;
    if (!list?.length) return;
    const current = list.find((m) => m.id === thread.model);
    if (current) {
      if (current.efforts?.length && thread.effort && !current.efforts.includes(thread.effort)) void updateThread({ effort: current.defaultEffort });
      return;
    }
    const preferred = state?.settings.default_model[thread.backend];
    const pick = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0]!;
    void updateThread({ model: pick.id, effort: pick.defaultEffort });
  }, [thread?.id, thread?.backend, thread?.model, models]);
  const project = useMemo(() => (thread ? state?.projects.find((p) => p.id === thread.projectId) ?? null : null), [state, thread]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError(null);
      return await fn();
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    }
  };

  const addProject = () => act(async () => {
    const p = await bridge.invoke("project:add", undefined);
    if (p) await refresh();
  });
  /** First send from a draft: create the thread with the draft's settings, then send. */
  const sendDraft = (text: string) => draft && act(async () => {
    const d = draft;
    setCreating(true);
    try {
      const s = d.settings;
      const t = await bridge.invoke("thread:create", { projectId: d.projectId, worktree: d.worktree, backend: s.backend, mode: s.mode, model: s.model || undefined, auto: s.auto });
      if (s.plan || s.effort) await bridge.invoke("thread:update", { threadId: t.id, patch: { ...(s.plan ? { plan: true } : {}), ...(s.effort ? { effort: s.effort } : {}) } });
      await refresh();
      justCreated.current = t.id;
      setDraft(null);
      setSelected(t.id);
      const r = await bridge.invoke("thread:send", { threadId: t.id, text });
      if (!r.ok) setError(r.error ?? "send failed");
    } finally {
      setCreating(false);
    }
  });
  const send = (text: string) => thread && act(async () => {
    const r = await bridge.invoke("thread:send", { threadId: thread.id, text });
    if (!r.ok) setError(r.error ?? "send failed");
  });
  const stop = () => thread && act(() => bridge.invoke("thread:stop", { threadId: thread.id }));
  const answer = (itemId: string, a: "yes" | "no" | "always") => thread && act(() => bridge.invoke("thread:answer", { threadId: thread.id, itemId, answer: a }));
  const updateThread = (patch: ThreadPatch) => thread && act(async () => {
    await bridge.invoke("thread:update", { threadId: thread.id, patch });
    await refresh();
  });
  const deleteThread = (t: Thread) => act(async () => {
    const removeWorktree = t.worktree ? window.confirm(`Delete this thread and remove its worktree?\n\n${t.worktree.path}\n\nUncommitted changes there will be lost; the branch ${t.worktree.branch} is kept.`) : true;
    if (t.worktree && !removeWorktree) return;
    const s = await bridge.invoke("thread:delete", { threadId: t.id, removeWorktree });
    setState(s);
    if (selected === t.id) setSelected(s.threads.find((x) => x.projectId === t.projectId)?.id ?? s.threads[0]?.id ?? null);
  });
  const removeProject = (projectId: string) => act(async () => {
    if (!window.confirm("Remove this project from Modex? Files on disk are not touched.")) return;
    const s = await bridge.invoke("project:remove", { projectId });
    setState(s);
    if (thread?.projectId === projectId) setSelected(s.threads[0]?.id ?? null);
  });
  const revert = (path: string) => thread && act(async () => {
    if (!window.confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
    setChanges(await bridge.invoke("changes:revert", { threadId: thread.id, path }));
  });
  const openPath = (p: string) => act(() => bridge.invoke("shell:openPath", { path: p }));
  const openTerminal = (p: string) => act(() => bridge.invoke("shell:openTerminal", { path: p }));
  const saveSettings = (patch: Partial<Settings>) => act(async () => {
    await bridge.invoke("settings:update", patch);
    await refresh();
  });

  // Keyboard shortcuts: ⌘N new thread, ⇧⌘N worktree thread, ⌘⏎ send (handled in Composer), ⇧⌘P plan, ⌘. stop, ⌘J changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const pid = thread?.projectId ?? draft?.projectId ?? state?.projects[0]?.id;
      if (e.key.toLowerCase() === "n" && pid) {
        e.preventDefault();
        openDraft(pid, e.shiftKey);
      } else if (e.key.toLowerCase() === "p" && e.shiftKey && (thread || draft)) {
        e.preventDefault();
        if (thread) void updateThread({ plan: !thread.plan });
        else if (draft) setDraft({ ...draft, settings: { ...draft.settings, plan: !draft.settings.plan } });
      } else if (e.key === "." && thread) {
        e.preventDefault();
        void stop();
      } else if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        setShowChanges((v) => !v);
      } else if (e.key === "Enter" && (thread || draft) && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread, state, draft]);

  // Focus the composer whenever the selected thread changes.
  useEffect(() => {
    inputRef.current?.focus();
  }, [selected]);

  if (!state) return <div className="app loading">Loading…</div>;

  const newChat = () => {
    const pid = thread?.projectId ?? draft?.projectId ?? state.projects[0]?.id;
    if (pid) openDraft(pid);
  };

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-closed"}`}>
      <TitleBar
        thread={thread}
        onRename={(title) => void updateThread({ title })}
        canBack={history.canBack}
        canForward={history.canForward}
        onBack={history.back}
        onForward={history.forward}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        showChanges={showChanges}
        onToggleChanges={() => setShowChanges((v) => !v)}
        changedCount={changes?.files.length ?? 0}
      />
      <Rail onOpenSettings={() => setShowSettings(true)} />
      <div className="sheet" data-testid="sheet">
        {sidebarOpen && (
          <Sidebar
            state={state}
            selected={selected}
            onSelect={selectThread}
            draftProjectId={draft?.projectId}
            onAddProject={addProject}
            onNewChat={newChat}
            onNewThread={openDraft}
            onDeleteThread={deleteThread}
            onRemoveProject={removeProject}
          />
        )}
        <main className="main" data-testid="main">
          {thread && project ? (
            <ThreadView
              thread={thread}
              project={project}
              items={items[thread.id] ?? []}
              onSend={send}
              onStop={stop}
              onAnswer={answer}
              onUpdate={updateThread}
              models={models[thread.backend]?.models ?? []}
              modelsError={models[thread.backend]?.error}
              inputRef={inputRef}
              onOpenPath={openPath}
              onOpenTerminal={openTerminal}
              platform={bridge.platform}
              branch={changes?.branch ?? undefined}
            />
          ) : draft ? (
            <DraftView
              key={`${draft.projectId}`}
              draft={draft}
              projects={state.projects}
              creating={creating}
              models={models[draft.settings.backend]?.models ?? []}
              modelsError={models[draft.settings.backend]?.error}
              onChange={setDraft}
              onSend={sendDraft}
              inputRef={inputRef}
            />
          ) : state.projects.length === 0 ? (
            <EmptyState onAddProject={addProject} />
          ) : null}
          {error && (
            <div className="toast" role="alert">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
            </div>
          )}
        </main>
        {thread && showChanges && <ChangesPanel thread={thread} changes={changes} onRefresh={() => loadChanges(thread.id)} onRevert={revert} />}
      </div>
      {showSettings && <SettingsDialog settings={state.settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
