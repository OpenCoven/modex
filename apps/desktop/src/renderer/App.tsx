import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, ChangesSnapshot, Settings, Thread, ThreadEvent, ThreadItem } from "../shared/types";
import { bridge } from "./bridge";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { ChangesPanel } from "./components/ChangesPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { EmptyState } from "./components/EmptyState";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, ThreadItem[]>>({});
  const [changes, setChanges] = useState<ChangesSnapshot | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    void bridge.invoke("thread:items", { threadId: selected }).then((list) => setItems((m) => ({ ...m, [selected]: list })));
    void loadChanges(selected);
  }, [selected, loadChanges]);

  const thread = useMemo(() => state?.threads.find((t) => t.id === selected) ?? null, [state, selected]);
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
  const newThread = (projectId: string, worktree = false) => act(async () => {
    const t = await bridge.invoke("thread:create", { projectId, worktree });
    await refresh();
    setSelected(t.id);
  });
  const send = (text: string) => thread && act(async () => {
    const r = await bridge.invoke("thread:send", { threadId: thread.id, text });
    if (!r.ok) setError(r.error ?? "send failed");
  });
  const stop = () => thread && act(() => bridge.invoke("thread:stop", { threadId: thread.id }));
  const answer = (itemId: string, a: "yes" | "no" | "always") => thread && act(() => bridge.invoke("thread:answer", { threadId: thread.id, itemId, answer: a }));
  const updateThread = (patch: Partial<Pick<Thread, "mode" | "model" | "title">>) => thread && act(async () => {
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
  const saveSettings = (patch: Partial<Settings>) => act(async () => {
    await bridge.invoke("settings:update", patch);
    await refresh();
  });

  if (!state) return <div className="app loading">Loading…</div>;

  return (
    <div className="app">
      <Sidebar
        state={state}
        selected={selected}
        onSelect={setSelected}
        onAddProject={addProject}
        onNewThread={newThread}
        onDeleteThread={deleteThread}
        onRemoveProject={removeProject}
        onOpenSettings={() => setShowSettings(true)}
      />
      <main className="main">
        {thread && project ? (
          <ThreadView
            thread={thread}
            project={project}
            items={items[thread.id] ?? []}
            onSend={send}
            onStop={stop}
            onAnswer={answer}
            onUpdate={updateThread}
            showChanges={showChanges}
            onToggleChanges={() => setShowChanges((v) => !v)}
            changedCount={changes?.files.length ?? 0}
          />
        ) : (
          <EmptyState hasProjects={state.projects.length > 0} onAddProject={addProject} onNewThread={() => state.projects[0] && newThread(state.projects[0].id)} />
        )}
        {error && (
          <div className="toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}
      </main>
      {thread && showChanges && <ChangesPanel thread={thread} changes={changes} onRefresh={() => loadChanges(thread.id)} onRevert={revert} />}
      {showSettings && <SettingsDialog settings={state.settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
