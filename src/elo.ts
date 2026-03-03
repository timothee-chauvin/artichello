export interface Game {
  timestamp: string;
  players_a: string[];
  players_b: string[];
  score_a: number;
  score_b: number;
}

export interface EloHistory {
  [player: string]: { gameIndex: number; elo: number }[];
}

export const INITIAL_ELO = 1000;
const K_BASE = 32;
const K_STREAK = 64; // K multiplied by 2 when on a kill streak (≥2 consecutive wins)
const STREAK_THRESHOLD = 2; // number of consecutive wins required to trigger the boost
const ALPHA = 1 / 400;

function teamAvgElo(players: string[], currentElo: Record<string, number>): number {
  return players.reduce((sum, p) => sum + currentElo[p]!, 0) / players.length;
}

function expectedGoals(eloUs: number, eloThem: number, totalGoals: number): number {
  const pGoal = 1 / (1 + Math.pow(10, ALPHA * (eloThem - eloUs)));
  return pGoal * totalGoals;
}

export interface EloResult {
  history: EloHistory;
  /** Current consecutive win streak per player (0 = no streak). */
  winStreaks: Record<string, number>;
}

export function computeEloHistory(games: Game[]): EloResult {
  const currentElo: Record<string, number> = {};
  const history: EloHistory = {};
  // Track consecutive wins per player
  const winStreaks: Record<string, number> = {};

  for (let i = 0; i < games.length; i++) {
    const game = games[i]!;
    const allPlayers = [...game.players_a, ...game.players_b];

    for (const player of allPlayers) {
      if (!(player in currentElo)) {
        currentElo[player] = INITIAL_ELO;
        history[player] = [];
        winStreaks[player] = 0;
      }
    }

    const avgA = teamAvgElo(game.players_a, currentElo);
    const avgB = teamAvgElo(game.players_b, currentElo);
    const totalGoals = game.score_a + game.score_b;

    const wonA = game.score_a > game.score_b;
    const wonB = game.score_b > game.score_a;

    for (const player of game.players_a) {
      // Use boosted K if the player is already on a kill streak
      const k = winStreaks[player]! >= STREAK_THRESHOLD ? K_STREAK : K_BASE;
      const expected = expectedGoals(avgA, avgB, totalGoals);
      const delta = k * (game.score_a - expected) / game.players_a.length;
      currentElo[player] = currentElo[player]! + delta;
      history[player]!.push({ gameIndex: i, elo: currentElo[player]! });

      // Update streak
      if (wonA) {
        winStreaks[player] = (winStreaks[player] ?? 0) + 1;
      } else {
        winStreaks[player] = 0;
      }
    }

    for (const player of game.players_b) {
      const k = winStreaks[player]! >= STREAK_THRESHOLD ? K_STREAK : K_BASE;
      const expected = expectedGoals(avgB, avgA, totalGoals);
      const delta = k * (game.score_b - expected) / game.players_b.length;
      currentElo[player] = currentElo[player]! + delta;
      history[player]!.push({ gameIndex: i, elo: currentElo[player]! });

      if (wonB) {
        winStreaks[player] = (winStreaks[player] ?? 0) + 1;
      } else {
        winStreaks[player] = 0;
      }
    }
  }

  return { history, winStreaks };
}

export function computeExpectedScore(eloA: number, eloB: number): [number, number] {
  const pA = 1 / (1 + Math.pow(10, ALPHA * (eloB - eloA)));
  const pB = 1 - pA;
  const scale = 10 / Math.max(pA, pB);
  return [pA * scale, pB * scale];
}

export function getCurrentElo(history: EloHistory): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [player, entries] of Object.entries(history)) {
    result[player] = entries.length > 0 ? entries[entries.length - 1]!.elo : INITIAL_ELO;
  }
  return result;
}
