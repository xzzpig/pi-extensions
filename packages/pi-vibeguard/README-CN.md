# pi-vibeguard

[English](README.md) | [中文](README-CN.md)

灵感来源于 [VibeGuard](https://github.com/inkdust2021/VibeGuard) 和 [opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard)。

一个 pi 扩展，功能：

- 在请求发送到 LLM 提供商**之前**，将配置的敏感字符串替换为占位符（提供商永远看不到明文）
- 在模型输出**完成后**，将占位符还原为原文（本地显示/存储更自然）
- 在工具**执行前**还原占位符（如 `bash` / `write` / `edit`），确保本地工具使用真实值运行

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

## 调试

设置 `PI_VIBEGUARD_DEBUG=1` 环境变量或在配置中设置 `"debug": true`。

```bash
PI_VIBEGUARD_DEBUG=1 pi
```

## 许可

MIT
