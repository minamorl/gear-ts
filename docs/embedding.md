# Embedding Gear in shadow mode

Start with `createShadowGear({ journalPath })` alongside the host's existing effect
path. The host continues to execute shell, HTTP, database, and Discord effects. After
each result is observed, pass the effect description and result to `record`. Gear only
appends a chained receipt to the NDJSON Journal; it does not admit or execute the effect.
The receipt grounds explicitly mark the observation as shadow traffic and
`executedByGear: false`.

`count()` folds the Journal so the host can report how many turns have been journaled
via Gear, including records already present after a restart.

Before cutover, compare the shadow Journal with host outcomes and verify coverage,
ordering, result serialization, and receipt chains. Cut over one effect kind at a time:
route that kind through Gear's Admission, Executor, and Port while retaining shadow
recording for the remaining kinds. Remove the shadow path only after every kind executes
through Gear and operational rollback has been exercised.
