[English](README.md) | 中文

# omp-compact-tools

把 omp 里一大堆工具调用方框压成一行，连续调用还能合并成一条。只改显示，不改工具本身，也不影响模型看到的内容。

看[中文宣传页](https://onelasthuman.github.io/omp-compact-tools/zh/)。

## 三种显示方式

- `default`：omp 原样，完整工具卡片。
- `line`（默认）：每个工具调用一行，超出宽度自动省略。
- `group`：连续多个工具调用合成一行。

`line` 大概长这样：

```text
❯ Bash: ls -la · 12 lines
● Read /path/to/file.ts
⌕ Grep: TODO 3 matches · 2 files
✎ Edit: /path/to/file.ts +3/-1
```

`group` 大概长这样：

```text
• 4 tools: Bash · Read · Grep · Edit
```

不管哪种方式，按 `Ctrl+O` 都能展开，看到原始工具卡片。

## 安装

### 方式一：用 omp 插件命令（推荐）

```bash
omp plugin install github:OneLastHuman/omp-compact-tools
```

装完重启 omp。

### 方式二：手动放扩展文件

把 `extensions/omp-compact-tools.ts` 复制到：

```text
~/.omp/agent/extensions/omp-compact-tools.ts
```

然后重启 omp。

### 本地开发

```bash
omp plugin link /path/to/omp-compact-tools
```

## 使用

在 omp 里输入：

```text
/compact-tools                 # 循环切换 default → line → group
/compact-tools line            # 每个调用一行
/compact-tools group           # 连续调用合并成一行
/compact-tools default         # 回到 omp 原样
/compact-tools status          # 看当前模式
```

也可以直接改配置文件 `~/.omp/agent/compact-tools.json`：

```json
{ "mode": "line" }
```

改完重启 omp。

## 卸载

```bash
omp plugin uninstall omp-compact-tools
```

如果是手动放的，删掉 `~/.omp/agent/extensions/omp-compact-tools.ts` 即可。

## 说明

- 需要 omp 18.13 或更新版本；目前在 18.13.3 和 18.14.0 上测试过。
- 只影响终端里的显示；工具调用、结果和发给模型的内容都不变。
- 已经写进终端历史的旧记录，切换模式后可能需要按一次 `Ctrl+O` 重新展开或折叠才能看到变化。
- 这个仓库只放工具调用折叠，不放提示词或其他配置。

## License

MIT
