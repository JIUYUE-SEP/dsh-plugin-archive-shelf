# dsh-plugin-archive-shelf

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 用的**归档架**。

DSH 的会话可以归档，但产品没有回程票：侧栏菜单只能把它藏起来，没有取消归档入口，
也没有办法删除会话日志。这个插件补上这一页：列出**所有已归档会话**，并给出缺的那两个动作。

[English](README.md) | 中文

## 你会得到什么

设置 → **归档架**（在「Agent 预设」下面那一栏）：

- 每条已归档会话的**标题**、工作区、目录、归档时间与磁盘占用；
- **还原** —— 把它从归档集合里移除，会话**回到侧栏原来的位置**（归档从不改动它的工作区槽位）；
- **彻底删除** —— 二次确认后删除会话日志目录、投影缓存与工作区记账。不可恢复；
- 每行状态徽标：**运行中**（agent 正在跑一轮）/ **已载入**（常驻在宿主进程内存里）。
  这两种状态都不能安全删除，见「已知限制」；
- **清理** —— 清掉那些磁盘上已经没有对应会话的失效归档记录。

## 环境要求

- 带 `web` profile 的 DeepSeek Harness。开发与验证版本：`0.1.5-rc.2`。
- Node `^22.19 || >=24`（与 harness 自身要求一致）。

## 安装

```sh
# 1. 装进你的 web profile
dsh plugin --profile web add github:JIUYUE-SEP/dsh-plugin-archive-shelf
```

```yaml
# 2. 挂载 —— 追加到 ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: archive-shelf
      name: dsh-plugin-archive-shelf
```

然后**重启** `dsh` 并刷新页面。静态客户端插件随页面的 boot graph 下发，
单纯刷新并不保证拿到新插件（浏览器缓存、扫描时机都会搅局），重启则一定生效。

### 本地安装

```sh
git clone https://github.com/JIUYUE-SEP/dsh-plugin-archive-shelf.git
dsh plugin --profile web add ./dsh-plugin-archive-shelf
# cordis.patch.yml 里加同样那一行，然后重启
```

### 卸载

```sh
dsh plugin --profile web remove dsh-plugin-archive-shelf
# 再删掉你加进 cordis.patch.yml 的那段 `- insert:`
```

## 实现方式

**没有构建步骤**：两半都是纯 JavaScript，直接随包发布。

- **`lib/index.js`（宿主半）** —— 一个 Cordis 插件，注入 `workspaceRegistry`、
  `sessionPersistence`、`webServer`；注册一条同源 JSON 路由（`POST /archive-shelf/api`），
  实现 `list` / `unarchive` / `delete` / `forget` 四个操作。删除直接用 `node:fs` ——
  宿主插件就是普通 Node 代码，不需要任何沙箱提权。
- **`lib/client.js`（浏览器半）** —— 直接写成客户端模块加载器的工厂形态
  （`window.__ModuleLoader__.load({ id, factory })`）。原因是 harness 自己的客户端打包预设
  位于其仓库内部、并未发布。它只注册一个 `settings.section`，
  于是这一页出现在设置卡片的左侧 tab 栏里，产品源码一行都不用改。

路由是自证的：`POST` + `content-type: application/json` + 自定义头
`x-archive-shelf-client: 1` 组合起来对浏览器是**非简单请求**，跨站页面会先撞上
CORS 预检（本服务不回答），再叠加一层 `Origin`/`Host` 同源校验。
这防的是跨站请求，不防同机其它进程 —— 那些进程本来就能直接读写会话文件。

## 已知限制

- **取消归档走的是内部 API。** harness 没有公开的 unarchive 操作，插件通过 workspace
  registry 自己的 `setState` 改写归档集合。将来 harness 改了内部结构，插件会**明确报错**
  而不是静默失败。
- **常驻或运行中的会话删不掉。** 宿主进程已载入的会话把日志握在内存里；删掉磁盘文件会留下
  "活着的会话 + 没有落盘记录"（后续 append 甚至可能把日志写回来）。这类行的删除按钮会置灰
  并写明原因 —— **重启 `dsh`** 之后它们不再常驻，就能删了。
- **不删附件。** 被删除会话引用过的二进制附件仍留在 harness home 里。
- **删除不可恢复**，没有回收站。
- **产品允许归档一个正在运行的会话**（侧栏的归档动作没有任何拦截），这会让它在隐形状态下
  继续消耗 token。归档架里的**运行中**徽标就是用来发现这种情况的。

## 开发

```sh
npm test        # 零依赖；直接驱动发布的这两个产物
```

测试会把宿主半当 ESM 模块导入、按客户端加载器的方式求值浏览器半，并用一个极简 React 替身
渲染出行，从而断言徽标、按钮禁用与失败文案的行为。

改代码前值得知道的两条不变量：

1. **浏览器 bundle 的模块 id 必须等于包名**（`registration.id === manifest.name`）——
   loader 按这个名字查工厂；两者漂移时测试会失败。
2. **宿主半不解析任何裸模块名**，只 import `node:` 内置模块，其它能力全靠注入的服务。
   这正是它能待在 harness 仓库之外却仍能加载的原因。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
