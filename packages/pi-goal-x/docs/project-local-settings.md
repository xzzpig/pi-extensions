# Project-local Goal-X settings

Goal-X reads sparse settings from three files. Existing per-setting environment
variables take precedence where supported, followed by:

1. Project-local: `<cwd>/.pi/pi-goal-x-settings.local.json`.
2. Project: `<cwd>/.pi/pi-goal-x-settings.json`, or `PI_GOAL_SETTINGS_FILE`.
3. Global: `$PI_GOAL_GLOBAL_SETTINGS_FILE`, or
   `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json`.

Defaults apply when a field is absent from every layer. The local path always
uses the working directory, even when the shared project path is overridden.
Fields inherit individually; lists replace the lower list rather than append.
Explicit valid `false`, `0`, and empty lists are values. Remove a field to
inherit it again. Existing aliases remain supported; the nested spelling wins
within a file. The legacy auditor model environment variables are not supported.

For example, a shared project file can contain `auditor.checklistExtra`, while
the local file contains only:

```json
{
  "auditor": {
    "provider": "my-provider",
    "model": "my-model"
  }
}
```

Configure Git to ignore the local file yourself, such as in your repository's
`.gitignore` or `.git/info/exclude`. Goal-X never edits Git configuration.
This file is not a credential store: use the provider's normal authentication
mechanism. Local overrides can replace shared settings, including audit lists;
shared configuration is not an enforced organization policy.

Open `/goal-settings` to inspect effective values and sources. The menu starts
in the project scope; select the scope row to switch to local or global. Edits
and inherited-value removal affect only the selected file. When a higher layer
masks the edited value, the menu reports both the source and the selected
layer's value. The Controls dialog also switches scopes with Ctrl+S; conflicting
command and shortcut changes are checked against each affected layer view.

Settings edited through Goal-X are refreshed through the existing settings
mechanism. External changes are observed at the existing session/reload or
cache-invalidation boundaries; there is no live filesystem watcher. Auditor
request settings apply to the next audit, while agent definition settings
require a new session or `/reload`. Older versions ignore the local file;
removing it restores the existing global/project behavior after refresh.
