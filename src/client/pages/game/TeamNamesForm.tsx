import { useEffect, useState } from "preact/hooks";
import type { GameView } from "../../game/types";
import { teamBySlot } from "../../game/view";

export type Names = { team1: string; team2: string };

type Props = {
  view: GameView;
  submitLabel: string;
  busy: boolean;
  /** Always shows the submit button (setup); otherwise only once edited (rolled). */
  alwaysSubmit?: boolean;
  /** Resolves true once saved; a failed save keeps the draft. */
  onSubmit(names: Names, changed: boolean): Promise<boolean>;
};

// Keeps a local draft so a poll from another phone can't overwrite what's being
// typed. Re-syncs from the server while the draft is untouched.
export function TeamNamesForm({ view, submitLabel, busy, alwaysSubmit, onSubmit }: Props) {
  const server: Names = { team1: teamBySlot(view, 1).name, team2: teamBySlot(view, 2).name };
  const [draft, setDraft] = useState<Names>(server);
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (!edited) setDraft(server);
  }, [server.team1, server.team2, edited]);

  const changed = draft.team1.trim() !== server.team1 || draft.team2.trim() !== server.team2;
  const field = (key: keyof Names, label: string) => (
    <div class="stack tight">
      <label for={key}>{label}</label>
      <input
        id={key}
        value={draft[key]}
        autocomplete="off"
        onInput={(e) => {
          setDraft({ ...draft, [key]: e.currentTarget.value });
          setEdited(true);
        }}
      />
    </div>
  );

  return (
    <form
      class="stack names"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSubmit(draft, changed)) setEdited(false);
      }}
    >
      {field("team1", "Team 1")}
      {field("team2", "Team 2")}
      {(alwaysSubmit || changed) && (
        <button type="submit" class={alwaysSubmit ? "big" : "secondary"} disabled={busy}>
          {submitLabel}
        </button>
      )}
    </form>
  );
}
