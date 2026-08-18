/**
 * Minimal SGR/X10 mouse parsing for the fleet inspector.
 *
 * In fullscreen mode pi-tui owns terminal mouse modes (?1000h ?1002h ?1003h
 * ?1006h) itself and forwards raw wheel events to a focused overlay's
 * `handleInput` (the same mechanism pi-btw relies on). We therefore never
 * write mouse enable/disable sequences here — we only parse the forwarded
 * data. SGR encoding reports `ESC[<b;c;rM` (press) / `m` (release); X10
 * reports `ESC[M` followed by three bytes (button, column + 32, row + 32).
 * Wheel buttons carry the 64 bit; the low bits select the direction
 * (0 = up, 1 = down). The 32 bit marks a button release (SGR wheel releases
 * are 96/97), which we ignore so a motion-tracking terminal cannot
 * double-scroll per notch.
 */
export interface MouseWheelEvent {
	/** -1 for wheel up, 1 for wheel down. */
	direction: -1 | 1;
	/** Zero-based terminal column where the wheel event occurred. */
	x: number;
}

export function parseMouseWheelEvent(data: string): MouseWheelEvent | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
	if (sgr) {
		const buttonText = sgr[1];
		const xText = sgr[2];
		if (buttonText === undefined || xText === undefined) return undefined;
		const button = Number.parseInt(buttonText, 10);
		if ((button & 64) === 0 || (button & 32) === 32) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return { direction: direction === 0 ? -1 : 1, x: Number.parseInt(xText, 10) - 1 };
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0 || (button & 32) === 32) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return { direction: direction === 0 ? -1 : 1, x: data.charCodeAt(4) - 33 };
	}
	return undefined;
}