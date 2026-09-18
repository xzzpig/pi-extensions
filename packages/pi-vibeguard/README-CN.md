# pi-vibeguard

[English](README.md) | [中文](README-CN.md)

灵感来源于 [VibeGuard](https://github.com/inkdust2021/VibeGuard) 和 [opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard)。

一个 pi 扩展，功能：

- 在请求发送到 LLM 提供商**之前**，将配置的敏感字符串替换为占位符（提供商永远看不到明文）
- 在模型输出**完成后**，将占位符还原为原文（本地显示/存储更自然）
- 在工具**执行前**还原占位符（如 `bash` / `write` / `edit`），确保本地工具使用真实值运行
- **会话级临时挂起**：`/vibeguard:disable [category]` / `/vibeguard:enable [category]`、`/vibeguard:status`、交互式类别选择器 `/vibeguard:categories` —— 不重启、不改配置即可在运行时临时停用脱敏

占位符格式（与 VibeGuard 对齐）：

- 前缀：`__VG_`
- 格式：`__VG_<CATEGORY>_<hash12>__` 或 `__VG_<CATEGORY>_<hash12>_<N>__`
- `hash12` 是 `HMAC-SHA256(会话随机密钥, 原文)` 的前 12 位十六进制字符，会话内稳定且对提供商不可逆

## 安装

### 本地（项目级）

1. 将 `index.ts` 复制到 `.pi/extensions/vibeguard.ts`
2. 将 `vibeguard.config.json` 放在项目根目录
3. 重启 pi 或执行 `/reload`

### npm（全局）

```bash
pi install npm:@aizigao/pi-vibeguard
```

## 配置

配置文件查找顺序（第一个匹配即生效）：

1. 环境变量 `PI_VIBEGUARD_CONFIG` 指定的路径
2. 项目根目录：`./vibeguard.config.json`
3. 项目 `.pi` 目录：`./.pi/vibeguard.config.json`
4. 全局目录：`~/.pi/agent/vibeguard.config.json`

完整示例见 `vibeguard.config.json.example`。

```jsonc
{
  "enabled": true,
  "debug": false,
  "placeholder_prefix": "__VG_",
  "session": {
    "ttl": "1h",
    "max_mappings": 100000
  },
  "patterns": {
    "keywords": [
      { "value": "my-api-key-123", "category": "API_KEY" }
    ],
    "regex": [
      { "pattern": "sk-[A-Za-z0-9]{48}", "category": "OPENAI_KEY" },
      { "pattern": "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+", "category": "GITHUB_TOKEN" },
      { "pattern": "AKIA[0-9A-Z]{16}", "category": "AWS_ACCESS_KEY" }
    ],
    "builtin": ["email", "china_phone", "china_id", "uuid", "ipv4", "mac"],
    "exclude": ["example.com", "localhost", "127.0.0.1", "0.0.0.0"]
  }
}
```

> 安全提示：找不到配置文件或 `enabled=false` 时，扩展为 no-op。

## 行为说明

当敏感值被匹配后，会被替换为占位符（如 `sk-a0d309c77dd44d57be0f1a675c0zzzzz`）。LLM 只能看到占位符，并可能原样输出。

示例会话：

```
User: 这个值 sk-a0d309c77dd44d57be0f1a675c0zzzzz , 你原封不动的输出给我

LLM:  sk-a0d309c77dd44d57be0f1a675c0zzzzz

User: 然后再以字符数组输出

LLM:  ['_', '_', 'V', 'G', '_', 'O', 'P', 'E', 'N', 'A', 'I', '_', 'K', 
       'E', 'Y', '_', 'c', '1', '1', '3', 'f', '0', '6', 'b', 'c',
       '5', '0', 'a', '_', '_']
```

LLM 提供商**从未收到原始值**——它只看到占位符。LLM 输出中包含占位符是预期且无害的行为。

## 临时挂起（会话级）

有时你需要暂时关闭脱敏（例如让模型直接处理真实示例数据）。可以**临时挂起**脱敏——不重启 pi、不改配置文件。

语义：

- **挂起只停新内容**：挂起期间新产生的用户/工具/assistant 内容以明文通过，不再生成新占位符。
- **历史占位符不受影响**：本会话中先前已生成的占位符仍然照常自动还原——工具执行前还原、assistant 输出后还原两条路径在挂起期间均不受影响。
- **状态仅存在于当前会话内存**：随新会话/重启 pi 自动复位到配置里的 `enabled` 值。磁盘上的 `vibeguard.config.json` 永不修改。

### 命令

| 命令 | 效果 |
| --- | --- |
| `/vibeguard:disable` | 整体挂起：新内容不再脱敏（历史占位符仍恢复） |
| `/vibeguard:disable <CATEGORY>` | 只挂起该类别，如 `/vibeguard:disable API_KEY`（未知类别会提示可用列表） |
| `/vibeguard:enable` | 整体恢复：所有规则恢复脱敏 |
| `/vibeguard:enable <CATEGORY>` | 只恢复该类别 |
| `/vibeguard:status` | 显示当前脱敏状态（生效中 / 挂起类别） |
| `/vibeguard:categories` | 打开交互式类别选择器：`Space`/`Enter` 切换当前行（第 1 行=整体挂起），`↑/↓` `j/k` 移动，`q`/`Esc` 关闭 |

类别名不区分大小写。状态栏同步反映状态：`VibeGuard[OFF]`（整体挂起）、`VibeGuard[OFF:EMAIL,MAC]`（按类别挂起）、`VibeGuard[ON]`（生效中）。

### 示例

```text
> /vibeguard:disable
  VibeGuard: 已整体挂起 —— 新内容不再脱敏；会话历史中的占位符仍会照常恢复（/vibeguard:enable 恢复）

  # 后续新输入的手机号会以明文发往模型……
  > /vibeguard:enable
  VibeGuard: 已整体恢复 —— 新内容将重新脱敏
```

## 调试

设置 `PI_VIBEGUARD_DEBUG=1` 环境变量或在配置中设置 `"debug": true`。

```bash
PI_VIBEGUARD_DEBUG=1 pi
```

## 许可

MIT
