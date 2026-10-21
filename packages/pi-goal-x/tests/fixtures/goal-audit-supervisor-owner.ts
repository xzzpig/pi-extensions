/**
 * Test fixture: a pure supervisor-responder registration acknowledgement.
 *
 * The legacy auditor unit tests build a bare event bus instead of loading the
 * pi-subagents extension, so the new "register before the request" contract
 * would otherwise fail before the delegation is emitted. This fixture answers
 * the registration event with an inert, idempotent registration and does no
 * model work; it is never used by production code.
 */
import { SUPERVISOR_RESPONDER_REGISTER_EVENT } from "@xzzpig/pi-subagents/supervisor-routing";

export interface EventBusLike {
	on(event: string, handler: (value: unknown) => void): (() => void) | void;
}

export interface SupervisorResponderAck {
	/** Number of acknowledged registrations (assertions only). */
	readonly registered: number;
	/** Number of disposals actually performed (assertions only). */
	readonly disposed: number;
	uninstall(): void;
}

export function installSupervisorResponderAck(events: EventBusLike): SupervisorResponderAck {
	let registered = 0;
	let disposed = 0;
	const disposeListener = events.on(SUPERVISOR_RESPONDER_REGISTER_EVENT, (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		const request = raw as Record<string, unknown>;
		if (request.result !== undefined) return;
		registered += 1;
		let done = false;
		request.result = {
			ok: true,
			registration: {
				dispose: () => {
					if (done) return;
					done = true;
					disposed += 1;
				},
			},
		};
	});
	return {
		get registered() {
			return registered;
		},
		get disposed() {
			return disposed;
		},
		uninstall: () => {
			if (typeof disposeListener === "function") disposeListener();
		},
	};
}
