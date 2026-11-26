import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const text = value => typeof value === "string" ? value.trim() : "";
const key = value => text(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const first = (...values) => values.map(text).find(Boolean) || "";
const bookKey = (userID, bookID) => JSON.stringify([text(userID), key(bookID)]);

export function challengeCatalogFromSwift(source) {
  const literal = '"(?:\\\\.|[^"\\\\])*"';
  const entries = [...source.matchAll(new RegExp(
    '(?:ReadingChallenge|photoProofChallenge)\\(\\s*title:\\s*(' + literal + '),\\s*challengeDescription:\\s*(' + literal + ')', "g"
  ))].map(match => ({ title: JSON.parse(match[1]), description: JSON.parse(match[2]) }));
  const expected = [...source.matchAll(/(?:ReadingChallenge|photoProofChallenge)\(\s*title:\s*"/g)].length;
  if (!entries.length || entries.length !== expected) throw new Error("Challenge catalog literals could not be read completely.");
  return entries;
}

function proofBookTitle(submission) {
  const firstLine = text(submission.proofSummary).split("\n").find(line => text(line));
  if (!firstLine) return "";
  if (!submission.linkedBookIDs?.length && submission.linkedSessionIDs?.length) {
    const session = /^(.+) \u2022 \d+ min \u2022 \d+ pages$/.exec(firstLine);
    return session && session[1] !== "Reading Session" ? text(session[1]) : "";
  }
  if (!submission.linkedBookIDs?.length) return "";
  // Recover display titles only from the explicit, app-generated "title by author" proof format.
  const parts = firstLine.split(" by ");
  return parts.length === 2 && text(parts[1]) ? text(parts[0]) : "";
}

export function buildChallengeFeedBackfill({ items, posts, submissions, catalog, bookOverrides = [] }) {
  const postByID = new Map(posts.filter(post => !post.isDeleted).map(post => [String(post._id), post]));
  const submissionByID = new Map(submissions.map(submission => [String(submission._id), submission]));
  const challenges = new Map();
  for (const challenge of catalog) {
    const identity = key(challenge.title);
    const previous = challenges.get(identity);
    challenges.set(identity, previous === null || previous && previous.description !== challenge.description ? null : challenge);
  }
  const titlesByChallenge = new Map();
  const bookTitles = new Map();
  const rememberChallenge = (id, title) => {
    if (text(id) && text(title) && !titlesByChallenge.has(key(id))) titlesByChallenge.set(key(id), text(title));
  };
  const rememberBook = (userID, id, title) => {
    if (!text(id) || !text(title)) return;
    const identity = bookKey(userID, id);
    const previous = bookTitles.get(identity);
    if (previous === undefined) bookTitles.set(identity, text(title));
    else if (previous !== null && key(previous) !== key(title)) bookTitles.set(identity, null);
  };
  for (const item of items) {
    rememberChallenge(item.challengeID, item.challengeTitle);
    rememberBook(item.userID, item.linkedBookID, item.linkedBookTitle);
  }
  for (const post of posts) {
    rememberChallenge(post.linkedChallengeID, post.linkedChallengeTitle);
    rememberBook(post.userID, post.linkedBookID, post.linkedBookTitle);
  }
  for (const submission of submissions) {
    rememberChallenge(submission.challengeID, submission.challengeTitle);
    if (submission.linkedBookIDs?.length === 1) {
      rememberBook(submission.userID, submission.linkedBookIDs[0], first(submission.linkedBookTitle, proofBookTitle(submission)));
    }
  }
  for (const override of bookOverrides) {
    const post = postByID.get(override.postID);
    if (!post || !text(post.linkedBookID) || !text(override.title)) throw new Error("A book override must identify an existing linked-book post and its verified title.");
    bookTitles.set(bookKey(post.userID, post.linkedBookID), text(override.title));
  }
  const challengeContext = (id, ...titles) => {
    const title = first(...titles, titlesByChallenge.get(key(id)));
    return { title, description: challenges.get(key(title))?.description || "" };
  };
  const plan = [];
  const append = (collection, document, candidates) => {
    const fields = Object.fromEntries(Object.entries(candidates).filter(([field, value]) => !text(document[field]) && text(value)));
    if (Object.keys(fields).length) plan.push({ collection, id: document._id, fields });
    return { ...document, ...fields };
  };
  const completedPosts = new Map();
  for (const post of postByID.values()) {
    const challenge = challengeContext(post.linkedChallengeID, post.linkedChallengeTitle);
    const completed = append("challengeposts", post, {
      linkedBookTitle: bookTitles.get(bookKey(post.userID, post.linkedBookID)),
      linkedChallengeTitle: challenge.title,
      linkedChallengeDescription: challenge.description,
    });
    completedPosts.set(String(post._id), completed);
  }
  const completedSubmissions = new Map();
  for (const submission of submissions) {
    const challenge = challengeContext(submission.challengeID, submission.challengeTitle);
    const completed = append("challengesubmissions", submission, {
      challengeTitle: challenge.title,
      challengeDescription: challenge.description,
      linkedBookTitle: first(submission.linkedBookIDs?.length === 1
        ? bookTitles.get(bookKey(submission.userID, submission.linkedBookIDs[0])) : "", proofBookTitle(submission)),
    });
    completedSubmissions.set(String(submission._id), completed);
  }
  const unresolved = [];
  for (const item of items) {
    const post = completedPosts.get(String(item.postID));
    const submission = completedSubmissions.get(String(item.submissionID));
    const challengeID = first(item.challengeID, post?.linkedChallengeID, submission?.challengeID);
    const challenge = challengeContext(challengeID, item.challengeTitle, post?.linkedChallengeTitle, submission?.challengeTitle);
    const completed = append("challengefeeditems", item, {
      mood: post?.mood,
      linkedBookID: first(post?.linkedBookID, submission?.linkedBookIDs?.[0]),
      linkedBookTitle: first(post?.linkedBookTitle, submission?.linkedBookTitle),
      challengeID,
      challengeTitle: challenge.title,
      challengeDescription: first(post?.linkedChallengeDescription, submission?.challengeDescription, challenge.description),
    });
    if (text(completed.linkedBookID) && !text(completed.linkedBookTitle)) unresolved.push({ id: String(item._id), field: "linkedBookTitle" });
    if (challengeID && !text(completed.challengeDescription)) unresolved.push({ id: String(item._id), field: "challengeDescription" });
  }
  return { plan, unresolved };
}

async function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--challenge-seeds");
  if (sourceIndex < 0 || !args[sourceIndex + 1]) throw new Error("Provide --challenge-seeds /path/to/ChallengeSeedData.swift.");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  const catalog = challengeCatalogFromSwift(await readFile(args[sourceIndex + 1], "utf8"));
  const bookOverrides = [];
  for (let index = 0; index < args.length; index++) if (args[index] === "--book-title") {
    const value = args[index + 1] || "";
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error("Use --book-title postID=Verified Book Title.");
    bookOverrides.push({ postID: value.slice(0, separator), title: value.slice(separator + 1) });
  }
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db("lumey");
    const projection = { _id: 1, userID: 1, feedType: 1, postID: 1, submissionID: 1, mood: 1,
      linkedBookID: 1, linkedBookTitle: 1, linkedBookIDs: 1, linkedSessionIDs: 1, challengeID: 1, challengeTitle: 1,
      challengeDescription: 1, linkedChallengeID: 1, linkedChallengeTitle: 1,
      linkedChallengeDescription: 1, proofSummary: 1, isDeleted: 1 };
    const [items, posts, submissions] = await Promise.all([
      db.collection("challengefeeditems").find({}, { projection }).toArray(),
      db.collection("challengeposts").find({ isDeleted: { $ne: true } }, { projection }).toArray(),
      db.collection("challengesubmissions").find({}, { projection }).toArray(),
    ]);
    const { plan, unresolved } = buildChallengeFeedBackfill({ items, posts, submissions, catalog, bookOverrides });
    const summary = { apply: args.includes("--apply"), challengeDefinitions: catalog.length, feedItems: items.length,
      recordsToFill: plan.length, fieldsToFill: plan.reduce((sum, entry) => sum + Object.keys(entry.fields).length, 0),
      unresolved, changedFields: 0 };
    if (summary.apply && plan.length) {
      const before = new Map([
        ...items.map(document => ["challengefeeditems:" + document._id, document]),
        ...posts.map(document => ["challengeposts:" + document._id, document]),
        ...submissions.map(document => ["challengesubmissions:" + document._id, document]),
      ]);
      const backupPath = resolve(tmpdir(), "loomey-challenge-context-" + randomUUID() + ".json");
      await writeFile(backupPath, JSON.stringify(plan.map(entry => ({
        collection: entry.collection, id: String(entry.id),
        fields: Object.fromEntries(Object.keys(entry.fields).map(field => [field, {
          present: Object.hasOwn(before.get(entry.collection + ":" + entry.id), field),
          value: before.get(entry.collection + ":" + entry.id)[field] ?? null,
        }])),
      })), null, 2), { mode: 0o600, flag: "wx" });
      summary.backupPath = backupPath;
      for (const collection of ["challengeposts", "challengesubmissions", "challengefeeditems"]) {
        const operations = plan.filter(entry => entry.collection === collection).flatMap(entry =>
          Object.entries(entry.fields).map(([field, value]) => ({ updateOne: {
            filter: { _id: entry.id, $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: "" }, { [field]: { $regex: /^\s*$/ } }] },
            update: { $set: { [field]: value } },
          } }))
        );
        if (operations.length) {
          const result = await db.collection(collection).bulkWrite(operations, { ordered: true });
          summary.changedFields += result.modifiedCount;
        }
      }
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
