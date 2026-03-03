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
  const currentElo = getCurrentElo(eloHistory);
  const sorted = Object.entries(currentElo).sort(([, a], [, b]) => b - a);

  const tbody = document.querySelector("#leaderboard tbody")!;
  tbody.innerHTML = sorted
    .map(([name, elo], i) => {
      const streak = winStreaks[name] ?? 0;
      const onStreak = streak >= 2;
      const nameHtml = onStreak
        ? `<strong style="color:red">${escapeHtml(name)} 🔥${streak}</strong>`
        : escapeHtml(name);
      return `<tr><td>${i + 1}</td><td>${nameHtml}</td><td>${Math.round(elo)}</td></tr>`;
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
      const date = new Date(g.timestamp).toLocaleString();
      const teamA = g.players_a.map(escapeHtml).join(", ");
      const teamB = g.players_b.map(escapeHtml).join(", ");
      return `<div class="game-entry">
        <span class="game-date">${date}</span>
        <span class="game-teams">${teamA} <strong>${g.score_a} - ${g.score_b}</strong> ${teamB}</span>
      </div>`;
    })
    .join("");
}

function renderPlayerSelectors() {
  for (const id of ["players-a", "players-b"]) {
    const container = document.getElementById(id)!;
    const checked = new Set(
      Array.from(container.querySelectorAll("input:checked")).map(
        (el) => (el as HTMLInputElement).value
      )
    );
    container.innerHTML = players
      .map(
        (p) =>
          `<label><input type="checkbox" value="${escapeHtml(p)}"${checked.has(p) ? " checked" : ""}> ${escapeHtml(p)}</label>`
      )
      .join("");
  }
}

function updateExpectedScore() {
  const el = document.getElementById("expected-score")!;
  const getSelected = (id: string) =>
    Array.from(document.querySelectorAll(`#${id} input:checked`)).map(
      (cb) => (cb as HTMLInputElement).value
    );
  const playersA = getSelected("players-a");
  const playersB = getSelected("players-b");

  if (playersA.length === 0 || playersB.length === 0) {
    el.textContent = "";
    return;
  }

  const currentElo = getCurrentElo(eloHistory);
  const avgElo = (ps: string[]) =>
    ps.reduce((s, p) => s + (currentElo[p] ?? INITIAL_ELO), 0) / ps.length;

  const [scoreA, scoreB] = computeExpectedScore(avgElo(playersA), avgElo(playersB));
  const fmt = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(1));
  el.textContent = `${fmt(scoreA)} - ${fmt(scoreB)}`;
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

  document.getElementById("players-a")!.addEventListener("change", updateExpectedScore);
  document.getElementById("players-b")!.addEventListener("change", updateExpectedScore);
  document.getElementById("btn-add-player")!.addEventListener("click", handleAddPlayer);
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
