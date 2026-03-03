export interface Game {
  timestamp: string;
  players_a: string[];
  players_b: string[];
  score_a: number;
  score_b: number;
}

export interface EloHistory {
  // player name → array of {gameIndex, elo} entries
  [player: string]: { gameIndex: number; elo: number }[];
}

// Simple seeded PRNG based on game timestamp for deterministic results
function seededRandom(seed: string, playerName: string): number {
  let hash = 0;
  const str = seed + playerName;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return ((hash & 0x7fffffff) % 61) - 30; // range [-30, 30]
}

const INITIAL_ELO = 1000;

export function computeEloHistory(games: Game[]): EloHistory {
  const currentElo: Record<string, number> = {};
  const history: EloHistory = {};

  for (let i = 0; i < games.length; i++) {
    const game = games[i]!;
    const allPlayers = [...game.players_a, ...game.players_b];

    for (const player of allPlayers) {
      if (!(player in currentElo)) {
        currentElo[player] = INITIAL_ELO;
        history[player] = [{ gameIndex: i, elo: INITIAL_ELO }];
      }
    }

    // Dummy: each participant gets a random delta seeded by timestamp
    for (const player of allPlayers) {
      const delta = seededRandom(game.timestamp, player);
      currentElo[player] = currentElo[player]! + delta;
      history[player]!.push({ gameIndex: i, elo: currentElo[player]! });
    }
  }

  return history;
}

export function getCurrentElo(history: EloHistory): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [player, entries] of Object.entries(history)) {
    result[player] = entries.length > 0 ? entries[entries.length - 1]!.elo : INITIAL_ELO;
  }
  return result;
}
