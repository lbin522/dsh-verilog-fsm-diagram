# Verilog FSM Diagram

一个 DSH Web 插件：把 Verilog 代码中的状态机转换成可交互的状态跳转图；也可以从状态跳转表生成可综合 Verilog，并与图实时同步。附带一个无头 CLI，方便 agent/skill 直接渲染 SVG。

## 功能

- **Verilog → 状态机图**：识别三段式（`state <= next_state` + 组合 `case(state)`）和二段式（时序块内 `case(state)`）FSM，支持 `localparam` 编码、复位状态、`casez` 通配符、`if/else` 链、三元跳转、嵌套 case、`always_ff/always_comb` 等常见写法。
- **多状态机**：同一文件中的多个 module / 多个 FSM 都会识别；支持「全部图」网格视图。
- **跳转表 → Verilog**：在「跳转表」模式编辑状态/条件/下一状态，或从文本导入（`A -> B : cond`、CSV、TSV、Markdown 表格），实时生成三段式可综合 Verilog 并绘制对应图。
- **条件编号**：一键全局切换文字/数字编号，也支持单独点击某条线切换该线；数字会嵌在线上，图内自动生成编号图例，下载的 SVG 同样包含。
- **连线调整**：在看图区直接拖动某条连线可以弯折它的走线，工具栏「重置连线」恢复自动布局；拖动不会改变缩放。
- **连线上色**：相邻连线自动使用不同颜色，线条、箭头、编号/文字标签颜色一致；明暗主题自适应。
- **交互**：缩放、拖拽、适应窗口、全屏、点击状态高亮其跳转、状态表（编码 + 完整跳转条件）、下载独立 SVG。
- 侧边栏入口默认折叠在「更多」菜单中（`client.js` 的 `SIDEBAR_FOLD` 改为 `'row'` 可恢复独立侧边栏行）。

## 安装（DSH Web）

本仓库是一个 DSH 插件 bundle（package.json 中声明 `dsh.bundle.patch` 和 `dsh.client`），不是独立网站。

1. 克隆或下载本仓库到本机，例如 `~/dsh-verilog-fsm-diagram`。
2. 在 DSH Web 环境中安装该目录为 bundle，例如使用插件的 `plugin_manager`：

   ```
   action: install_bundle
   target: /absolute/path/to/dsh-verilog-fsm-diagram
   ```

   或者把该目录链接到 DSH profile 的 `node_modules` 并加入 profile bundles（参考你的 DSH 安装方式）。
3. 刷新 DSH Web 页面，侧边栏「更多」菜单里会出现「状态机图」入口。

> 依赖 DSH Web 的 Client 插件机制（`window.__ModuleLoader__`），需要包含 `ui-sidebar` / `ui-layout` 的 Web profile。

## 使用

- 顶部「Verilog 代码 / 跳转表」切换输入方式。
- 代码模式：粘贴或打开 `.v`/`.sv` 文件，图会随编辑自动更新。
- 跳转表模式：编辑表格或导入文本；左侧「生成的 Verilog」可查看、复制、在代码模式打开。
- 工具栏：适应窗口、条件编号、全部图、状态表、重置连线、全屏、下载 SVG。
- 点击状态节点高亮相关跳转；点击连线切换该线的编号/文字；拖动连线调整走线。

## 无头 CLI

```bash
node cli.mjs <verilog.v> --list                       # 列出文件中的 FSM
node cli.mjs <verilog.v> --out <dir> --numbered       # 渲染 SVG（数字编号 + 图例）
node cli.mjs <verilog.v> --fsm <module|stateVar>      # 选择某个 FSM
node cli.mjs <verilog.v> --all --out <dir>            # 每个 FSM 各一张
```

- 默认输出文本条件标签；`--numbered` 输出数字编号 + 图例（适合大 FSM）。
- CLI 复用插件的解析/布局/渲染纯函数，随插件版本升级。

## 目录

```
client.js          # 浏览器端插件：解析器、布局、SVG、React UI（单文件）
cli.mjs            # 无头 CLI（复用 client.js 的纯函数）
index.js           # Host 端空壳（bundle 需要一条 Host row）
cordis.patch.yml   # bundle patch
package.json       # bundle manifest
locale/            # 插件显示名/描述的 en/zh
icon.svg           # 侧栏图标
tests/             # Node/jsdom 开发测试（需要 DSH checkout 的 node_modules）
```

## 开发与测试

测试使用 Node ≥ 20，并复用本机 DSH checkout 中的 React / jsdom：

```bash
DSH_CHECKOUT=/path/to/dsh-checkout node tests/test.mjs
DSH_CHECKOUT=/path/to/dsh-checkout node tests/ssr-test.mjs
DSH_CHECKOUT=/path/to/dsh-checkout node tests/edge-test.mjs
DSH_CHECKOUT=/path/to/dsh-checkout node tests/feature-test.mjs
DSH_CHECKOUT=/path/to/dsh-checkout node tests/dom-feature-test.mjs
```

- `test.mjs`：解析器核心用例
- `ssr-test.mjs`：注册 + React SSR 渲染
- `edge-test.mjs`：畸形输入、性能、400 状态图布局
- `feature-test.mjs`：跳转表生成、编号/图例、多 FSM、边颜色
- `dom-feature-test.mjs`：jsdom 交互（表格、编号点击、连线拖动、全部图、全屏、缩放保持）

## 已知限制

- 只绘制基于 `case` 的状态机；纯 `if/else` 链式 FSM 会给出提示但不绘图。
- 跳转表生成的 RTL 是可用脚手架：复位按低有效异步复位，条件信号自动推断为输入端口（位宽按位选/带位宽字面量推断），函数调用会替换为同名输入并告警；复杂设计请在代码模式继续修改。
- 同一状态上超过调色板颜色数（12）的连线会复用颜色。

## License

未声明 License。如需开源发布，请补充许可证文件。
