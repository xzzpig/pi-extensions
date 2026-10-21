/** Ambient declarations for the fork test runner (design D7/D8). */
export declare const PACKAGE_ROOT: string;
/** Live E2E entry point: real pi + tmux + real provider. Never run by the runner. */
export declare const LIVE_E2E_ENTRY: string;
/** Pinned fork-only suite list, relative to the package root. */
export declare const FORK_TEST_FILES: readonly string[];
/** Preloads applied in order before the fork suites run. */
export declare const PRELOADS: readonly string[];
/** Pure list validation: returns the problems found (empty means OK). */
export declare function validateForkTestList(options?: { packageRoot?: string }): string[];
