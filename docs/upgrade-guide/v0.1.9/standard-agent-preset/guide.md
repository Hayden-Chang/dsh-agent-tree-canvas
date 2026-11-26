---
kind: upgrade-guide
description: "Agent tree canvas 0.1.10 uses the Web profile's standard Agent preset for canvas conversations."
---

# Use the standard Agent preset

English | [中文](guide.zh.md)

## Change

Agent tree canvas 0.1.10 creates new canvas Sessions with the Web profile's `standard` Agent preset. Sessions recorded as `agent-tree-canvas` or `session-canvas` also mount `standard` when resumed or forked. The preset supplies the conversation persona and the tools enabled by the profile. Existing Session logs are unchanged.

## Migration

1. Remove the plugin-level `persona` field from the `agent-tree-canvas` entry in the Web profile overlay. The conversation now uses the persona configured by the profile's `standard` preset; edit that preset if you need a custom instruction.
2. Keep the Web profile's `standard` preset enabled. The stock Web profile already provides it; custom compositions must declare it.
3. Install the new plugin and restart `dsh web`. Existing canvas documents and Session data need no migration.
