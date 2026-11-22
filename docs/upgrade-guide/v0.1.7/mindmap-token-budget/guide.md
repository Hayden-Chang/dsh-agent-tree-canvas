---
kind: upgrade-guide
description: "Session canvas 0.1.8 replaces maxOutputTokens with maxMindmapOutputTokens for mind-map requests."
---

# Separate mind-map output budgets

English | [中文](guide.zh.md)

## Change

When upgrading the independent Session canvas plugin from 0.1.7 to 0.1.8, `maxOutputTokens` continues to control summaries but no longer controls mind maps. Mind maps use `maxMindmapOutputTokens`, defaulting to 16384 tokens per request, including reasoning where the provider counts it. Generation and source review normally make one request each. `mindmapAttempts` defaults to 2 attempts per stage for invalid or token-truncated output; transport errors and cancellation are not retried by the plugin.

## Migration

1. If you previously customized `maxOutputTokens` to limit mind maps, add `maxMindmapOutputTokens` with that value to the `session-canvas` entry's `config` in your Web profile overlay (`$DSH_HOME/profiles/web/cordis.patch.yml`). Leave `maxOutputTokens` at the desired summary limit. Set `mindmapAttempts: 1` there if you require no automatic output retry. Default installations need no configuration edit.
2. Restart `dsh web` after installing the 0.1.8 plugin archive. DSH itself remains at 0.2.2-rc.1; existing canvas and Session data need no migration.
3. Generate a mind map and inspect its logged `plugin:session-canvas/mindmap-request` records. `config.maxTokens` must equal the configured mind-map limit. Every completed attempt has a `plugin:session-canvas/mindmap-response` record with its stage and attempt number.
