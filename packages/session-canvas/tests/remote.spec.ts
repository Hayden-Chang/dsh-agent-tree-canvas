/** The installed Gateway receives the complete, validated Remote surface. */
import { expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/remote.ts'
import { canvasSchema } from '../src/schema.ts'

it('defaults legacy nodes to unfinished and validates learning progress on storage and wire boundaries', () => {
  const legacy = { id: 'canvas', title: 'Legacy', revision: 1, nodes: [
    { sessionId: 'root', parentId: null, forkSeq: null, title: 'Root', x: 0, y: 0, mode: 'chat', collapsed: false },
  ] }
  const update = TYPERT_REMOTE.methods['sessionCanvas/updateNode']!
  for (const schema of [canvasSchema, update.result.create()]) {
    expect(schema.parse(legacy)).toMatchObject({ nodes: [{ learned: false }] })
    expect(schema.parse({ ...legacy, nodes: [{ ...legacy.nodes[0], learned: true }] })).toMatchObject({ nodes: [{ learned: true }] })
    expect(() => schema.parse({ ...legacy, nodes: [{ ...legacy.nodes[0], learned: 'yes' }] })).toThrow()
  }
  for (const learned of [true, false]) {
    const request = { canvasId: 'canvas', sessionId: 'root', learned }
    expect(update.input({ strict: true }).create().parse({ request })).toEqual({ request })
  }
  expect(() => update.input().create().parse({ request: { canvasId: 'canvas', sessionId: 'root', learned: 1 } })).toThrow()
})

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

it('accepts legacy forks and validates durable chat and summary quote origins on the wire', () => {
  const fork = TYPERT_REMOTE.methods['sessionCanvas/fork']!
  const request = { canvasId: 'canvas', sessionId: 'parent', atSeq: null, title: 'Child' }
  expect(fork.input().create().parse(request)).toEqual(request)
  for (const source of [{ sessionId: 'parent', seq: 6, turn: 1, offset: 4 }, { kind: 'summary', sessionId: 'parent', offset: 12 }]) {
    const origin = { text: 'Quoted text', source }
    expect(fork.input().create().parse({ ...request, origin })).toEqual({ ...request, origin })
    const node = { sessionId: 'child', parentId: 'parent', forkSeq: null, title: 'Child', x: 0, y: 0, collapsed: false, mode: 'chat', origin }
    expect(fork.result.create().parse({ id: 'canvas', title: 'Canvas', revision: 1, nodes: [node] })).toMatchObject({ nodes: [{ origin }] })
    expect(() => fork.input().create().parse({ ...request, origin: { ...origin, source: { ...source, offset: -1 } } })).toThrow()
    expect(() => fork.input().create().parse({ ...request, origin: { ...origin, text: '' } })).toThrow()
  }
})
