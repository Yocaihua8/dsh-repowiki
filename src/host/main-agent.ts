import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

/** rc.3 dropped AgentRegistry.roots(); older hosts still expose it. */
export function isRootAgent(agents: AgentRegistry, agent: Agent): boolean {
  const legacy = agents as AgentRegistry & { roots?(): readonly Agent[] }
  if (typeof legacy.roots === 'function') return legacy.roots().includes(agent)
  return agent.session.header.origin !== 'subagent' && !(agent.session.header.delegationDepth ?? 0)
}
