// Fork-only helpers for sparse, schema-validated settings layers.
type SettingsValue = string | number | boolean | null | undefined | SettingsValue[] | { [key: string]: SettingsValue };

function mergeValue(lower: SettingsValue, upper: SettingsValue): SettingsValue {
	if (upper === undefined) return lower;
	if (upper && typeof upper === "object" && !Array.isArray(upper)) {
		const result: { [key: string]: SettingsValue } = { ...(lower && typeof lower === "object" && !Array.isArray(lower) ? lower : {}) };
		for (const [key, value] of Object.entries(upper)) result[key] = mergeValue(result[key], value);
		return result;
	}
	return Array.isArray(upper) ? structuredClone(upper) : upper;
}

export function mergeSettingsLayers<T>(lower: T, upper: T): T {
	return mergeValue(lower as SettingsValue, upper as SettingsValue) as T;
}

export function hasSettingsPath(value: unknown, path: string): boolean {
	let current: SettingsValue = value as SettingsValue;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return false;
		current = current[key];
	}
	return current !== undefined;
}
