/** Ambient declarations for the test-group planner. */
export interface TestGroup {
	name: string;
	files: string[];
	adapter: boolean;
	clearNodeOptions: boolean;
}
export declare const SDK_TEST_FILES: readonly string[];
export declare function planTestGroups(discovered: {
	unitFiles?: readonly string[];
	integrationFiles?: readonly string[];
	e2eFiles?: readonly string[];
	suite?: "unit" | "integration" | "e2e" | "all";
}): TestGroup[];
export declare function groupArgs(
	group: TestGroup,
	options?: { adapterPath?: string; isolationArgs?: readonly string[] },
): string[];
