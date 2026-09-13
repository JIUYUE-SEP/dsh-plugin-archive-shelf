# dsh-plugin-archive-shelf

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 用的**归档架**。

DSH 的会话可以归档，但产品没有回程票：侧栏菜单只能把它藏起来，没有取消归档入口，
也没有办法删除会话日志。这个插件补上这一页：列出**所有已归档会话**，并给出缺的那几个动作：
还原、排队删除（可取消）、以及在有宿主支持时的即时释放。

[English](README.md) | 中文

## 你会得到什么

设置 → **归档架**（在「Agent 预设」下面那一栏）：

- 每条已归档会话的**标题**、工作区、目录、归档时间与磁盘占用；
- **还原** —— 把它从归档集合里移除，会话**回到侧栏原来的位置**（归档从不改动它的工作区槽位）；
- **彻底删除** —— 二次确认后删除会话日志目录、投影缓存与工作区记账。不可恢复；
- **排队删除 / 取消排队** —— 给删不掉的会话（运行中或已载入）排一个队，
  下次启动 `dsh` 时自动删除；**随时可以取消**，取消后什么都不会发生；
- **释放** —— 仅当你的 DSH 带 `agents.release(id)` 能力时出现（见下），
  点一下把会话的运行实例卸载掉，于是不用重启就能立刻删除它；
- 每行状态徽标：**运行中**（agent 正在跑一轮）/ **已载入**（常驻在宿主进程内存里）/
  **已排队**（下次启动时删除）；
- **清理** —— 清掉那些磁盘上已经没有对应会话的失效归档记录。

### 排队删除意味着什么

排队**不会**立刻删任何东西，它只是记下你的意图：

- 队列存在 harness home 下的 `.archive-shelf/pending.json`（会话根目录的上一级），重启后仍在；
- 兑现只发生在**下次启动 `dsh` 之后**（启动后几秒的清扫）；**读取或刷新归档架永远不会删任何东西**，
  所以"排队"和"删除"是两件分开的事。清扫时若会话仍在常驻/运行中，条目会留到再下一次启动；
- 排队中的行显示**已排队**徽标与**取消排队**按钮；取消是幂等的，点错一次不会有任何后果；
- 如果你在排队后又**还原**了这个会话，队列条目会被丢弃，绝不会删掉一个你已恢复的会话。

### 关于「释放」按钮

会话一旦在宿主进程里被载入，就再也没有公开的卸载入口 —— 这是 DSH 当前的形态
（`agents` 服务没有按 id 释放的方法，创建者拿到的那份 `dispose` 句柄被丢弃了）。
所以插件的做法是**能力探测**：

- 你的 DSH 若提供 `agents.release(id)`，列表接口会报 `canRelease: true`，
  行上出现**释放**按钮：`释放 → 该会话不再常驻 → 立刻可删`，全程不用重启；
- 没有这个能力时按钮**不会出现**（而不是点了报错），队列删除照常可用。

这份宿主侧能力目前**不在上游 DSH 里**。需要它就得给自己的 DSH 打补丁
（源码装改 `packages/core/agent`，npm 装用 `pnpm patch`），或者等它被上游接受。

## 让「释放」按钮出现（可选：给宿主打补丁）

补丁随仓库提供：`patches/host-release.patch`（只动 `packages/core/agent` —— 保留 agent
handle 的 dispose 能力，并加一个按 id 释放的 `release(id)`，外加一个 161 行的测试）。

```sh
cd /path/to/deepseek-harness
git apply /path/to/dsh-plugin-archive-shelf/patches/host-release.patch
pnpm exec tsc -b packages/core/agent && pnpm --filter @deepseek-ai/dsh-agent exec tsdown
# 然后重启 dsh：归档架里常驻的行就会多出「释放」按钮
```

- **升级 DSH 之后补丁可能被冲掉，或被 `git pull` 拒绝。** 冲突时先
  `git checkout -- packages/core/agent` 再 `git apply` 一次即可，改完必须重新构建并重启。
- **npm 安装的 DSH 不能直接套用这份补丁**：那里拿到的是编译后的 `lib/`，需要用
  `pnpm patch @deepseek-ai/dsh-agent` 做等价改动（改动语义相同，落点不同）。
- 想让所有人默认用上，正确做法是把它提到上游 PR —— 补丁本身就是为这个准备的。

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

## DSH 升级后的自检

这份插件补的是产品明确没有的能力（归档是单向的、没有会话删除入口、没有卸载会话的 API），
所以它必然要碰一些**没有被承诺**的东西：workspace registry 的私有 `setState`、会话日志的磁盘布局、
以及宿主补丁提供的 `agents.release(id)`。升级 DSH 之后，花一分钟走一遍：

```sh
cd /path/to/dsh-plugin-archive-shelf && npm test   # 客户端 32 项 + 宿主 98 项：先看上游改动有没有撞坏契约
```

1. 重启后打开 **设置 → 归档架**：列表能出、徽标（运行中 / 已载入 / 已排队）正确、没有报错条；
2. 挑一条不重要的归档会话点**还原** —— 它应回到侧栏原位（验证 `setState` 还在）；
3. 挑一条不要的会话**彻底删除** —— 目录消失，且侧栏不留打不开的残行；
4. 看「已载入」的行上有没有**释放**按钮。没有就是宿主补丁被升级冲掉了，
   按上一节重新 `git apply` + 重建 + 重启即可（此时功能会自动降级为排队删除）。

失败应该是**响亮**的：拿不到私有 API、路径对不上、读不到会话列表快照时，插件一律**拒绝**并写出原因，
不会猜着删。真报错的话，把归档架里那句话连同 `npm test` 的输出一起提 issue。

## 实现方式

**没有构建步骤**：两半都是纯 JavaScript，直接随包发布。

- **`lib/index.js`（宿主半）** —— 一个 Cordis 插件，注入 `workspaceRegistry`、
  `sessionPersistence`、`webServer`；注册一条同源 JSON 路由（`POST /archive-shelf/api`），
  实现 `list` / `unarchive` / `delete` / `forget` / `queue` / `unqueue` / `release` 七个操作。
  删除直接用 `node:fs` —— 宿主插件就是普通 Node 代码，不需要任何沙箱提权。
  队列是本插件自己的状态，写在 `<harness home>/.archive-shelf/pending.json`，
  写入走"临时文件 + rename"，避免半截文件。
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
- **常驻或运行中的会话不能直接删。** 宿主进程已载入的会话把日志握在内存里；删掉磁盘文件会留下
  "活着的会话 + 没有落盘记录"（宿主每次追加都按路径重开日志文件，删了目录要么报错、要么重建出
  一份残档）。这类行有两个出口：**排队删除**（可取消，下次启动时兑现），
  或在你打了宿主补丁的机器上**释放**后立刻删除。
- **排队删除要等下一次启动。** 队列的目标就是跨进程：队列里的会话在启动清扫或下次打开归档架时
  被真正删除。若某次清扫时它又常驻了（比如你刚打开过它），它会继续留在队列里等下一轮。
- **「释放」需要宿主侧支持。** 见上文；没有这个能力的 DSH 上按钮不会出现，功能自动降级为排队。
- **不删附件。** 被删除会话引用过的二进制附件仍留在 harness home 里。
- **删除不可恢复**，没有回收站。
- **产品允许归档一个正在运行的会话**（侧栏的归档动作没有任何拦截），这会让它在隐形状态下
  继续消耗 token。归档架里的**运行中**徽标就是用来发现这种情况的。

## 开发

```sh
npm test        # 零依赖；两个套件：契约/渲染 + 宿主行为
```

- `test/plugin.test.mjs` 把宿主半当 ESM 模块导入、按客户端加载器的方式求值浏览器半，
  并用一个极简 React 替身渲染出行，断言徽标、按钮可见性与禁用理由、失败文案，
  以及每个按钮真正发出的那个请求；
- `test/host.test.mjs` 用假 Cordis 上下文 + 真 loopback HTTP 服务驱动真的 `apply()`，
  在临时目录里真删真写：路径逃逸、超大请求体、运行中/常驻拒绝、队列的排队/取消/跨重启兑现、
  释放能力的三种结果、以及降级服务组合。**88 项检查，0 失败。**

改代码前值得知道的两条不变量：

1. **浏览器 bundle 的模块 id 必须等于包名**（`registration.id === manifest.name`）——
   loader 按这个名字查工厂；两者漂移时测试会失败。
2. **宿主半不解析任何裸模块名**，只 import `node:` 内置模块，其它能力全靠注入的服务。
   这正是它能待在 harness 仓库之外却仍能加载的原因。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
