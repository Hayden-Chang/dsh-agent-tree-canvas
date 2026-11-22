/** Opt-in real-provider quality evidence; every request uses the production canvas service. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { BlockAssembler } from '@stock/llm'
import { launchWebScaffold } from '@stock/scaffold'
import type { WebScaffold } from '@stock/scaffold'
import type {} from '../packages/session-canvas/src/index.ts'

interface QualityCase {
  id: string
  title: string
  text: string
  terms: string[]
  empty?: boolean
  groups?: { parent?: RegExp; children: RegExp[] }[]
}
const short = '内部真实任务：从工单、日志、历史会话中采样，这是最有价值的部分'
const fusion = "核聚变：两个较轻的原子核在极高温度、压力下克服彼此的电排斥，合并成一个较重的原子核，同时把一小部分质量转化成巨大能量。太阳发光发热，就是氢核聚变成氦核。\n1. 为什么能释放能量？\n原子核由质子和中子组成，靠强核力结合。轻核聚变后，新核通常更稳定，产物的总静止质量比反应物略小。损失的质量按爱因斯坦公式\nE=mc2\n转化为能量。比如氘氚聚变：\nD+T→4He+n+17.6 MeV\n生成的氦核和中子带走大量动能，其中中子带走约 14.1 MeV。质量亏损约 0.4%，但按 E=mc2 算，能量非常巨大。\n2. 为什么需要极端条件？\n原子核都带正电，靠近时会强烈排斥。要让它们近到强核力起作用，需要：\n极高温度：约上亿摄氏度，让原子核有足够速度；\n高密度：增加碰撞概率；\n足够长的约束时间：让反应持续发生。\n这时物质变成等离子体——电子和原子核分离的带电“汤”。太阳靠巨大引力约束等离子体；地球上常用磁约束（托卡马克、仿星器）或惯性约束（激光压缩）。\n3. 和核裂变的区别\n核聚变：轻核合并，如氢变氦；不靠链式反应，燃料丰富，放射性废物相对少，但中子会活化材料。\n核裂变：重核分裂，如铀-235；已有商业核电站。\n4. 主要难点\n聚变发电难在：稳定约束上亿度等离子体、减少能量损耗、处理高能中子对材料的损伤、实现氚自持、把能量经济地转化为电力。目前已有实验实现聚变反应甚至“科学点火”，但商业聚变发电仍未实现。\n一句话总结：核聚变是把轻原子核“捏”成更稳定的核，用少量质量换取巨大能量；原理清楚，但在地球上稳定、持续、经济地实现它非常困难。"
const table = '评测指标分四类：\n| 维度 | 指标与说明 |\n| --- | --- |\n| 结果 | 任务成功率：最终状态是否满足目标；pass@k：k 次中至少一次成功；pass^k：k 次全部成功，关注稳定性 |\n| 过程 | 步数、工具调用次数、无效调用率；同样成功，20 步与 3 步不同 |\n| 成本 | token 消耗、延迟 P50/P95、外部 API 费用 |\n| 安全与合规 | 越权操作率、破坏性动作拦截率、人工介入率 |\n关键原则：结果指标不可省，过程指标不可滥。'
const cases: QualityCase[] = [
  ...[1, 2, 3].flatMap(run => [
    { id: 'fusion-' + run, title: '核聚变', text: fusion, terms: ['17.6', '14.1', '0.4', '等离子体', '托卡马克', '仿星器', '激光', '商业'], groups: [
      { parent: /条件|需求/, children: [/温度|高温/, /密度/, /时间/] },
      { parent: /难点|挑战|困难/, children: [/约束/, /损耗|损失/, /中子/, /氚/, /电/] },
      { children: [/引力/, /磁约束/, /惯性约束/] },
    ] },
    { id: 'evaluation-table-' + run, title: '评测指标', text: table, terms: ['pass@k', 'pass^k', 'P50', 'P95', '20', '3', '不可省', '不可滥'], groups: [
      { parent: /结果/, children: [/任务成功率/, /pass@k/, /pass\^k/] },
      { parent: /过程/, children: [/步数/, /工具调用次数/, /无效调用率/] },
      { parent: /成本/, children: [/token/i, /延迟/, /API/] },
      { parent: /安全|合规/, children: [/越权/, /拦截/, /人工介入/] },
    ] },
    { id: 'reported-sentence-' + run, title: short, text: short, terms: [], empty: true },
  ]),
  { id: 'compact-list', title: '资料来源', text: '资料来源包括项目文档、会议纪要和访谈记录。', terms: [], empty: true },
  { id: 'atomic-en', title: 'Retry policy', text: 'Retry transient connection failures at most three times.', terms: [], empty: true },
  { id: 'conditional-policy', title: 'Retry policy', text: 'Retry transient connection failures at most three times; do not retry authentication failures.', terms: [] },
  { id: 'procedure', title: '发布流程', text: '发布按顺序进行：第一步备份数据库，并验证备份可恢复；第二步部署新版本，先放量 5%；第三步观察错误率，若高于 1% 则回滚，否则逐步扩大流量。', terms: ['恢复', '5%', '1%', '回滚'] },
  { id: 'uneven-topics', title: '系统设计', text: '认证：接口必须校验令牌；令牌过期返回 401，权限不足返回 403。缓存：命中时直接返回结果；未命中时查询数据库并写入缓存；余额查询禁用缓存，避免返回过期余额。审计：记录操作人、时间和资源标识，不记录令牌内容。', terms: ['401', '403', '余额', '令牌'], groups: [{ parent: /认证/, children: [/401/, /403/] }] },
  { id: 'nested-material', title: '知识库系统', text: '知识库系统包含两个相互独立的子系统。\n离线建库：\n1. 文档解析。PDF 提取正文和页码，表格保留列标题，图片只记录已有说明；无法解析的文件进入人工处理队列，不能静默跳过。\n2. 切片。按章节边界划分，保留文档 ID、标题路径和页码；不要把一张表格拆开，否则列含义容易丢失。\n3. 索引。语义索引存储向量，关键词索引保留产品编号；删除文档时必须同步删除两种索引中的记录。\n在线问答：\n1. 检索。语义召回负责同义表达，关键词召回负责精确编号；合并后按文档 ID 和片段位置去重。\n2. 排序。相关性模型对候选片段重排，只把排名靠前的内容交给回答模型；候选不足时明确返回证据不足。\n3. 回答。结论附带来源页码；来源存在冲突时并列呈现，不擅自选择一方；没有证据时说明无法回答。', terms: ['人工', '列', '删除', '同义', '证据不足', '冲突'], groups: [
    { parent: /离线|建库/, children: [/解析/, /切片/, /索引/] },
    { parent: /在线|问答/, children: [/检索/, /排序/, /回答/] },
  ] },
  { id: 'placeholders', title: '方案比较', text: '方案 A：每月费用 100 元，适合个人使用。方案 B：每月费用 xxxxxx，支持团队权限。选择原则：只比较已知信息，未知费用暂不估算。', terms: ['100', '团队', '未知'] },
]
let host: WebScaffold
const output = process.env.CANVAS_REAL_OUTPUT
if (!output || process.env.DSH_SNAPSHOT !== 'record' || !process.env.DEEPSEEK_API_KEY) throw new Error('Real quality run requires DSH_SNAPSHOT=record, CANVAS_REAL_OUTPUT and DEEPSEEK_API_KEY')
beforeAll(async () => {
  await mkdir(output, { recursive: true })
  host = await launchWebScaffold({ profile: { packages: [{ dir: process.env.CANVAS_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/session-canvas', import.meta.url)), enabled: true }] }, compareReplaySession: false })
}, 120_000)
afterAll(async () => { await host?.close() }, 120_000)

it.each(cases)('real quality: $id', async (sample) => {
  const captures: object[] = []
  const off = host.ctx.on('llm/stream', async function* (options, next) {
    const assembler = new BlockAssembler()
    for await (const chunk of next()) { assembler.push(chunk); yield chunk }
    captures.push({ purpose: options.purpose, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens,
      system: options.system, messages: options.messages, finish: assembler.finish,
      output: assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('') })
  })
  try {
    const canvas = await host.ctx.sessionCanvas.addRoot((await host.ctx.sessionCanvas.create(sample.id)).id, sample.title)
    const id = canvas.nodes[0]!.sessionId
    host.ctx.agents.get(id)!.model.select({ provider: 'deepseek-official', model: 'deepseek-flash' })
    const began = Date.now()
    const result = await host.ctx.sessionCanvas.mindmap(canvas.id, id, null, sample.text, new AbortController().signal)
    const nodes = result.canvas.nodes.filter(node => result.createdSessionIds.includes(node.sessionId))
    const records = nodes.map(node => ({ sessionId: node.sessionId, parentId: node.parentId, text: host.ctx.sessionCanvas.summary(node.sessionId).markdown }))
    await writeFile(join(output, sample.id + '.json'), JSON.stringify({ sample, durationMs: Date.now() - began, captures, nodes: records }, (_key, value) => value instanceof RegExp ? value.toString() : value, 2) + '\n')
    console.log(JSON.stringify({ sample: sample.id, nodeCount: records.length, durationMs: Date.now() - began }))
    expect(captures.length).toBeGreaterThanOrEqual(2)
    expect(captures.length).toBeLessThanOrEqual(4)
    expect(nodes.length).toBeLessThanOrEqual(60)
    const parents = new Map(records.map(node => [node.sessionId, node.parentId]))
    const descendants = (parent: string) => records.filter(node => {
      for (let current = node.parentId; current != null; current = parents.get(current) ?? null) if (current === parent) return true
      return false
    })
    for (const group of sample.groups ?? []) {
      const candidates = group.parent ? records.filter(node => group.parent!.test(node.text)).map(node => descendants(node.sessionId)) : [records]
      const complete = candidates.some(children => {
        const choices = group.children.map(pattern => children.filter(node => pattern.test(node.text)).map(node => node.sessionId)).sort((a, b) => a.length - b.length)
        const assign = (i: number, used: Set<string>): boolean => i === choices.length || choices[i]!.some(id => !used.has(id) && assign(i + 1, new Set([...used, id])))
        return assign(0, new Set())
      })
      expect(complete, `Distinct source points under ${group.parent ?? 'the map'}: ${group.children.join(', ')}`).toBe(true)
    }
    const text = records.map(node => node.text).join('\n')
    for (const term of sample.terms) expect(text).toContain(term)
    if (sample.id === 'placeholders') {
      const branch = records.find(node => /方案\s*B/.test(node.text))
      expect(branch).toBeDefined()
      const branchText = [branch!, ...descendants(branch!.sessionId)].map(node => node.text).join('\n')
      expect(branchText).toMatch(/xxxxxx|未知|未明确|未提供|未确定|待定/)
      expect(branchText).not.toMatch(/\d/)
    }
    if (sample.id === 'conditional-policy' && records.length > 0) {
      expect(records).toHaveLength(2)
      expect(records.every(node => !parents.has(node.parentId!))).toBe(true)
      expect(text).toMatch(/three|3/)
      expect(text).toMatch(/transient/)
      expect(text).toMatch(/(?:not|never|no).*retry.*authentication/i)
    }
    if (sample.empty) { expect(nodes).toHaveLength(0); expect(result.canvas).toEqual(canvas) }
  } catch (error) {
    await writeFile(join(output, sample.id + '.failure.json'), JSON.stringify({ sample, captures, error: String(error) }, (_key, value) => value instanceof RegExp ? value.toString() : value, 2) + '\n')
    throw error
  } finally { off() }
}, 300_000)
