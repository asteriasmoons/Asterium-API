import test from "node:test";
import assert from "node:assert/strict";
import { buildChallengeFeedBackfill, challengeCatalogFromSwift } from "../scripts/backfill-challenge-feed-context.mjs";

const catalog = [{ title: "First Chapter", description: "Read a first chapter." }];
const post = { _id: "post", userID: "reader", linkedBookID: "BOOK-ID", mood: "Magical", text: "Original post", isDeleted: false };
const item = { _id: "item", postID: "post", userID: "reader", feedType: "post", text: "Original post", likeCount: 12, commentCount: 5 };
const submission = { _id: "submission", userID: "reader", challengeID: "local-challenge", linkedBookIDs: ["BOOK-ID"],
  proofSummary: "An Actual Book by Actual Author", validationStatus: "approved", approvedDate: "2026-11-25" };
const approved = { _id: "approved", submissionID: "submission", feedType: "submission", userID: "reader",
  challengeID: "local-challenge", challengeTitle: "First Chapter", likeCount: 7, commentCount: 2 };
const fixture = changes => ({ items: [item, approved], posts: [post], submissions: [submission], catalog, ...changes });

test("challenge metadata is read from both actual seed constructor formats without running Swift", () => {
  const source = 'ReadingChallenge(title: "First Chapter", challengeDescription: "Read a first chapter.", points: 25)\n'
    + 'photoProofChallenge(title: "Book Photo", challengeDescription: "Show the book.", points: 50)\n'
    + 'ReadingChallenge(title: variable, challengeDescription: variable)';
  assert.deepEqual(challengeCatalogFromSwift(source), [...catalog, { title: "Book Photo", description: "Show the book." }]);
  assert.throws(() => challengeCatalogFromSwift('ReadingChallenge(title: "Missing Description")'));
});

test("existing post moods, verified book proof and approved challenge descriptions are all backfilled", () => {
  const result = buildChallengeFeedBackfill(fixture());
  assert.deepEqual(result.unresolved, []);
  const feed = result.plan.find(entry => entry.collection === "challengefeeditems" && entry.id === "item");
  assert.equal(feed.fields.mood, "Magical");
  assert.equal(feed.fields.linkedBookTitle, "An Actual Book");
  const approval = result.plan.find(entry => entry.collection === "challengefeeditems" && entry.id === "approved");
  assert.equal(approval.fields.challengeDescription, "Read a first chapter.");
  assert.equal(approval.fields.linkedBookTitle, "An Actual Book");
  assert.equal(approval.fields.challengeTitle, undefined, "existing title is not overwritten");
});

test("backfill plans do not edit post text, reactions, timestamps, approval states or rewards", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const result = buildChallengeFeedBackfill(input);
  assert.equal(JSON.stringify(input), before, "planning never mutates source records");
  const protectedFields = ["text", "likeCount", "commentCount", "approvedDate", "createdDate", "validationStatus", "pointsAwarded", "feedItemID", "postedToFeed"];
  for (const entry of result.plan) for (const field of protectedFields) assert.equal(field in entry.fields, false);
});

test("applying the missing metadata makes subsequent backfills no-ops", () => {
  const input = structuredClone(fixture());
  const result = buildChallengeFeedBackfill(input);
  const collections = { challengefeeditems: input.items, challengeposts: input.posts, challengesubmissions: input.submissions };
  for (const entry of result.plan) Object.assign(collections[entry.collection].find(doc => doc._id === entry.id), entry.fields);
  assert.deepEqual(buildChallengeFeedBackfill(input).plan, []);
});

test("missing or ambiguous book metadata is reported instead of guessed", () => {
  const unknown = buildChallengeFeedBackfill(fixture({ submissions: [{ ...submission, linkedBookIDs: ["BOOK-ID", "OTHER-BOOK"] }] }));
  assert.ok(unknown.unresolved.some(entry => entry.id === "item" && entry.field === "linkedBookTitle"));
  assert.ok(!unknown.plan.some(entry => entry.collection === "challengeposts" && entry.fields.linkedBookTitle));
});

test("an explicitly verified book title repairs the linked post without changing its existing metadata", () => {
  const result = buildChallengeFeedBackfill(fixture({ submissions: [],
    bookOverrides: [{ postID: "post", title: "Verified Title" }] }));
  assert.equal(result.plan.find(entry => entry.collection === "challengeposts").fields.linkedBookTitle, "Verified Title");
  assert.throws(() => buildChallengeFeedBackfill(fixture({ bookOverrides: [{ postID: "missing", title: "Wrong" }] })));
});

test("book snapshots are scoped to the author and do not use another reader's library IDs", () => {
  const result = buildChallengeFeedBackfill(fixture({ posts: [post, { ...post, _id: "other", userID: "other-reader", linkedBookTitle: "Someone Else's Book" }], submissions: [] }));
  assert.ok(result.unresolved.some(entry => entry.id === "item" && entry.field === "linkedBookTitle"));
});

test("unknown challenge descriptions remain unresolved and existing complete snapshots are preserved", () => {
  const result = buildChallengeFeedBackfill(fixture({ catalog: [], items: [{ ...approved, challengeDescription: "Stored description" }] }));
  assert.ok(!result.plan.some(entry => entry.collection === "challengefeeditems" && entry.fields.challengeDescription));
  assert.deepEqual(result.unresolved.filter(entry => entry.field === "challengeDescription"), []);
});

test("different challenges with the same title do not get an arbitrary description", () => {
  const result = buildChallengeFeedBackfill(fixture({ catalog: [...catalog, { title: "First Chapter", description: "A different challenge." }] }));
  assert.ok(result.unresolved.some(entry => entry.id === "approved" && entry.field === "challengeDescription"));
});

test("session-only approvals recover a real book title without inventing a library book ID", () => {
  const result = buildChallengeFeedBackfill(fixture({ posts: [], items: [approved],
    submissions: [{ ...submission, linkedBookIDs: [], linkedSessionIDs: ["session"], proofSummary: "A Session Book \u2022 30 min \u2022 58 pages" }] }));
  const feed = result.plan.find(entry => entry.collection === "challengefeeditems");
  assert.equal(feed.fields.linkedBookTitle, "A Session Book");
  assert.equal(feed.fields.linkedBookID, undefined);
});
