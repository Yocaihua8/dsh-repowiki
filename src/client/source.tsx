import { Button, Input, ReadBlock, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SourceExcerpt } from '../shared/types.js'

/** Only the saved excerpt is navigable; the host owns the native code viewer. */
export function SourceView({ source, line, onLine, u }: { source: SourceExcerpt; line: number; onLine: (line: number) => void; u: (cn: string, en: string) => string }) {
  const target = Math.max(source.startLine, Math.min(source.endLine, Math.floor(line || source.startLine)))
  const from = Math.max(source.startLine, target - 4), to = Math.min(source.endLine, from + 59)
  const text = source.text.split('\n')
  return <>
    <div className="drw-source-controls"><label>{u('定位行号', 'Go to line')}<Input aria-label={u('定位行号', 'Go to line')} type="number" min={source.startLine} max={source.endLine} value={target} onChange={e => onLine(Number(e.target.value))} /></label>
      <Button variant="ghost" size="sm" disabled={target <= source.startLine} onClick={() => onLine(Math.max(source.startLine, target - 50))}>{u('上一段', 'Previous')}</Button>
      <Button variant="ghost" size="sm" disabled={to >= source.endLine} onClick={() => onLine(Math.min(source.endLine, target + 50))}>{u('下一段', 'Next')}</Button>
    </div>
    <ReadBlock label={`${source.path}:L${target}`} totalLines={source.endLine} lang={languageForPath(source.path)} maxLines={60}
      lines={text.slice(from - source.startLine, to - source.startLine + 1).map((text, i) => ({ number: from + i, text }))}
      labels={{ codeLabel: u('源码', 'Source'), wrapLabel: u('自动换行', 'Wrap'), unwrapLabel: u('不换行', 'Unwrap'), copy: u('复制', 'Copy'), copied: u('已复制', 'Copied'),
        collapseAria: u('收起源码', 'Collapse source'), expandAria: n => u(`展开 ${n} 行`, `Expand ${n} lines`), collapse: u('收起', 'Collapse'), expand: n => u(`展开 ${n} 行`, `Expand ${n} lines`), window: (n, total) => u(`显示 ${n} / ${total} 行`, `Showing ${n} of ${total} lines`) }} />
  </>
}
