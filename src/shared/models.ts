import type { ModelOption } from './types.js'

/** Keep opaque routing ids untouched; split only adapter-supplied display text. */
export function modelDisplay(provider: string, display: string): Pick<ModelOption, 'name' | 'source' | 'description'> {
  const parts = display.split(/\s+·\s+/).map(p => p.trim()).filter(Boolean)
  const sources = provider.split(/\s+·\s+/).map(p => p.trim()).filter(p => p && !/^connect router$/i.test(p))
  while (parts.length > 1 && (/^connect router$/i.test(parts[0]!) || sources.some(s => s.toLowerCase() === parts[0]!.toLowerCase()))) parts.shift()
  return { name: parts.shift() || display, source: sources.join(' · ') || provider, description: parts.filter(p => !sources.includes(p)).join(' · ') }
}
