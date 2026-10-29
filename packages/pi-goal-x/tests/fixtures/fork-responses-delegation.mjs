/** A deterministic pi-subagents owner for the real-SDK Responses regression.
 * The main Responses request uses the real SDK; the child outcome is simulated
 * through the actual structured delegation event contract, without a provider.
 */
import { RUNTIME_AGENT_REGISTER_EVENT } from '@xzzpig/pi-subagents/agents';
import {
 SUBAGENT_DELEGATION_REQUEST_EVENT,
 SUBAGENT_DELEGATION_STARTED_EVENT,
 SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from '@xzzpig/pi-subagents/delegation';
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from '@xzzpig/pi-subagents/supervisor-routing';

export function installResponsesDelegationOwner(pi) {
 const requests=[];
 for (const event of [RUNTIME_AGENT_REGISTER_EVENT, SUPERVISOR_RESPONDER_REGISTER_EVENT]) {
  pi.events.on(event, request => {
   if (request.result === undefined) request.result={ok:true,registration:{dispose() {}}};
  });
 }
 pi.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, request => {
  requests.push(request);
  const identity={requestId:request.requestId,ownerRunId:request.ownerRunId,nodeId:request.nodeId};
  pi.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity);
  pi.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
   ...identity,status:'completed',runId:'responses-audit-child',model:'fixture/auditor',
   result:{kind:'structured',value:{verdict:'approved',report:'Workspace evidence verified.',findings:[]}},
  });
 });
 return requests;
}
