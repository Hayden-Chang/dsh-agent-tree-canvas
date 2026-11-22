/** Wire validation shared by the independently built Host and browser bundle. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'
import type { CanvasDocument, MindmapResult, SummaryDocument } from './types.ts'
export type { SessionCanvasRemote } from './remote-types.ts'

const id = z.string()
const mode = z.enum(['chat', 'summary'])
const node = z.object({ sessionId: id, parentId: id.nullable(), forkSeq: z.number().nullable(),
  title: z.string(), x: z.number(), y: z.number(), collapsed: z.boolean(), mode })
const canvas = z.object({ id, title: z.string(), nodes: z.array(node), revision: z.number() })
const summary = z.object({ version: z.number(), sessionId: id, markdown: z.string(), revision: z.number(),
  versions: z.array(z.object({ revision: z.number(), markdown: z.string(), kind: z.enum(['edit', 'excerpt', 'generated', 'restore']), time: z.number() })),
  excerpts: z.array(z.object({ revision: z.number(), text: z.string(), turn: z.number().nullable(), time: z.number() })),
  draft: z.object({ markdown: z.string(), baseRevision: z.number(), throughSeq: z.number() }).nullable(),
})

/** Output structures are checked against the public records; ids are branded after wire parsing. */
type Wire<T> = T extends string ? string : T extends readonly (infer Item)[] ? Wire<Item>[]
  : T extends object ? { [Key in keyof T]: Wire<T[Key]> } : T
const checkedCanvas: z.ZodType<Wire<CanvasDocument>> = canvas
const mindmapResult = z.object({ canvas, createdSessionIds: z.array(id) })
const checkedMindmap: z.ZodType<Wire<MindmapResult>> = mindmapResult
void checkedMindmap
const checkedSummary: z.ZodType<Wire<SummaryDocument>> = summary
void checkedCanvas; void checkedSummary

function codec(schema: z.ZodType, typeSymbol: string) {
  return { mode: 'strict' as const, typeSymbol, create: () => schema, jsonSchema: z.toJSONSchema(schema) }
}

function method(description: string, parameters: readonly (readonly [string, z.ZodType])[], result: z.ZodType,
  cancellation = false): TypertRemoteMethodSpec {
  return { service: 'sessionCanvas', description, invocation: { kind: 'direct' },
    parameters: parameters.map(([name, schema]) => ({ name, source: 'json' as const,
      codec: codec(schema, name), strictCodec: codec(schema instanceof z.ZodObject ? schema.strict() : schema, name) })),
    result: codec(result, description),
    ...cancellation ? { cancellation: { parameter: 'signal' } } : {},
  }
}

/** The stock Gateway validates every input and result using this plugin's own schemas. */
export const TYPERT_REMOTE = createTypertRemoteInfo({ package: '@deepseek-ai/dsh-session-canvas', methods: {
  'sessionCanvas/list': method('List canvases', [], z.array(canvas)),
  'sessionCanvas/create': method('Create canvas', [['title', z.string()]], canvas),
  'sessionCanvas/rename': method('Rename canvas', [['canvasId', id], ['title', z.string()]], canvas),
  'sessionCanvas/addRoot': method('Add conversation', [['canvasId', id], ['title', z.string()]], canvas),
  'sessionCanvas/fork': method('Fork conversation', [['canvasId', id], ['sessionId', id], ['atSeq', z.number().nullable()], ['title', z.string()]], canvas),
  'sessionCanvas/mindmap': method('Generate mind map', [['canvasId', id], ['sessionId', id], ['atSeq', z.number().int().nonnegative().nullable()], ['text', z.string().min(1)]], mindmapResult, true),
  'sessionCanvas/removeNode': method('Permanently delete subtree and its data', [['canvasId', id], ['sessionId', id]], canvas),
  'sessionCanvas/updateNode': method('Update node', [['request', z.object({ canvasId: id, sessionId: id,
    title: z.string().optional(), collapsed: z.boolean().optional(), mode: mode.optional() })]], canvas),
  'sessionCanvas/arrange': method('Arrange nodes', [['canvasId', id], ['placements', z.array(z.object({ sessionId: id, x: z.number(), y: z.number() }))]], canvas),
  'sessionCanvas/setMode': method('Set view', [['canvasId', id], ['mode', mode]], canvas),
  'sessionCanvas/summary': method('Read summary', [['sessionId', id]], summary),
  'sessionCanvas/saveSummary': method('Save summary', [['request', z.object({ sessionId: id, revision: z.number(), markdown: z.string() })]], summary),
  'sessionCanvas/excerpt': method('Append excerpt', [['sessionId', id], ['text', z.string()], ['turn', z.number().nullable()]], summary),
  'sessionCanvas/generate': method('Generate summary', [['sessionId', id]], summary, true),
  'sessionCanvas/resolveDraft': method('Resolve summary candidate', [['sessionId', id], ['version', z.number()], ['adopt', z.boolean()]], summary),
  'sessionCanvas/restore': method('Restore summary', [['sessionId', id], ['revision', z.number()], ['restoreRevision', z.number()]], summary),
} }, z)

export default TYPERT_REMOTE
