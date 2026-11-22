---
kind: upgrade-guide
description: Deleting a canvas node now permanently erases its subtree data.
---
# Permanent subtree deletion

## Change

Session canvas 0.1.5 changes the node delete action and `sessionCanvas.removeNode`: they permanently delete the selected Session and every descendant, including conversation history, inherited and generated context, summaries, versions, excerpts, and drafts. Previous releases only removed nodes from the canvas. Confirmation now explicitly says deletion cannot be undone. Previously detached Sessions are not retroactively deleted.

## Migration

1. Install the 0.1.5 plugin archive into the existing profile and restart DSH with the same `DSH_HOME`. The plugin takes ownership of canvas Agent lifecycles at startup.
2. Refresh open browser tabs. Export notes you want to retain before using **Delete permanently**. The action supports the stock JSONL provider in DSH 0.2.2-rc.1 and does not modify DSH source.
3. Update callers of `sessionCanvas.removeNode` to obtain irreversible-deletion consent. If deletion is incomplete, retry or restart DSH to finish the durable cleanup job. Retries do not restore already deleted data.

After deletion, the subtree disappears from the canvas and Session listing; its history and summaries remain unavailable after reload. Disabling the plugin alone still preserves data.
