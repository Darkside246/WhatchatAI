import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, agentForTool, agentsReachingCustomers, findAgent, unclaimedTools } from '../src/services/ai/agentRegistry.js';
import { listRegisteredTools } from '../src/services/ai/aiToolPolicy.js';

/**
 * This file is the register's accountability, not decoration.
 *
 * A register nobody verifies becomes a comment block that lies - which is
 * exactly what the previous agentRegistry.ts turned into before it was
 * deleted. These assertions fail the build the moment the register drifts
 * from the software it claims to describe.
 */
describe('the agent register', () => {
  /**
   * The check that matters most. Adding a tool to aiToolPolicy without
   * saying which agent may invoke it means nobody can answer "what can
   * reach this?" - so it fails here, with the tool named.
   */
  it('leaves no registered tool unclaimed', () => {
    expect(unclaimedTools()).toEqual([]);
  });

  it('claims no tool that does not exist', () => {
    const registered = new Set(listRegisteredTools().map((tool) => tool.name));
    for (const agent of AGENT_REGISTRY) {
      for (const tool of agent.tools) {
        expect(registered, `${agent.id} claims "${tool}", which is not registered in aiToolPolicy`).toContain(tool);
      }
    }
  });

  /** Two agents claiming one tool makes "who can do this" unanswerable. */
  it('gives every tool exactly one owner', () => {
    const claims = AGENT_REGISTRY.flatMap((agent) => agent.tools);
    expect(new Set(claims).size).toBe(claims.length);
  });

  /**
   * What stops a register from rotting. A file cited here that has since
   * been deleted or moved would make every other claim in this entry
   * unverifiable.
   */
  it('cites only implementations that really exist', () => {
    for (const agent of AGENT_REGISTRY) {
      expect(existsSync(resolve(process.cwd(), agent.implementation)), `${agent.id} cites ${agent.implementation}, which does not exist`).toBe(true);
    }
  });

  it('gives every agent a unique id', () => {
    const ids = AGENT_REGISTRY.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says of every agent what it will never do', () => {
    for (const agent of AGENT_REGISTRY) {
      expect(agent.neverDoes.length, `${agent.id} states no limits`).toBeGreaterThan(0);
      expect(agent.purpose.length, `${agent.id} states no purpose`).toBeGreaterThan(20);
    }
  });

  /**
   * The shortest useful audit question, and the answer should stay small.
   * If a second surface ever starts reaching customers, that is a decision
   * somebody should have to make deliberately - including here.
   */
  it('has exactly one surface whose output reaches a customer', () => {
    expect(agentsReachingCustomers().map((agent) => agent.id)).toEqual(['customer_reply']);
  });

  /** Only the customer-reply surface holds tools today; a background sweep acquiring one should be a deliberate act. */
  it('gives no background sweep or safety pass any tool', () => {
    for (const agent of AGENT_REGISTRY.filter((candidate) => candidate.surface !== 'customer_reply')) {
      expect(agent.tools, `${agent.id} has acquired tools`).toEqual([]);
    }
  });

  it('answers which agent owns a tool', () => {
    expect(agentForTool('confirm_food_order')?.id).toBe('customer_reply');
    expect(agentForTool('not_a_real_tool')).toBeNull();
    expect(findAgent('sentinel')?.reachesCustomer).toBe(false);
    expect(findAgent('nobody')).toBeNull();
  });

  /**
   * The register's own reason for existing, asserted: a business's agents
   * are rows in ai_agents, so the file lists SURFACES. Claiming to
   * enumerate every business's agents would be the same false impression
   * the deleted version gave.
   */
  it('describes the business-configured surface as configured by the business', () => {
    const reply = findAgent('customer_reply');
    expect(reply?.configuredBy).toBe('business');
    expect(AGENT_REGISTRY.filter((agent) => agent.configuredBy === 'business')).toHaveLength(1);
  });
});
