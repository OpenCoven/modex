import { useRef, useState } from "react";
import type { BackendId, Mode, ModelInfo, Project } from "../../shared/types";
import { Composer } from "./Composer";
import { Icon } from "./ui/Icon";
import { Menu, MenuItem } from "./ui/Menu";

/** Composer settings a draft carries until its first send creates the thread. */
export interface DraftSettings {
  backend: BackendId;
  mode: Mode;
  plan: boolean;
  auto: boolean;
  model: string;
  effort?: string;
}

/** A new chat that is not a thread yet: nothing is written until the first message is sent. */
export interface Draft {
  projectId: string;
  worktree: boolean;
  settings: DraftSettings;
}

interface Props {
  draft: Draft;
  projects: Project[];
  /** True while the first send is creating the thread (a worktree can take a moment). */
  creating: boolean;
  models: ModelInfo[];
  modelsError?: string;
  onChange: (draft: Draft) => void;
  onSend: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * The "What should we build in <project>?" screen: a live composer before any thread exists.
 * The project name is a picker; the context strip's Local/Worktree item is a toggle.
 */
export function DraftView({ draft, projects, creating, models, modelsError, onChange, onSend, inputRef }: Props) {
  const project = projects.find((p) => p.id === draft.projectId);
  const set = (patch: Partial<DraftSettings>) => onChange({ ...draft, settings: { ...draft.settings, ...patch } });
  if (!project) return null;
  return (
    <section className="draft-view" data-testid="draft-view" data-project-id={project.id} data-worktree={draft.worktree}>
      <div className="draft-hero">
        <div className="draft-mark" aria-hidden="true">◆</div>
        <div className="draft-title" role="heading" aria-level={1} data-testid="draft-title">
          What should we build in{" "}
          <ProjectPicker projects={projects} project={project} onPick={(projectId) => onChange({ ...draft, projectId })} />?
        </div>
      </div>
      <Composer
        busy={creating}
        context={{ project: project.name, cwd: project.path, worktree: draft.worktree ? { branch: "" } : undefined, onToggleWorktree: () => onChange({ ...draft, worktree: !draft.worktree }) }}
        backend={draft.settings.backend}
        mode={draft.settings.mode}
        plan={draft.settings.plan}
        model={draft.settings.model}
        effort={draft.settings.effort}
        auto={draft.settings.auto}
        models={models}
        modelsError={modelsError}
        onBackend={(backend) => set({ backend, model: "", effort: undefined })}
        onMode={(mode) => set({ mode })}
        onPlan={(plan) => set({ plan })}
        onModel={(model) => set({ model })}
        onEffort={(effort) => set({ effort })}
        onAuto={(auto) => set({ auto })}
        onSend={onSend}
        onStop={() => {}}
        inputRef={inputRef}
      />
    </section>
  );
}

function ProjectPicker({ projects, project, onPick }: { projects: Project[]; project: Project; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="draft-project">
      <button ref={trigger} className="draft-project-name" data-testid="draft-project" aria-haspopup="listbox" aria-expanded={open} title={project.path} onClick={() => setOpen((v) => !v)}>
        {project.name}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} role="listbox" label="Project" placement="bottom-start" testId="draft-project-menu">
        {projects.map((p) => (
          <MenuItem key={p.id} checkable selected={p.id === project.id} data-testid="draft-project-option" data-project-id={p.id} title={p.path} onClick={() => { onPick(p.id); setOpen(false); }}>
            <Icon name="folder" size={14} />
            <span className="menu-body"><span className="menu-title">{p.name}</span></span>
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}
