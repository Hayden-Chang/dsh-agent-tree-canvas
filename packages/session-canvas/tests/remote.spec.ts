/** The installed Gateway receives the complete, validated Remote surface. */
import { expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/remote.ts'

it('exposes all canvas methods and marks only generation as cancellable', () => {
  expect(Object.keys(TYPERT_REMOTE.methods).sort()).toEqual([
    'addRoot', 'arrange', 'create', 'excerpt', 'fork', 'generate', 'list', 'mindmap', 'removeNode', 'rename',
    'resolveDraft', 'restore', 'saveSummary', 'setMode', 'summary', 'updateNode',
  ].map(name => `sessionCanvas/${name}`).sort())
  expect(TYPERT_REMOTE.descriptors.filter(item => item.cancellation).map(item => item.method)).toEqual(['mindmap', 'generate'])
})

it('rejects invalid wire input and invalid results before exposing them to consumers', () => {
  const save = TYPERT_REMOTE.methods['sessionCanvas/saveSummary']!
  expect(save.input().create().parse({ request: { sessionId: 'session', revision: 3, markdown: 'edited' } }))
    .toEqual({ request: { sessionId: 'session', revision: 3, markdown: 'edited' } })
  expect(() => save.input().create().parse({ request: { sessionId: 'session', revision: '3', markdown: 'edited' } })).toThrow()
  expect(() => save.input({ strict: true }).create().parse({ request: { sessionId: 'session', revision: 3, markdown: 'edited', extra: true } })).toThrow()
  expect(() => save.result.create().parse({ markdown: 'incomplete' })).toThrow()
  expect(() => TYPERT_REMOTE.methods['sessionCanvas/setMode']!.input().create().parse({ canvasId: 'canvas', mode: 'invalid' })).toThrow()
})

it('validates explicit no-subdivision results instead of treating them as failures', () => {
  const result = TYPERT_REMOTE.methods['sessionCanvas/mindmap']!.result.create()
  const canvas = { id: 'map', title: 'Map', revision: 0, nodes: [] }
  expect(result.parse({ canvas, createdSessionIds: [] })).toEqual({ canvas, createdSessionIds: [] })
  expect(() => result.parse(canvas)).toThrow()
  expect(() => result.parse({ canvas, createdSessionIds: [1] })).toThrow()
})
