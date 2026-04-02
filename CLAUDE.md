# CLAUDE.md

## 构建与安装

```bash
bun install && bun run build
echo '#!/usr/bin/env bun' | cat - dist/cli.js > /usr/local/bin/claude-dev && chmod +x /usr/local/bin/claude-dev
```

- 构建产物需要加 shebang (`#!/usr/bin/env bun`) 后复制到 `/usr/local/bin/claude-dev`
- 不要用 `bun link`，避免影响后续构建
- 命名为 `claude-dev`，与官方 `claude` CLI 区分
