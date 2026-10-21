import { scoreAnnouncement, teamBySlot } from "../../game/view";
import type { GameView } from "../../game/types";

export function Scoreboard({ view }: { view: GameView }) {
  const teams = [teamBySlot(view, 1), teamBySlot(view, 2)];
  return (
    <div class="scoreboard">
      {teams.map((team) => (
        <div class={`score team-${team.slot}`} key={team.id}>
          <span class="score-number">{team.score}</span>
          <span class="score-name">{team.name}</span>
        </div>
      ))}
      <span class="visually-hidden" aria-live="polite">
        {scoreAnnouncement(view)}
      </span>
    </div>
  );
}
