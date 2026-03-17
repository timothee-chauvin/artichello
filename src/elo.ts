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
const K_LOSS_STREAK = 16;   // K halved when on a loss streak (≥2 consecutive losses) — hidden protection
const STREAK_THRESHOLD = 2; // consecutive wins required to trigger win-streak boost
const LOSS_STREAK_THRESHOLD = 2; // consecutive losses required to trigger loss-streak penalty
const TOP1_DECAY = 8; // Elo points lost per inactive weekday by the top-1 player
const ALPHA = 1 / 400;
const BOUNTY_BONUS = 16;

function teamAvgElo(players: string[], currentElo: Record<string, number>): number {
  return players.reduce((sum, p) => sum + currentElo[p]!, 0) / players.length;
}

function expectedGoals(eloUs: number, eloThem: number, totalGoals: number): number {
  const pGoal = 1 / (1 + Math.pow(10, ALPHA * (eloThem - eloUs)));
  return pGoal * totalGoals;
}

/** Selects the appropriate K factor for a player given their raw score delta and current streaks.
 *  - Gain (rawDelta > 0): use K_STREAK if on a win streak, otherwise K_BASE.
 *  - Loss (rawDelta < 0): use K_LOSS_STREAK (half of base) if on a loss streak, otherwise K_BASE.
 *  Players on a loss streak lose fewer points — a hidden protection mechanism.
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
  currentElo: Record<string, number>;
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

    // Bounty: sum of (streak × BOUNTY_BONUS) for each opposing player currently on a kill streak
    const bountyForA = game.players_b.reduce(
      (sum, p) => sum + (winStreaks[p]! >= STREAK_THRESHOLD ? winStreaks[p]! * BOUNTY_BONUS : 0),
      0,
    );
    const bountyForB = game.players_a.reduce(
      (sum, p) => sum + (winStreaks[p]! >= STREAK_THRESHOLD ? winStreaks[p]! * BOUNTY_BONUS : 0),
      0,
    );

    for (const player of game.players_a) {
      const expected = expectedGoals(avgA, avgB, totalGoals);
      const rawDelta = game.score_a - expected;
      const k = pickK(rawDelta, winStreaks[player]!, lossStreaks[player]!);
      let delta = k * rawDelta / game.players_a.length;
      // Clamp delta
      delta = Math.max(-64, Math.min(64, delta));
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
      let delta = k * rawDelta / game.players_b.length;
      // Clamp delta
      delta = Math.max(-64, Math.min(64, delta));
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

  // --- Chronological Weekly Activity Bonus and Daily Top-1 Decay ---
  if (games.length > 0) {
    applyChronologicalBonusesAndDecays(games, currentElo, history);
  }

  return { history, winStreaks, currentElo };
}

function applyChronologicalBonusesAndDecays(
  games: Game[],
  currentElo: Record<string, number>,
  history: EloHistory,
): void {
  const baseElo: Record<string, number> = {};
  const nonGameDeltas: Record<string, number> = {};
  for (const p in currentElo) {
    baseElo[p] = INITIAL_ELO;
    nonGameDeltas[p] = 0;
  }

  const firstDay = new Date(games[0]!.timestamp);
  firstDay.setUTCHours(0, 0, 0, 0);

  const yesterday = new Date();
  yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const lastGameDate = new Date(games[games.length - 1]!.timestamp);
  lastGameDate.setUTCHours(0, 0, 0, 0);

  const endDay = new Date(Math.max(yesterday.getTime(), lastGameDate.getTime()));

  let gameIdx = 0;
  let currentWeekKey = "";
  const playedDaysInWeek = new Map<string, Set<string>>();

  function isoWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  for (let cursor = new Date(firstDay); cursor <= endDay; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const playersToday = new Set<string>();

    // 1. Process all games on this day
    while (gameIdx < games.length && games[gameIdx]!.timestamp.slice(0, 10) === dateStr) {
      const game = games[gameIdx]!;
      for (const p of [...game.players_a, ...game.players_b]) {
        playersToday.add(p);
        const entry = history[p]!.find((e) => e.gameIndex === gameIdx);
        if (entry) {
          baseElo[p] = entry.elo;
        }
      }
      gameIdx++;
    }

    // 2. Weekly Activity Bonus
    const weekKey = isoWeekKey(cursor);
    if (currentWeekKey !== "" && currentWeekKey !== weekKey) {
      for (const [p, days] of playedDaysInWeek) {
        if (days.size >= WEEKLY_BONUS_DAYS) {
          nonGameDeltas[p]! += WEEKLY_BONUS_AMOUNT;
        }
      }
      playedDaysInWeek.clear();
    }
    currentWeekKey = weekKey;

    for (const p of playersToday) {
      if (!playedDaysInWeek.has(p)) playedDaysInWeek.set(p, new Set());
      playedDaysInWeek.get(p)!.add(dateStr);
    }

    // 3. Top-1 Decay
    if (cursor <= yesterday) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) { // Mon-Fri only
        const actualElos = Object.keys(baseElo)
          .map((p) => ({ p, elo: baseElo[p]! + nonGameDeltas[p]! }))
          .sort((a, b) => b.elo - a.elo);

        if (actualElos.length > 0) {
          const top1Player = actualElos[0]!.p;
          if (!playersToday.has(top1Player)) {
            nonGameDeltas[top1Player]! -= TOP1_DECAY;
          }
        }
      }
    }
  }

  // Apply final week bonus if the loop ended before the week changed
  for (const [p, days] of playedDaysInWeek) {
    if (days.size >= WEEKLY_BONUS_DAYS) {
      nonGameDeltas[p]! += WEEKLY_BONUS_AMOUNT;
    }
  }

  // Overwrite currentElo with actual computed Elo
  for (const p in currentElo) {
    currentElo[p] = baseElo[p]! + nonGameDeltas[p]!;
  }
}

const WEEKLY_BONUS_DAYS = 2;  // distinct days required to earn the bonus
const WEEKLY_BONUS_AMOUNT = 16; // Elo points awarded



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
