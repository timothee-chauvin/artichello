# Artichello — Table Soccer Elo Tracker

A static website for tracking table soccer games and Elo ratings, hosted on GitHub Pages with no backend server.

## How it works

**Data storage:** Two JSON files in `data/`:
- `players.json` — list of player names
- `games.json` — list of game records: `{timestamp, players_a, players_b, score_a, score_b}`

**Frontend:** A single-page app (TypeScript, bundled with Bun) that:
- Computes Elo ratings client-side from the full game history
- Shows a leaderboard and an Elo-over-time chart
- Lets users add players and record games (any team sizes: 1v1, 2v2, etc.)

**Backend:** There is no server. When a user adds a player or game:
1. The site calls the GitHub API (`repository_dispatch`) with the user's PAT
2. A GitHub Action receives the event, updates the JSON file, and commits the change
3. The deploy Action rebuilds and publishes the site

**Authentication:** Users provide a GitHub Personal Access Token (PAT) with `repo` scope. It's stored in the browser's `localStorage` and used exclusively for GitHub API calls.

## Setup

### Prerequisites
- [Bun](https://bun.sh/) installed locally
- A GitHub repo with Pages enabled (deploy from GitHub Actions)

### Local development
```bash
bun install
bun run build    # outputs to dist/
# serve dist/ with any static server, e.g.:
bunx serve dist
```

### GitHub setup
1. Enable GitHub Pages in repo settings → Source: "GitHub Actions"
2. Push to `main` — the deploy workflow runs automatically

### Creating a GitHub PAT
Each user needs a Personal Access Token to add players/games from the site:
1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. **Token name**: anything (e.g. "artichello")
3. **Expiration**: your choice (or no expiration)
4. **Repository access**: "Only select repositories" → select `artichello`
5. **Permissions**: under Repository permissions, set **Contents** to **Read and write**
6. Generate and copy the token
7. Paste it into the site's login screen — it's saved in the browser's localStorage

### Elo system
Players start at **1000 Elo**. After each game, ratings update based on expected vs actual goals scored (K=32, logistic curve with scale factor 1/400):

1. Compute each team's average Elo
2. For each team, calculate expected goals: `E = totalGoals × 1/(1 + 10^((eloThem - eloUs)/400))`
3. Each player's Elo changes by `K × (actualGoals - expectedGoals) / teamSize`

This means a team scores Elo points when they score more goals than expected given the rating gap, and the update is split evenly among teammates.

## Project structure
```
.github/workflows/
  deploy.yml         — builds and deploys to GitHub Pages on push
  update-data.yml    — handles repository_dispatch events to update data
src/
  index.html         — single-page app markup
  style.css          — styles
  main.ts            — UI logic, GitHub API integration
  elo.ts             — Elo computation from game history
data/
  players.json       — player list (committed by Actions)
  games.json         — game log (committed by Actions)
build.ts             — build script (Bun bundler + file copy)
```
