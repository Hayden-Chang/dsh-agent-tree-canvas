---
kind: upgrade-guide
description: Mind-map generation returns explicit created identities and can succeed without creating nodes.
---
# Mind-map generation results

## Change

Session canvas 0.1.6 changes `sessionCanvas.mindmap` from a canvas document to `{ canvas, createdSessionIds }`. An empty list means the selected text needs no useful subdivision. Model outlines accept zero or multiple depth-zero nodes, and exact repeated ancestor or sibling topics are rejected before Session creation.

## Migration

1. Install the 0.1.6 plugin archive into the same stock DSH profile, restart DSH and refresh browser tabs so Host and Client use the same protocol.
2. External callers read the document from `result.canvas`. Treat an empty `result.createdSessionIds` as success without navigation or layout changes.
3. Existing Sessions, summaries and generated trees need no migration and are not regenerated automatically. Verify a concise selection shows the no-subdivision message and a structured selection creates children.
