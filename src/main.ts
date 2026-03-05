import { computeEloHistory, computeExpectedScore, getCurrentElo, INITIAL_ELO, type Game, type EloHistory } from "./elo.ts";

const REPO = "timothee-chauvin/artichello";
const GITHUB_API = "https://api.github.com";

// --- State ---
let players: string[] = [];
let games: Game[] = [];
let eloHistory: EloHistory = {};
let winStreaks: Record<string, number> = {};
let chart: any = null;

// --- Auth ---
function getToken(): string | null {
  return localStorage.getItem("github_pat");
}

function setToken(token: string) {
  localStorage.setItem("github_pat", token);
}

function showAuth() {
  document.getElementById("auth-screen")!.style.display = "flex";
  document.getElementById("main-screen")!.style.display = "none";
}

function showMain() {
  document.getElementById("auth-screen")!.style.display = "none";
  document.getElementById("main-screen")!.style.display = "block";
}

// --- GitHub API ---
async function githubDispatch(eventType: string, payload: Record<string, unknown>) {
  const token = getToken();
  if (!token) throw new Error("No GitHub PAT");

  const res = await fetch(`${GITHUB_API}/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
}

async function fetchData() {
  const base = getDataBaseUrl();
  const [playersRes, gamesRes] = await Promise.all([
    fetch(`${base}/data/players.json`, { cache: "no-store" }),
    fetch(`${base}/data/games.json`, { cache: "no-store" }),
  ]);
  players = await playersRes.json();
  games = await gamesRes.json();
  ({ history: eloHistory, winStreaks } = computeEloHistory(games));
}

function getDataBaseUrl(): string {
  // In production (GitHub Pages), data is at the site root
  // For local dev, also works from root
  return window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "");
}

// --- Rendering ---
function renderLeaderboard() {
  const { currentElo } = computeEloHistory(games);
  const sorted = Object.entries(currentElo).sort(([, a], [, b]) => b - a);

  // Compute rank before the last game to show rank changes
  const prevRankMap: Record<string, number> = {};
  if (games.length >= 1) {
    const { currentElo: prevElo } = computeEloHistory(games.slice(0, -1));
    const prevSorted = Object.entries(prevElo).sort(([, a], [, b]) => b - a);
    prevSorted.forEach(([name], idx) => { prevRankMap[name] = idx + 1; });
  }

  const tbody = document.querySelector("#leaderboard tbody")!;
  tbody.innerHTML = sorted
    .map(([name, elo], i) => {
      const streak = winStreaks[name] ?? 0;
      const onStreak = streak >= 2;
      const nameHtml = onStreak
        ? `<strong style="color:red">${escapeHtml(name)} 🔥${streak}</strong>`
        : escapeHtml(name);

      const currentRank = i + 1;
      const prevRank = prevRankMap[name];
      let rankArrow = "";
      if (prevRank !== undefined && prevRank !== currentRank) {
        if (currentRank < prevRank) {
          rankArrow = ` <span style="color:#22c55e;font-size:0.85em">▲</span>`;
        } else {
          rankArrow = ` <span style="color:#ef4444;font-size:0.85em">▼</span>`;
        }
      }

      return `<tr><td>${currentRank}</td><td>${nameHtml}</td><td>${Math.round(elo)}${rankArrow}</td></tr>`;
    })
    .join("");

  // Also show players with no games
  for (const p of players) {
    if (!(p in currentElo)) {
      const row = `<tr><td>${sorted.length + 1}</td><td>${escapeHtml(p)}</td><td>1000</td></tr>`;
      tbody.innerHTML += row;
    }
  }
}

function renderChart() {
  const canvas = document.getElementById("elo-chart") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  // tol-colors bright palette (colorblind-friendly)
  const colors = [
    "#4477AA", "#EE6677", "#228833", "#CCBB44",
    "#66CCEE", "#AA3377", "#BBBBBB",
  ];

  // Pre-compute expected scores per game for tooltip
  // For each game i, expected score is based on elo *before* game i.
  // We use eloHistory to get the elo after game i-1 (i.e., the entry with gameIndex === i-1).
  const gameExpected: { expA: number; expB: number }[] = [];
  {
    // Build a helper: player -> sorted entries by gameIndex (already in order)
    const getEloAtGame = (player: string, beforeGameIndex: number): number => {
      const entries = eloHistory[player];
      if (!entries || entries.length === 0) return INITIAL_ELO;
      // Find the last entry strictly before beforeGameIndex
      let elo = INITIAL_ELO;
      for (const e of entries) {
        if (e.gameIndex < beforeGameIndex) elo = e.elo;
        else break;
      }
      return elo;
    };

    for (let gi = 0; gi < games.length; gi++) {
      const g = games[gi]!;
      const avgA = g.players_a.reduce((s, p) => s + getEloAtGame(p, gi), 0) / g.players_a.length;
      const avgB = g.players_b.reduce((s, p) => s + getEloAtGame(p, gi), 0) / g.players_b.length;
      const [expA, expB] = computeExpectedScore(avgA, avgB);
      gameExpected.push({ expA, expB });
    }
  }

  const datasets = Object.entries(eloHistory).map(([player, entries], i) => ({
    label: player,
    data: entries.map((e) => ({ x: e.gameIndex, y: e.elo })),
    borderColor: colors[i % colors.length],
    backgroundColor: colors[i % colors.length],
    fill: false,
    tension: 0,
    pointRadius: 3,
  }));

  if (chart) chart.destroy();

  const fmt = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(1));

  // @ts-ignore - Chart.js loaded via CDN
  chart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Game #" },
          ticks: { stepSize: 1 },
        },
        y: { title: { display: true, text: "Elo" } },
      },
      plugins: {
        legend: { position: "top" as const },
        tooltip: {
          callbacks: {
            title: (items: any[]) => {
              const gameIndex = items[0]?.parsed?.x as number;
              const g = games[gameIndex];
              if (!g) return `Game #${gameIndex}`;
              const teamA = g.players_a.join(", ");
              const teamB = g.players_b.join(", ");
              const exp = gameExpected[gameIndex];
              const maxGoals = Math.max(g.score_a, g.score_b);
              const scale = maxGoals / 10;
              const expA = exp ? fmt(exp.expA * scale) : "?";
              const expB = exp ? fmt(exp.expB * scale) : "?";
              return [
                teamA,
                `(${expA}) ${g.score_a} - ${g.score_b} (${expB})`,
                teamB,
              ];
            },
            label: (_item: any) => "",
          },
        },
      },
    },
  });
}

function renderGameHistory() {
  const container = document.getElementById("game-history-list")!;
  if (games.length === 0) {
    container.innerHTML = "<p>No games yet.</p>";
    return;
  }

  container.innerHTML = [...games]
    .reverse()
    .map((g) => {
      const date = new Date(g.timestamp).toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });

      // Déterminer qui a perdu
      const isALoser = g.score_a < g.score_b;
      const isBLoser = g.score_b < g.score_a;

      const teamA = g.players_a.map(escapeHtml).join(", ");
      const teamB = g.players_b.map(escapeHtml).join(", ");

      return `<div class="game-entry">
  <span class="game-date">${date}</span>
  
  <span class="team-a ${isALoser ? 'game-loser' : ''}">
    ${teamA}
  </span>

  <strong>${g.score_a} - ${g.score_b}</strong>

  <span class="team-b ${isBLoser ? 'game-loser' : ''}">
    ${teamB}
  </span>
</div>`;
    })
    .join("");
}

function renderPlayerSelectors() {
  const containerA = document.getElementById("players-a")!;
  const containerB = document.getElementById("players-b")!;

  // 1. On récupère les valeurs COCHÉES (on utilise .value car c'est le nom du joueur)
  const selectedA = Array.from(containerA.querySelectorAll("input:checked")).map(
    (el) => (el as HTMLInputElement).value
  );
  const selectedB = Array.from(containerB.querySelectorAll("input:checked")).map(
    (el) => (el as HTMLInputElement).value
  );

  const setA = new Set(selectedA);
  const setB = new Set(selectedB);

  const currentElo = getCurrentElo(eloHistory);
  const eloLabel = (p: string) => {
    const e = currentElo[p] ?? INITIAL_ELO;
    return `<span class="player-elo">${Math.round(e)}</span>`;
  };

  // 2. Rendu pour l'équipe A : on affiche tous les joueurs SAUF ceux cochés en B
  containerA.innerHTML = players
    .filter((p) => !setB.has(p))
    .map(
      (p) =>
        `<label><input type="checkbox" value="${escapeHtml(p)}"${setA.has(p) ? " checked" : ""}> ${escapeHtml(p)} ${eloLabel(p)}</label>`
    )
    .join("");

  // 3. Rendu pour l'équipe B : on affiche tous les joueurs SAUF ceux cochés en A
  containerB.innerHTML = players
    .filter((p) => !setA.has(p))
    .map(
      (p) =>
        `<label><input type="checkbox" value="${escapeHtml(p)}"${setB.has(p) ? " checked" : ""}> ${escapeHtml(p)} ${eloLabel(p)}</label>`
    )
    .join("");
}

function updateExpectedScore() {
  const el = document.getElementById("expected-score")!;
  const getSelected = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} input:checked`)).map(
      (cb) => (cb as HTMLInputElement).value
    );
  const playersA = getSelected("players-a");
  const playersB = getSelected("players-b");

  const currentElo = getCurrentElo(eloHistory);
  const avgElo = (ps: string[]) =>
    ps.reduce((s, p) => s + (currentElo[p] ?? INITIAL_ELO), 0) / ps.length;

  // Mise à jour des titres Team A / Team B avec l'Elo moyen
  const elTeamA = document.getElementById("team-a-elo")!;
  const elTeamB = document.getElementById("team-b-elo")!;
  elTeamA.textContent = playersA.length > 0 ? `${Math.round(avgElo(playersA))}` : "";
  elTeamB.textContent = playersB.length > 0 ? `${Math.round(avgElo(playersB))}` : "";

  if (playersA.length === 0 || playersB.length === 0) {
    el.textContent = "";
    return;
  }

  const [scoreA, scoreB] = computeExpectedScore(avgElo(playersA), avgElo(playersB));
  const fmt = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(1));
  el.textContent = `${fmt(scoreA)} - ${fmt(scoreB)}`;
}

function balanceTeams() {
  // 1. Récupérer tous les joueurs sélectionnés (dans A ou B)
  const getSelected = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} input:checked`)).map(
      (cb) => (cb as HTMLInputElement).value
    );
  const selected = [...new Set([...getSelected("players-a"), ...getSelected("players-b")])];

  if (selected.length < 2) return;

  const currentElo = getCurrentElo(eloHistory);
  const elo = (p: string) => currentElo[p] ?? INITIAL_ELO;

  const n = selected.length;
  const sizeA = Math.floor(n / 2);  // équipe A = la plus petite ou égale

  let bestDiff = Infinity;
  let bestA: string[] = [];
  let bestB: string[] = [];

  // Brute-force tous les sous-ensembles de taille sizeA
  for (let mask = 0; mask < (1 << n); mask++) {
    if (mask.toString(2).split("").filter(c => c === "1").length !== sizeA) continue;
    const teamA = selected.filter((_, i) => (mask >> i) & 1);
    const teamB = selected.filter((_, i) => !((mask >> i) & 1));
    const avgA = teamA.reduce((s, p) => s + elo(p), 0) / teamA.length;
    const avgB = teamB.reduce((s, p) => s + elo(p), 0) / teamB.length;
    const diff = Math.abs(avgA - avgB);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestA = teamA;
      bestB = teamB;
    }
  }

  // 2. Appliquer la meilleure partition aux checkboxes
  // On rerender les selectors avec bestA dans A et bestB dans B
  const containerA = document.getElementById("players-a")!;
  const containerB = document.getElementById("players-b")!;
  const setA = new Set(bestA);
  const setB = new Set(bestB);

  const currentEloAll = getCurrentElo(eloHistory);
  const eloLabel = (p: string) => {
    const e = currentEloAll[p] ?? INITIAL_ELO;
    return `<span class="player-elo">${Math.round(e)}</span>`;
  };

  containerA.innerHTML = players
    .filter((p) => !setB.has(p))
    .map(
      (p) =>
        `<label><input type="checkbox" value="${escapeHtml(p)}"${setA.has(p) ? " checked" : ""}> ${escapeHtml(p)} ${eloLabel(p)}</label>`
    )
    .join("");

  containerB.innerHTML = players
    .filter((p) => !setA.has(p))
    .map(
      (p) =>
        `<label><input type="checkbox" value="${escapeHtml(p)}"${setB.has(p) ? " checked" : ""}> ${escapeHtml(p)} ${eloLabel(p)}</label>`
    )
    .join("");

  updateExpectedScore();
}

function renderAll() {
  renderLeaderboard();
  renderChart();
  renderGameHistory();
  renderPlayerSelectors();
  updateExpectedScore();
}

// --- Actions ---
async function handleAddPlayer() {
  const input = document.getElementById("new-player-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  if (players.includes(name)) {
    showStatus("Player already exists", true);
    return;
  }

  showStatus("Adding player...");
  try {
    await githubDispatch("add_player", { name });
    // Optimistic update
    players.push(name);
    input.value = "";
    renderAll();
    showStatus("Player added! Data will update in ~30s after the GitHub Action runs.");
  } catch (e: any) {
    showStatus(`Error: ${e.message}`, true);
  }
}

async function handleAddGame() {
  const getSelected = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} input:checked`)).map(
      (el) => (el as HTMLInputElement).value
    );

  const playersA = getSelected("players-a");
  const playersB = getSelected("players-b");
  const scoreA = parseInt((document.getElementById("score-a") as HTMLInputElement).value);
  const scoreB = parseInt((document.getElementById("score-b") as HTMLInputElement).value);

  if (playersA.length === 0 || playersB.length === 0) {
    showStatus("Select at least one player per team", true);
    return;
  }
  if (isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreA > 10 || scoreB < 0 || scoreB > 10) {
    showStatus("Scores must be between 0 and 10", true);
    return;
  }

  const overlap = playersA.filter((p) => playersB.includes(p));
  if (overlap.length > 0) {
    showStatus(`Player(s) ${overlap.join(", ")} can't be on both teams`, true);
    return;
  }

  showStatus("Adding game...");
  try {
    const game: Game = {
      timestamp: new Date().toISOString(),
      players_a: playersA,
      players_b: playersB,
      score_a: scoreA,
      score_b: scoreB,
    };
    await githubDispatch("add_game", game as unknown as Record<string, unknown>);
    // Optimistic update
    games.push(game);
    ({ history: eloHistory, winStreaks } = computeEloHistory(games));
    (document.getElementById("score-a") as HTMLInputElement).value = "";
    (document.getElementById("score-b") as HTMLInputElement).value = "";
    renderAll();
    showStatus("Game added! Data will update in ~30s after the GitHub Action runs.");
  } catch (e: any) {
    showStatus(`Error: ${e.message}`, true);
  }
}

function handleLogout() {
  localStorage.removeItem("github_pat");
  showAuth();
}

function showStatus(msg: string, isError = false) {
  const el = document.getElementById("status")!;
  el.textContent = msg;
  el.className = isError ? "status error" : "status success";
  if (!isError) setTimeout(() => (el.textContent = ""), 5000);
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function loadAndRender() {
  showStatus("Loading data...");
  try {
    await fetchData();
    renderAll();
    showStatus("");
  } catch (e: any) {
    showStatus(`Failed to load data: ${e.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", init);

// --- Init ---
async function init() {
  // Auth
  const authForm = document.getElementById("auth-form")!;
  authForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("pat-input") as HTMLInputElement;
    const token = input.value.trim();
    if (token) {
      setToken(token);
      showMain();
      loadAndRender();
    }
  });

  // Mise à jour : On appelle renderPlayerSelectors à chaque changement pour filtrer
  document.getElementById("players-a")!.addEventListener("change", () => {
    renderPlayerSelectors(); // On filtre d'abord
    updateExpectedScore();    // On calcule le score après
  });

  document.getElementById("players-b")!.addEventListener("change", () => {
    renderPlayerSelectors(); // On filtre d'abord
    updateExpectedScore();    // On calcule le score après
  });

  document.getElementById("btn-add-player")!.addEventListener("click", handleAddPlayer);
  document.getElementById("btn-balance")!.addEventListener("click", balanceTeams);
  document.getElementById("btn-add-game")!.addEventListener("click", handleAddGame);
  document.getElementById("btn-logout")!.addEventListener("click", handleLogout);
  document.getElementById("btn-refresh")!.addEventListener("click", loadAndRender);

  if (getToken()) {
    showMain();
    await loadAndRender();
  } else {
    showAuth();
  }
}