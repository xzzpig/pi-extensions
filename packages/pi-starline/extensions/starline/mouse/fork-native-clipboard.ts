import type { AsyncCopyHandler, CopyHandlerContext } from "@xzzpig/pi-mouse-events/api";

type CopyReceiver = {
	copySelection?: (text: string) => boolean | string | Promise<boolean | string>;
	terminal?: { write?: (data: string) => void };
	flash?: (message: string) => void;
};

type CopyCandidates = {
	receiver: CopyReceiver;
	showNotice: boolean;
	/** The editor gets first refusal, followed by the cleaned transcript. */
	texts: Array<() => string | undefined>;
};

async function copyText(
	receiver: CopyReceiver,
	text: string,
	showNotice: boolean,
): Promise<boolean> {
	if (typeof receiver.copySelection === "function") {
		try {
			if ((await receiver.copySelection(text)) === true) {
				if (showNotice) receiver.flash?.("Copied!");
				return true;
			}
		} catch {
			// A failed native clipboard falls back to OSC 52, as upstream does.
		}
	}
	try {
		if (typeof receiver.terminal?.write !== "function") return false;
		receiver.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		if (showNotice) receiver.flash?.("Copied!");
		return true;
	} catch {
		return false;
	}
}

/** Build an async shared-layer handler; unavailable on older v2 publishers. */
export function nativeCopyHandler(
	candidatesFor: (context: CopyHandlerContext) => CopyCandidates | undefined,
): AsyncCopyHandler {
	return async (context) => {
		const candidates = candidatesFor(context);
		if (!candidates) return undefined;
		for (const read of candidates.texts) {
			const text = read();
			if (text === undefined) continue;
			if (text.length === 0 || (await copyText(candidates.receiver, text, candidates.showNotice))) {
				return { handled: true };
			}
		}
		return undefined;
	};
}
