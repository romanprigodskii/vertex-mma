import { spawn } from "node:child_process";

const INTERVAL_MS = Number(
  process.env.NEWS_WATCH_INTERVAL_MS ?? 60 * 60 * 1000,
);

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`[${ts()}] news:ingest start`);
    const child = spawn("pnpm", ["news:ingest"], { stdio: "inherit" });
    child.on("close", (code) => {
      console.log(`[${ts()}] news:ingest exit ${code ?? "?"}`);
      resolve();
    });
    child.on("error", (err) => {
      console.error(`[${ts()}] news:ingest spawn error`, err);
      resolve();
    });
  });
}

async function main() {
  const human = `${Math.round(INTERVAL_MS / 60_000)} min`;
  console.log(
    `news:watch — running pnpm news:ingest every ${human}. ctrl-C to stop.`,
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
