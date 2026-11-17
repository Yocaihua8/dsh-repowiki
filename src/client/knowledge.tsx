import { WikiIcon } from './icons.js'
import { useEffect, useState } from 'react'
import { Button, Input, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeCard, ProjectConfiguration, ReferencesResponse, WikiManifest } from '../shared/types.js'
import { call, type RepoWikiRemote } from './jobs.js'
import { MermaidMarkdown } from './mermaid.js'

type Text = (zh: string, en: string) => string
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export function Knowledge({ wiki, draft, u, onSource }: { wiki: WikiManifest; draft: boolean; u: Text; onSource: (id: string, line: number) => void }) {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [selected, setSelected] = useState('')
  const categories = ['architecture', 'workflow', 'api', 'testing', 'constraints']
  const names = [u('架构', 'Architecture'), u('流程', 'Workflow'), u('接口', 'API'), u('测试', 'Testing'), u('约束', 'Constraints')]
  const cards = (wiki.cards ?? []).filter(c => (category === 'all' || c.category === category) && `${c.title} ${c.summary} ${c.content}`.toLowerCase().includes(query.toLowerCase()))
  const card = cards.find(c => c.id === selected)
  return <section className="drw-knowledge">
    <h1>{u('知识卡片', 'Knowledge cards')} <small className="drw-muted">{wiki.cards?.length ?? 0}</small></h1>
    <p className="drw-muted">{draft ? u('草稿卡片可预览，发布后才能用于自动引用。', 'Draft cards are previewable. Only published cards can be referenced.') : u('与 Wiki 共享源码快照。未核实的卡片不会自动引用。', 'Shares the Wiki source snapshot. Uncertain cards are excluded from automatic references.')}</p>
    <Input type="search" aria-label={u('搜索知识卡片', 'Search cards')} placeholder={u('搜索标题、摘要和内容', 'Search cards')} value={query} onChange={e => setQuery(e.target.value)} />
    <div className="drw-scroll-tabs"><SegmentedControl id="drw-card-categories" value={category} onChange={setCategory} label={u('卡片分类', 'Card categories')} options={[{ value: 'all', label: u('全部', 'All') }, ...categories.map((value, i) => ({ value, label: names[i]! }))]} /></div>
    {!cards.length && <p className="drw-muted">{u('尚无匹配卡片。', 'No matching cards yet.')}</p>}
    {card ? <div className="drw-card-detail"><Button variant="ghost" size="sm" onClick={() => setSelected('')}><WikiIcon name="arrow-left" />{u('全部卡片', 'All cards')}</Button><h2>{card.title}</h2><p>{card.summary}</p><p className="drw-muted">{card.verification === 'supported' ? u('核验通过', 'Verified') : u('待确认', 'Uncertain')} · {card.version}</p>
      <MermaidMarkdown text={card.content} labels={{ code: { copyLabel: u('复制', 'Copy'), copiedLabel: u('已复制', 'Copied') }, footnotes: u('注释', 'Footnotes') }} />
      {card.issues.map((issue, i) => <p key={i} className="drw-notice">{issue}</p>)}
      {card.evidence.map((e, i) => <div key={i} className="drw-card-evidence"><Button variant="outline" size="sm" onClick={() => onSource(e.sourceId, e.startLine)}>{e.path}:L{e.startLine}–L{e.endLine}</Button><pre>{e.quote}</pre></div>)}
    </div> : <div className="drw-knowledge-grid">{cards.map(c => <section key={c.id} className="drw-knowledge-card"><small className="drw-muted">{names[categories.indexOf(c.category)]} · {c.verification === 'supported' ? u('已核验', 'Verified') : u('待确认', 'Uncertain')}</small><h2>{c.title}</h2><p>{c.summary}</p><Button variant="ghost" size="sm" onClick={() => setSelected(c.id)}>{u('查看卡片', 'Read card')}<WikiIcon name="arrow-right" /></Button></section>)}</div>}
  </section>
}
export function References({ remote, config, u, onConfig, historyOnly = false }: { remote: RepoWikiRemote; config: ProjectConfiguration; u: Text; onConfig: (c: ProjectConfiguration) => void; historyOnly?: boolean }) {
  const [data, setData] = useState<ReferencesResponse | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { const c = new AbortController(); void call(remote.getReferences({ path: config.path }, c.signal)).then(setData).catch(e => { if (!c.signal.aborted) setError(message(e)) }); return () => c.abort() }, [remote, config])
  const toggle = async (enabled: boolean) => { setBusy(true); setError(''); try { onConfig(await call(remote.saveProjectConfig({ path: config.path, settings: { ...config.settings, agentReference: enabled } }))) } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  return <section className="drw-knowledge">{!historyOnly && <><h1>{u('智能体自动引用', 'Agent references')}</h1><div className="drw-setting"><span>{u('引用当前项目知识卡片', 'Reference current project cards')}<small>{u('只向宿主授权的当前项目主会话提供相关摘要与来源。', 'Relevant summaries and sources for authorized root sessions in this project.')}</small></span><Switch label={u('智能体引用', 'Agent references')} checked={config.settings.agentReference === true} disabled={busy} onChange={v => { void toggle(v) }} /></div></>}
    {error && <p role="alert" className="drw-alert">{error}</p>}{!historyOnly && <p className="drw-muted">{config.path}<br />{u('关闭后停止后续注入；已进入会话历史的内容不会被删除。', 'Disabling stops future injection. Existing conversation history is retained.')}</p>}
    <h2>{u('可引用卡片', 'Available cards')} · {data?.cards.length ?? 0}</h2>{data?.cards.map(c => <div key={c.id} className="drw-reference-row"><strong>{c.title}</strong><p>{c.summary}</p><small className="drw-muted">{c.evidence.map(e => `${e.path}:L${e.startLine}`).join(' · ')}</small></div>)}
    <h2>{u('最近引用记录', 'Recent references')}</h2>{!data?.records.length && <p className="drw-muted">{u('尚无引用记录。', 'No references yet.')}</p>}{data?.records.slice(-20).reverse().map((r, i) => <div className="drw-reference-row" key={i}><small>{new Date(r.at).toLocaleString()} · {r.sessionId}</small><p>{r.cardIds.join(' · ')}</p><small className="drw-muted">{u('发布版本', 'Published revision')} {r.revision}</small></div>)}
  </section>
}
