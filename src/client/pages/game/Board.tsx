import { cellState, teamBySlot } from "../../game/view";
import type { GameView, TaskView } from "../../game/types";

export type CellAction = { task: TaskView; slotIndex: 0 | 1; action: "complete" | "undo" };

type Props = {
  view: GameView;
  timeUp: boolean;
  pending: ReadonlySet<string>;
  reveal: boolean;
  onCell?(cell: CellAction): void;
};

export const cellKey = (taskId: number, slotIndex: number) => `cell:${taskId}:${slotIndex}`;

// One row per task, one checkbox column per team (SPEC.md §9). The final row
// shows a lock until that team has done everything else.
export function Board({ view, timeUp, pending, reveal, onCell }: Props) {
  const teams = [teamBySlot(view, 1), teamBySlot(view, 2)];
  return (
    <div class={`board${reveal ? " reveal" : ""}`} role="table" aria-label="Tasks">
      <div class="board-row board-head" role="row">
        <span role="columnheader">Task</span>
        {teams.map((team) => (
          <span role="columnheader" class={`team-${team.slot}`} title={team.name} key={team.id}>
            {team.name}
          </span>
        ))}
      </div>
      {view.tasks.map((task, i) => (
        <div
          class={`board-row${task.isFinal ? " final" : ""}`}
          role="row"
          key={task.id}
          style={{ "--i": i }}
        >
          <div class="task" role="cell">
            <span class="category">{task.categoryName}</span>
            <span class="task-text">{task.text}</span>
          </div>
          {([0, 1] as const).map((slotIndex) => {
            const cell = cellState(view, task, slotIndex, {
              timeUp,
              pending: pending.has(cellKey(task.id, slotIndex)),
            });
            return (
              <div role="cell" key={slotIndex}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={cell.checked}
                  aria-disabled={cell.action === null}
                  aria-busy={cell.busy}
                  aria-label={cell.label}
                  class={`cell team-${slotIndex + 1}${cell.checked ? " done" : ""}${cell.locked ? " locked" : ""}`}
                  onClick={() => {
                    if (cell.action && onCell) onCell({ task, slotIndex, action: cell.action });
                  }}
                >
                  <span aria-hidden="true">{cell.locked ? "🔒" : cell.checked ? "✓" : ""}</span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
