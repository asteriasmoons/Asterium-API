# Challenge Feed Context

Feed items retain mood, linkedBookID, linkedBookTitle, challengeTitle and challengeDescription. Posts additionally retain linkedBookTitle, linkedChallengeTitle and linkedChallengeDescription. Submissions retain challengeTitle, challengeDescription and linkedBookTitle.

The existing create-post request accepts those snapshots from Loomey's selected library book/challenge. Submission creation and approval accept challenge/title/description and book-title context. Approval copies context to its feed item; an already-posted approval fills missing context instead of creating a second post. GET /api/lumey/challenges/feed also joins context from the original post/submission records when needed.

Existing endpoints, authentication behavior, text/photos, reactions and reward logic are preserved. No additional package, credential, database or background worker is required.

## Existing Data Repair

The completed database repair filled 43 missing metadata fields across 19 existing records for 10 feed items. A subsequent read-only plan reported zero remaining changes and zero unresolved metadata.

The repair reads verified title/description literals from the existing Swift challenge catalog; it does not run Swift or the application. Single-book and session-proof formats provide recoverable book titles. A linked post's explicitly verified book title can be supplied separately. Missing or ambiguous metadata is reported instead of invented.

Preview without writing:

    node scripts/backfill-challenge-feed-context.mjs --challenge-seeds /path/to/Lumey/Data/ChallengeSeedData.swift

Apply an inspected plan:

    node scripts/backfill-challenge-feed-context.mjs --challenge-seeds /path/to/Lumey/Data/ChallengeSeedData.swift --apply

A verified legacy title can be supplied as --book-title 'postID=Verified Book Title'. Do not use an unverified guess. The script requires the existing MONGODB_URI and uses the existing lumey database. It saves a private metadata preimage backup before conditional missing-field-only updates. It does not recreate posts, reapprove submissions, change rewards, rewrite text/photos or alter reaction counts.

## Verification And Release

Ten isolated JavaScript repair tests passed, including repeatability and protected-field preservation. The requested existing-data repair was actually applied and followed by a read-only check.

The application and TypeScript service were not compiled or launched. UI gestures/navigation, current deployed endpoint behavior and the new request flow have not been tested live. No SSH/device tests or deployment were performed.

Release the updated backend source when authorized so future posts/approvals retain their metadata. Existing-record metadata has already been backfilled.
