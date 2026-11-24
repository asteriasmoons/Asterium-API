import "dotenv/config";
import mongoose from "mongoose";
import { bookPool } from "./db";
import {
  recoverInterruptedJobs,
  seedKnowledge,
  runKnowledgeWorker,
} from "./index";

const RUN_LIMIT_MS = 5 * 60 * 1000;
const TIME_ZONE = "America/Chicago";
const FIRST_RUN_DAY = Date.UTC(2026, 9, 24) / 86_400_000;

// Railway cron uses UTC; this check honors Tuesday at 11:15 AM Central
// regardless of daylight saving time. Railway's cron must cover both UTC hours.
function isScheduledRun(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  return (
    value("weekday") === "Tue" &&
    value("hour") === "11" &&
    value("minute") === "15"
  );
}

async function main(): Promise<void> {
  if (process.env.BOOK_KNOWLEDGE_RUN_NOW !== "true" && !isScheduledRun()) {
    console.log(
      "[bookKnowledge] Skipping: outside the Tuesday 11:15 AM Central schedule",
    );
    return;
  }
  if (process.env.BOOK_KNOWLEDGE_ENABLED !== "true") {
    throw new Error(
      "BOOK_KNOWLEDGE_ENABLED must be true for the knowledge worker",
    );
  }

  const deadline = AbortSignal.timeout(RUN_LIMIT_MS);
  // Last-resort guard: a hung database operation must not leave a cron
  // execution running indefinitely after the normal cancellation deadline.
  const shutdownGuard = setTimeout(() => {
    console.warn(
      "[bookKnowledge] Shutdown grace period expired; ending timed run",
    );
    process.exit(0);
  }, RUN_LIMIT_MS + 15_000);
  shutdownGuard.unref();
  if (!process.env.MONGODB_URI)
    throw new Error(
      "MONGODB_URI is required for provider cache and rate limits",
    );
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("[bookKnowledge] MongoDB connected");
  try {
    deadline.throwIfAborted();
    await recoverInterruptedJobs();
    deadline.throwIfAborted();
    // Rotate discovery topics across runs so the five-minute worker grows beyond
    // a fixed handful of genres. Include nonfiction and contemporary interests.
    const topics = [
      "fantasy",
      "mystery",
      "historical fiction",
      "science fiction",
      "romance",
      "literary fiction",
      "horror",
      "thriller",
      "contemporary fiction",
      "magical realism",
      "biography",
      "memoir",
      "history",
      "psychology",
      "science",
      "technology",
      "witchcraft",
      "folklore",
      "philosophy",
      "self improvement",
      "art",
      "nature",
      "true crime",
      "health",
      "business",
      "poetry",
      "graphic novels",
      "young adult",
    ];
    const runIndex = Math.floor((Date.now() / 86_400_000 - FIRST_RUN_DAY) / 7);
    const rotated = Array.from(
      { length: 10 },
      (_, index) => topics[(runIndex * 10 + index) % topics.length]!,
    );
    await seedKnowledge(rotated);
    console.log(
      "[bookKnowledge] Discovery run started (5-minute maximum; manual override:",
      process.env.BOOK_KNOWLEDGE_RUN_NOW === "true",
      ")",
    );
    try {
      await runKnowledgeWorker(deadline);
    } catch (error) {
      // Reaching the five-minute limit is the expected end of a cron run.
      // Keep unexpected errors visible and let Railway report genuine failures.
      if (!deadline.aborted || error !== deadline.reason) throw error;
      console.log(
        "[bookKnowledge] Five-minute run limit reached; stopping successfully",
      );
    }
  } finally {
    await Promise.allSettled([bookPool.end(), mongoose.disconnect()]);
    clearTimeout(shutdownGuard);
    console.log("[bookKnowledge] Worker run finished");
  }
}

void main().catch(async (error) => {
  console.error("[bookKnowledge] Worker failed", error);
  await Promise.allSettled([bookPool.end(), mongoose.disconnect()]);
  process.exitCode = 1;
});
