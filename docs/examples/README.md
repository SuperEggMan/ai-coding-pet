# 示例

## pet-sync.kiro.hook.example

一个**项目级** Kiro hook 示例：Kiro 会话结束（`agentStop`）时，往本机桌宠
（`127.0.0.1:47800`）发一条「登记 + 完成」事件，让对应的宠物切到「复奏」。

它是**可选**的、也是最小化的接入示范——真正日常用的是用户级 hook（见根
目录 `scripts/install-kiro-hooks.sh`，装到 `~/.kiro/hooks/`，对所有工程生效）。

### 想用它？

把它复制成一个真正的 hook（去掉 `.example` 后缀）放到你项目的 `.kiro/hooks/`：

```bash
mkdir -p .kiro/hooks
cp docs/examples/pet-sync.kiro.hook.example .kiro/hooks/pet-sync.kiro.hook
```

注意：项目级 hook 只对**这个工程**生效；要对所有工程生效，用
`scripts/install-kiro-hooks.sh` 装用户级 hook。

前提：本机桌宠（AI Coding Pet）正在运行，监听 `127.0.0.1:47800`。
