import { workerData } from "node:worker_threads";
import { mutateSettingsLayer } from "../extensions/goal-settings.ts";
for (let i = 0; i < 12; i++) mutateSettingsLayer({
  cwd: workerData.cwd,
  env: { PI_GOAL_GLOBAL_SETTINGS_FILE: `${workerData.cwd}/absent.json` },
  scope: "local",
  mutation: { op: "set", path: ["auditor", workerData.key], value: `${workerData.key}-${i}` },
});
