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

  // --- Weekly activity bonus (acidity bonus) ---
  applyWeeklyActivityBonus(games, currentElo, history);

  // --- Daily decay for top-1 ---
  applyTop1Decay(games, currentElo, history);

  return { history, winStreaks, currentElo };
}

const WEEKLY_BONUS_DAYS = 2;  // distinct days required to earn the bonus
const WEEKLY_BONUS_AMOUNT = 16; // Elo points awarded

/**
 * For each ISO calendar week (Mon–Sun), award WEEKLY_BONUS_AMOUNT to every
 * player who played on at least WEEKLY_BONUS_DAYS different days that week.
 * The bonus is applied once per player per week and appended to history.
 */
function applyWeeklyActivityBonus(
  games: Game[],
  currentElo: Record<string, number>,
  history: EloHistory,
): void {
  if (games.length === 0) return;

  /** Returns "YYYY-Www" ISO week key for a given date. */
  function isoWeekKey(date: Date): string {
    // Copy to avoid mutation
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // ISO week: Thursday of the week determines the year
    const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=Mon … 7=Sun
    d.setUTCDate(d.getUTCDate() + 4 - day); // set to Thursday
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  // week -> player -> Set<dateStr>
  const weekPlayerDays = new Map<string, Map<string, Set<string>>>();

  for (const game of games) {
    const date = new Date(game.timestamp);
    const week = isoWeekKey(date);
    const dateStr = game.timestamp.slice(0, 10);

    if (!weekPlayerDays.has(week)) weekPlayerDays.set(week, new Map());
    const playerDays = weekPlayerDays.get(week)!;

    for (const p of [...game.players_a, ...game.players_b]) {
      if (!playerDays.has(p)) playerDays.set(p, new Set());
      playerDays.get(p)!.add(dateStr);
    }
  }

  // Synthetic index starting after the last real game entry
  let syntheticIndex = Object.values(history).reduce(
    (max, entries) => Math.max(max, entries.length > 0 ? entries[entries.length - 1]!.gameIndex : 0),
    0,
  ) + 1;

  // Apply bonuses in chronological week order
  for (const week of [...weekPlayerDays.keys()].sort()) {
    const playerDays = weekPlayerDays.get(week)!;
    for (const [player, days] of playerDays) {
      if (days.size >= WEEKLY_BONUS_DAYS) {
        currentElo[player] = (currentElo[player] ?? 0) + WEEKLY_BONUS_AMOUNT;
        // We don't add the bonus to history because it's not a real game
        //if (history[player]) {
        //  history[player].push({ gameIndex: syntheticIndex, elo: currentElo[player] });
        //}
        //syntheticIndex++;
      }
    }
  }
}

/**
 * For every weekday (Mon–Fri) between the first and last game where the
 * current top-1 player at end-of-day did NOT play, subtract TOP1_DECAY points.
 * Mutations are appended to `history` so the graph reflects the drops.
 */
function applyTop1Decay(
  games: Game[],
  currentElo: Record<string, number>,
  history: EloHistory,
): void {
  if (games.length === 0) return;

  // Build a map: dateStr ("YYYY-MM-DD") -> set of players who played that day
  const playedOnDay = new Map<string, Set<string>>();
  for (const game of games) {
    const day = game.timestamp.slice(0, 10); // "YYYY-MM-DD"
    if (!playedOnDay.has(day)) playedOnDay.set(day, new Set());
    for (const p of [...game.players_a, ...game.players_b]) {
      playedOnDay.get(day)!.add(p);
    }
  }

  // Iterate over every weekday from first game up to yesterday (decay applies even with no recent games)
  const firstDay = new Date(games[0]!.timestamp);
  firstDay.setUTCHours(0, 0, 0, 0);

  // "yesterday" midnight UTC — we don't decay the current in-progress day
  const yesterday = new Date();
  yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  // We use a synthetic gameIndex counter starting just after the last real game
  let syntheticIndex = Object.values(history).reduce(
    (max, entries) => Math.max(max, entries.length > 0 ? entries[entries.length - 1]!.gameIndex : 0),
    0,
  ) + 1;

  for (const cursor = new Date(firstDay); cursor <= yesterday; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dow = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) continue; // skip weekends

    const dateStr = cursor.toISOString().slice(0, 10);
    const playersToday = playedOnDay.get(dateStr) ?? new Set<string>();

    // Find the top-1 player at this point in time
    const top1 = Object.entries(currentElo).sort(([, a], [, b]) => b - a)[0];
    if (!top1) continue;
    const [top1Player] = top1;
    // We don't add the decay to history because it's not a real game
    //if (!playersToday.has(top1Player)) {
    //  currentElo[top1Player] = (currentElo[top1Player] ?? 0) - TOP1_DECAY;
    //  history[top1Player]!.push({ gameIndex: syntheticIndex++, elo: currentElo[top1Player] });
    //}
  }
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
