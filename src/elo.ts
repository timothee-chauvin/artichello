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
const K_STREAK = 64;        // K multiplied by 2 when on a win streak (≥2 consecutive wins)
const K_LOSS_STREAK = 48;   // K amplified when on a loss streak (≥2 consecutive losses) — hidden
const STREAK_THRESHOLD = 2; // consecutive wins required to trigger win-streak boost
const LOSS_STREAK_THRESHOLD = 2; // consecutive losses required to trigger loss-streak penalty
const ALPHA = 1 / 400;

function teamAvgElo(players: string[], currentElo: Record<string, number>): number {
  return players.reduce((sum, p) => sum + currentElo[p]!, 0) / players.length;
}

function expectedGoals(eloUs: number, eloThem: number, totalGoals: number): number {
  const pGoal = 1 / (1 + Math.pow(10, ALPHA * (eloThem - eloUs)));
  return pGoal * totalGoals;
}

/** Selects the appropriate K factor for a player given their raw score delta and current streaks.
 *  - Gain (rawDelta > 0): use K_STREAK if on a win streak, otherwise K_BASE.
 *  - Loss (rawDelta < 0): use K_LOSS_STREAK if on a loss streak, otherwise K_BASE.
 *  The asymmetry ensures streaks never amplify the "wrong" direction.
 */
function pickK(rawDelta: number, winStreak: number, lossStreak: number): number {
  if (rawDelta > 0) {
    return winStreak >= STREAK_THRESHOLD ? K_STREAK : K_BASE;
  } else {
    return lossStreak >= LOSS_STREAK_THRESHOLD ? K_LOSS_STREAK : K_BASE;
  }
}

export interface EloResult {
  history: EloHistory;
  /** Current consecutive win streak per player (0 = no streak). */
  winStreaks: Record<string, number>;
}

export function computeEloHistory(games: Game[]): EloResult {
  const currentElo: Record<string, number> = {};
  const history: EloHistory = {};
  // Track consecutive wins per player (visible / exposed)
  const winStreaks: Record<string, number> = {};
  // Track consecutive losses per player (hidden — never exposed to players)
  const lossStreaks: Record<string, number> = {};

  for (let i = 0; i < games.length; i++) {
    const game = games[i]!;
    const allPlayers = [...game.players_a, ...game.players_b];

    for (const player of allPlayers) {
      if (!(player in currentElo)) {
        currentElo[player] = INITIAL_ELO;
        history[player] = [];
        winStreaks[player] = 0;
        lossStreaks[player] = 0;
      }
    }

    const avgA = teamAvgElo(game.players_a, currentElo);
    const avgB = teamAvgElo(game.players_b, currentElo);
    const totalGoals = game.score_a + game.score_b;

    const wonA = game.score_a > game.score_b;
    const wonB = game.score_b > game.score_a;

    // Bounty: sum of (streak × 10) for each opposing player currently on a kill streak
    const bountyForA = game.players_b.reduce(
      (sum, p) => sum + (winStreaks[p]! >= STREAK_THRESHOLD ? winStreaks[p]! * 10 : 0),
      0,
    );
    const bountyForB = game.players_a.reduce(
      (sum, p) => sum + (winStreaks[p]! >= STREAK_THRESHOLD ? winStreaks[p]! * 10 : 0),
      0,
    );

    for (const player of game.players_a) {
      const expected = expectedGoals(avgA, avgB, totalGoals);
      const rawDelta = game.score_a - expected;
      const k = pickK(rawDelta, winStreaks[player]!, lossStreaks[player]!);
      const delta = k * rawDelta / game.players_a.length;
      // Add bounty share if team A won
      const bountyGain = wonA ? bountyForA / game.players_a.length : 0;
      currentElo[player] = currentElo[player]! + delta + bountyGain;
      history[player]!.push({ gameIndex: i, elo: currentElo[player]! });

      // Update streaks
      if (wonA) {
        winStreaks[player] = (winStreaks[player] ?? 0) + 1;
        lossStreaks[player] = 0;
      } else {
        winStreaks[player] = 0;
        lossStreaks[player] = (lossStreaks[player] ?? 0) + 1;
      }
    }

    for (const player of game.players_b) {
      const expected = expectedGoals(avgB, avgA, totalGoals);
      const rawDelta = game.score_b - expected;
      const k = pickK(rawDelta, winStreaks[player]!, lossStreaks[player]!);
      const delta = k * rawDelta / game.players_b.length;
      // Add bounty share if team B won
      const bountyGain = wonB ? bountyForB / game.players_b.length : 0;
      currentElo[player] = currentElo[player]! + delta + bountyGain;
      history[player]!.push({ gameIndex: i, elo: currentElo[player]! });

      if (wonB) {
        winStreaks[player] = (winStreaks[player] ?? 0) + 1;
        lossStreaks[player] = 0;
      } else {
        winStreaks[player] = 0;
        lossStreaks[player] = (lossStreaks[player] ?? 0) + 1;
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
