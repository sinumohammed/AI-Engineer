# Sample Company Doc

This is a placeholder document for testing the Phase 5 RAG pipeline.

Our internal deployment process: every merge to main triggers a CI build,
then a manual approval step before it goes to production. Rollbacks are
done by re-deploying the previous tagged release, not by reverting commits.

The on-call rotation is weekly, handed off every Monday at 10am.
