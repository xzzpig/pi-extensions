/**
 * Public entry for the frame patches. The work lives in:
 *
 *   frame-draw.ts       border drawing and escape-aware string helpers
 *   tool-frame.ts       ToolExecutionComponent: the box, its clicks
 *   tool-group-view.ts  how a box looks and reacts inside a group
 *   tool-groups.ts      the grouping state machine
 *   hover.ts            the row under the pointer, shared by tool and turn rows
 *   message-frame.ts    compaction / branch / skill / custom / user boxes
 *   user-message.ts     the default "rail" user message
 *   bash-mode-frame.ts  the user's own `!` / `!!` bash runs
 *   error-lines.ts      pi's own error rows: one framed row per failure, `×N`
 */

export { stripBackgroundFills } from "./draw/frame-draw.ts";
export { patchToolBoxFrames, type ToolFrameOptions } from "./tools/tool-frame.ts";
export { patchContainerBoxes, patchMessageBoxes, type ContainerBoxOptions } from "./messages/message-frame.ts";
export { patchBashExecutions, type BashModeOptions } from "./messages/bash-mode-frame.ts";
export { installErrorLines, patchErrorLines, type ErrorLineOptions } from "./messages/error-lines.ts";
export { patchUserMessages, USER_RAIL_GLYPH, type UserMessageOptions, type UserMessageStyle } from "./messages/user-message.ts";
