import { cpSync, mkdirSync } from "fs";

mkdirSync("dist/data", { recursive: true });

await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  minify: true,
});

cpSync("src/index.html", "dist/index.html");
cpSync("src/style.css", "dist/style.css");
cpSync("data/players.json", "dist/data/players.json");
cpSync("data/games.json", "dist/data/games.json");
