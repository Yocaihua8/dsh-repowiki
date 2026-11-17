# DSH 仓库维基（dsh-repowiki）

0.7.8 · DSH 0.2.1-rc.4 / 0.2.1-rc.5 / 0.2.2-rc.1 · Node ≥ 22.19

将本地代码仓库生成为带源码依据的多页 Wiki 和知识卡片。项目总览保留筛选、卡片和列表视图；项目详情采用左侧搜索与可折叠目录、右侧配置 / 进度 / 正文，跟随 DSH 中英文界面和主题。

> 0.7.8：适配 DSH 0.2.2-rc.1 宿主。0.2.2 删除了 `ToolsService.presentAs`（呈现方式改由组合挂载的 native / PTC executor 决定），Wiki 子代理的“只允许自己的工具、按原生方式呈现”统一收敛到 `src/host/tool-scope.ts`，运行时检测旧宿主是否仍有 `presentAs` 再决定调用；生成规则、界面与数据格式未变。依据与验证见 `docs/verification.md`。
>
> 0.7.7：一套 Wiki 支持“使用项目 / 接手开发 / 深入维护”三条阅读路线，共享正文；切换路线不调用模型。新规划按独立主题组织，不再按文件数凑页、按来源数凑图或按引用数补写。旧 Wiki 保留原目录，重新生成后才有路线。图表支持放大、原始尺寸和缩放；引用直接定位到来源代码，目录导航回到正文，阅读目录可收起；任务栏将正文生成与核验状态分开显示。
>
> 以下为历史版本记录；旧版页数、引用与图表配额已由 0.7.7 的主题规划规则替代。
>
> 0.7.6：Wiki 阅读页和知识卡片把有效 ` ```mermaid ` 围栏渲染为 SVG 图表；围栏识别与图类型判定由 Host 质量门禁和客户端渲染入口共用 `src/shared/mermaid.ts`。Mermaid 12.2.0 单独构建为 `lib/client.mermaid.js` 懒加载 chunk，首次遇到图表才下载，不增加面板初始 bundle；颜色取宿主语义 token，深色 / 浅色切换时重绘；语法错误或渲染失败保留原始代码并提示，不影响同页其他内容。导出的 Markdown 仍保留围栏原文，交给支持 Mermaid 的查看器渲染。
>
> 0.7.5：架构/数据/流程/模块页按来源规模要求 1-3 个 Mermaid 关系图，api/config/testing/ops/overview 在材料支持时要求至少 1 个；Host 将无有效图类型的 Mermaid 代码块和图表不足作为软门禁，要求补写后再提交。
>
> 0.7.4：核验子代理可调用只读快照工具重读源码，核验 evidence 只提交 `sourceId + 行号`，由 Host 提取原文；claims 字符串增加未转义引号修复，避免 Qoder Auto 在长 JSON 字符串和行号校正上反复超时。
>
> 0.7.3：核验子代理可按需重读已固定快照；Host 在 quote 可定位时自动校正真实行号，找不到原文时退回并给出可读范围。
>
> 0.7.2：扁平大纲在客户端按客户端/Host/类型/共享模块自动分组；生成中图标加入旋转动画，目录滚动条留槽避免遮挡。
>
> 0.7.1：覆盖矩阵为模块分配目标页数；≥60 文件仓库目标至少 20 页（最多 28），协作规划低于目标会要求按模块职责拆分后重交。
>
> 0.7.0：设置页“本地数据”支持检查旧任务/非当前 Wiki 版本并显式清理；Host 侧仅删除计划候选，默认保留最近任务/版本和当前 revision。
>
> 0.6.9：导出提交前写入崩溃恢复日志与原文件备份；中断后下次导出自动回滚未完成提交，检测到用户后续编辑时拒绝覆盖。
>
> 0.6.8：checkpoint 拆分为 checkpoint.json（结构，≤8 MiB）、evidence.json（≤16 MiB，优先保留已引用证据）、receipts.json（≤4 MiB / 2000 条）和 snapshot.json；旧内联 checkpoint 兼容读取，下次保存自动分片。
>
> 0.6.7：工作区版本检查按 10s 节流；任务轮询按是否运行自适应（运行 1.5s / 空闲 5s）；新增只读默认的本地清理脚本；进度条遵循 reduced-motion。
>
> 0.6.6：扫描/Git/配置读取接入 AbortSignal；导出改为全部暂存后统一提交，写入失败不改变已导出文件。
>
> 0.6.5：角色模型留空时隐藏默认模型的来源副标题，只显示“跟随项目模型”。
>
> 0.6.4：核验子代理超时/重试的迟到提交按最终 checkpoint 判定，避免已完成核验被误报 partial。
>
> 0.6.3：核验提示词直接给出来源行号与原文对照，避免子代理反复纠正行号。
>
> 0.6.2：核验子代理按引用裁剪来源窗口，避免整页来源全文导致核验缓慢。
>
> 0.6.1：核验子代理并发执行、任务时限按页数放宽，角色模型留空时明确显示“跟随项目模型”。
>
> 0.6.0：新任务默认使用逐页子代理（规划/写作/核验可分别配置模型，默认继承项目模型），保留单 Agent 回退；加入覆盖矩阵、页面类型/章节、引用格式归一化、证据并集校验与深度门禁。旧 checkpoint 按单 Agent 恢复。
>
> 0.5.7：wiki_verify 兼容部分模型以 JSON 字符串提交 claims，并修复字符串中未转义引号的解析；其余同 0.5.5。
>
> 0.5.5：生成配置页改为 Qoder 概览式布局（齿轮入口、概览卡、全宽再生成按钮），保留原配置表单；可直接选择 Connect Router 的模型分组（包括需在 Router 中显式启用的 `Qoder Auto（实验）`）。Router 的 pin 续接、`toolArguments: lenient` 与可操作错误提示需 Connect Router 1.2.2 及以上；更早的 Router 仍可使用普通分组，但长工具回合可能被账号刷新或工具参数校验中断。
>
> 0.5.0：DSH 专用后台 Agent 自主规划目录与页数，先显示完整目录，再逐篇解锁阅读。保留原生总览、侧栏和组件。

## 使用

1. 在 DSH「仓库维基」选择项目，点击「去生成」。
2. 选择生成语言和模型。首次跟随 DSH 默认模型，也可为每个项目固定模型及其支持的思考强度；规划和正文共用这个模型。可刷新模型列表；指定模型不可用会报错，不会静默切换。
3. 按需开启自动更新、自动导出，默认均关闭。非 Git 项目不能开启提交更新；没有可读源码 / 文档时禁止生成。页面和卡片数量由 Agent 按实际项目主题决定，无人工页数设置。
4. 点击「开始生成」。任务由 Host 执行，离开页面、刷新、最小化不会取消；重新进入会恢复任务状态。全局串行执行，同项目去重，其他项目排队。可暂停、继续、取消，以及重试未完成项；新任务由一个专用 Agent 串行请求模型。
5. 在目录中阅读、搜索标题 / 摘要 / 正文。正文使用 DSH 原生 Markdown，支持表格、代码块、Mermaid 图表和文内导航。Mermaid 图在打开页面时逐图渲染，语法错误会保留原始代码并提示；同一页面多张图互不影响。发布版每页还会带一个「代码结构（Host 生成）」小节：Host 用 TypeScript 编译器 AST 解析该页来源文件，输出代表性函数的控制流图；总览页优先输出符号级调用图（节点是「文件 · 函数」，边是解析后的跨文件调用）。它由代码事实决定、不经模型改写，与模型撰写的关系图分工——后者表达设计意图，前者核对代码结构。`typescript` 为运行时依赖并按需动态加载，加载失败时回退到内置轻量解析器，功能降级但不中断生成。支持 Markdown 源码切换；点击引用进入来源标签页并定位行号。已完成草稿在生成中即可阅读；页面和滚动位置保存在本浏览器会话中。

阶段为源码快照、仓库分析、目录规划、分篇写作、卡片提炼、核验和发布；发布后可选导出。Agent 通过项目范围内的文件列表、全文搜索和按行分页读取自主探索。先提交完整目录，Host 校验标识、层级和来源后展示；待生成页面灰显且不可打开，分组仍可折叠。正文保存后立即可读，不等待卡片或核验。只读材料检索限定在扫描快照内，不执行源码，不允许模型访问任意路径或运行命令。阶段、页数、卡片数、处理中数量、失败项和检查点均来自 Host。

**检查点与恢复**：页面、卡片和核验结果逐项保存。刷新、断开前端不取消任务；暂停中止在途调用，恢复时只处理未完成项。退出或异常终止 DSH 后，运行中任务变为“重启待恢复”，必须手动继续；恢复使用原源码快照、模型和设置。新任务没有 30 分钟总时限，单次模型调用默认 10 分钟；连续三轮没有新增证据或有效成果会保存并暂停。源码版本变化时暂停，恢复必须保持原版本。若想使用最新源码或改模型，请重新生成。

草稿可阅读和搜索；只有全部项目完成后才原子发布。失败、超时和取消保留草稿及上一正式版本；草稿不能导出或自动引用。任务文件不会自动清理。界面与调用方不保活任务，Host 生命周期控制执行。

## 知识卡片与自动引用

按独立知识价值提炼卡片，不强制一页一张，按架构、流程、接口、测试和约束分类，支持搜索、摘要、详情、版本与源码定位。卡片引用必须匹配已保存源码的路径、行号和连续原文；协作生成采用「规则优先、模型兜底」的核验策略：一页写完后，如果行号引用全部落在已读片段内、没有可疑引用、也没有硬性质量问题，Host 直接记录核验结果（标记为 host-rule），不再为该页启动核验子代理；任一条件不成立时回退到模型核验。单 Agent 引擎仍由 Agent 用专用核验工具逐条提交关键结论和来源。Host 校验真实路径、行号、连续原文和内容版本，所有计划正文及卡片均完成核验才允许发布。无法证实的内容标为“待确认”，正文附核验问题；模型核验不是形式化正确性证明，源码仍是依据。

新项目默认开启智能体引用，自动更新和自动导出默认关闭。已有设置缺少引用字段、或只有旧 Wiki 的项目保持关闭，需手动开启；原有更新和导出选项保留。

自动引用通过 DSH `systemPrompt.context` 和 `agent/pre-step` 接入：仅宿主本人、已注册工作区且路径一致的主会话，使用该项目已发布且核验通过的相关卡片。子会话、远程身份、不匹配项目、不可用工作区和不满足宿主执行策略的会话不注入。最多 4 张、6000 字符，提供有限摘要与来源；不自动执行卡片内容。关闭设置会停止后续注入，已有会话历史不会删除。引用记录保存版本、卡片和来源 ID，不保存提问正文。

## Git 增量更新

Host 每 60 秒检查已开启项目的 HEAD。首份 Wiki 仍需手动生成；后续只在提交改变时更新，排队期间的多个提交合并到最新一次。自动任务从确定的 Git 提交读取文件，不读取尚未提交的工作区修改。

Agent 比较上一版本与变化文件，自主规划完整目录。只有全部关联源码均未变化的页面才可经 Host 逐项校验后复用，并仍需核验；新增、删除、重命名和配置变化由 Agent 重新评估主题。目录支持分组和正文节点，不限制三级或 24 页。总览优先介绍定位、入口和导航，各页按职责展开。

切换分支会暂停自动更新，需要完整重新生成。失败或取消后不重复自动请求同一提交；可使用「重试增量更新」。新的提交可以重新触发任务。没有变化以及只提交导出目录时，不调用模型。

## 导出和数据

- Wiki 存储：`$DSH_HOME/dsh-repowiki/wikis/<wikiId>/manifest.json`；正文和只读引用位于 `revisions/<revision>/`。新结果完整写入后原子切换清单，旧版 `pages/*.md` 清单仍可读。
- 检查点：`checkpoint.json`（结构，≤8 MiB）与上一份 `checkpoint.previous.json`；证据、回执、不可变源码分片为 `evidence.json`（≤16 MiB，优先保留已引用证据）、`receipts.json`（≤4 MiB / 2000 条）、`snapshot.json`。旧内联 checkpoint 兼容读取，下次保存自动分片；读取损坏的当前检查点时尝试上一份，不删除原始目录。
- 迁移备份：首次修改设置 / 发布新版本前保留 `*.pre-v3.bak` 和 `*.pre-v5.bak`；旧 Wiki 文件和旧版本仍可读取。
- 引用记录：`references/<wikiId>.json`，最多保留最近 200 次。
- 项目配置：`$DSH_HOME/dsh-repowiki/projects/`，包含语言、模型、开关及自动更新暂停原因；旧 `maxPages` 仅供旧引擎恢复；不保存 API Key。
- 自动导出 / 「导出到项目」：`<项目>/.dsh/repowiki/<zh|en>/README.md`、`page-<pageId>.md`、`knowledge-cards.json`、`.repowiki-export.json`。只管理自己的文件；文件或元信息被人工修改、删除，或出现同名非管理文件时停止覆盖并报告冲突。管理校验记录保存在插件数据目录 `exports/`。
- Mermaid：只在面板阅读时渲染为 SVG；导出和「下载单文件」保留原始 ` ```mermaid ` 围栏，交给支持 Mermaid 的查看器渲染，不把当前主题的渲染结果固化进文档。
- 导出提交前会在插件数据目录写入恢复日志和原文件备份；中断后下次导出先回滚未完成 rename。若发现用户期间编辑了目标文件，恢复会停止并报告冲突，不覆盖人工修改。导出失败不会撤销已保存的 Wiki。「下载单文件」继续提供合并 Markdown 下载，不写项目目录。
- 冲突处理：先保存人工修改，再将整个语言导出目录及对应 `exports/<wikiId>-<语言>.json` 管理记录移到备份位置，然后重新导出。不要直接改管理记录里的摘要。
- 自动导出目录始终排除于扫描，避免更新循环。旧版本目前保留在本地，不自动清理。设置页“本地数据”可先检查可清理项再显式清理（默认保留最近 100 个任务、3 个非当前 revision、30 天内数据）；也可运行 `node scripts/prune-state.mjs`（只读清单），确认后加 `--apply` 并显式指定 `--keep-jobs`/`--keep-revisions`/`--older-than-days`。两者都只删除候选任务目录和非当前 Wiki revision，不删除 project、manifest 或当前 revision。

面板所有 RPC 均校验 owner。扫描遵循嵌套 `.gitignore`，跳过依赖、构建目录、隐藏敏感配置、二进制和符号链接。文件枚举硬上限为 10,000 项（与 Qoder Repo Wiki 口径一致），另有 12 层深度、单文件 8 MiB、总计 256 MiB 的读取预算；每次按行读取最多 250 行 / 48 KiB，可继续分页。10,000 控制「看多少文件」，256 MiB 控制「读多少内容」，两者并存：仓库超过读取预算时先用手工排除规则缩小范围。排除规则写在插件配置（`cordis.patch.yml` 的 `exclude`，.gitignore 语法，最多 200 条），项目设置里的 `exclude` 作为补充叠加在其后，两者合并后生效。快照以 gzip 压缩持久化（`snapshot.json.gz`，兼容旧的未压缩快照）。达到边界会暂停并提示缩小项目范围，不把截断扫描视为完整分析；超大忽略规则会停止扫描，以免遗漏规则。文件行号与摘要来自实际读取内容，标准行号引用必须属于已读取片段（同一文件多段读取按并集计算），否则拒绝保存；Host 自动把覆盖引用的已读片段并入页面来源，未读取范围会在错误中返回具体路径、行号及该文件已读范围。核验错误返回具体文件和范围。模型写作仍需结合引用复核。

## 安装

先完成真实项目和真实模型的隔离验收，再备份 profile 配置及 `$DSH_HOME/dsh-repowiki` 并升级日用环境。实际交付结果见 [验收记录](docs/verification.md)。旧任务保留旧引擎、原始检查点和原 Wiki，不强制转换。

```powershell
$dshCli = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dshCli plugin --profile desktop add '<发布包路径>\dsh-repowiki-0.5.0.tgz' --ignore-scripts
```

插件依赖 `ignore` 7.0.14（MIT）与 `typescript` ^5.8.0（Apache-2.0，按需动态加载用于 AST 解析），由安装器解析。Host / Client 沿用 DSH SDK 与原生组件，没有额外模型进程或前台页面保活要求。Mermaid 12.2.0（MIT）作为构建期 devDependency，被单独打包进 `lib/client.mermaid.js`（5,298,398 字节，约 5.05 MiB；gzip 约 1.44 MiB），只在首次遇到有效图表时由 DSH 模块加载器按需下载；面板初始 `lib/client.js` 保持 336,171 字节（gzip 约 41 KiB）。图表使用 `securityLevel: 'strict'` 和纯 SVG 文本标签，不执行图表内 HTML。

## 会话工具与 RPC

| 工具 | 参数 | 行为 |
|---|---|---|
| `repowiki_generate` | `path`、可选 `mode: generate/update`；或 `cancel: true`、可选 `jobId` | 返回 jobId；优先使用项目模型，否则使用会话模型 |
| `repowiki_status` | 可选 `jobId` | 查询指定任务；省略时保留旧版当前任务语义 |
| `repowiki_list` | 无 | Wiki 清单及任务状态 |
| `repowiki_read` | `wikiId`、可选 `pageId` | 目录或正文 |

保留旧 RPC：`listProjects/startGeneration/getStatus/cancelGeneration/listWikis/readWiki/readPage`。
新增：`getProjectConfig/saveProjectConfig/getModelCapabilities/listJobs/getJob/cancelJob/exportWiki/readSource/searchWiki`。0.4.0 新增 `pauseJob/resumeJob/retryJob/readDraft/readDraftPage/readDraftSource/searchDraft/searchCards/getReferences`。旧工具和 RPC 保持兼容。分页读取和来源读取可附带 `revision`，防止跨版本混读。共享契约见 `src/shared/types.ts`，Typert 自动生成校验。

`cordis.patch.yml` 的 `language` 是新项目默认语言；`pageTimeoutMs` 默认 600000。`maxPages` 与 `totalTimeoutMs` 仅用于旧引擎恢复，不约束新 Agent。模型 ID 原样保存，最大 4096 字符；可搜索模型、来源和套餐，选项及当前选择分行显示，默认模型同时展示实际生效项。

临时 429、网络或服务繁忙优先遵守服务端等待时间，否则依次等待 30 / 60 / 120 秒，最多三次；等待中可暂停或取消。明确额度耗尽、认证失效、工具协议校验失败或重试耗尽会暂停。不会自动换模型、账号或套餐。

新检查点使用 schema 2 / `agent-v1`，保存专用会话 ID、完整目录修订、来源、成果核验及已执行工具回执。重复调用按回执返回；原子写入和上一检查点提供崩溃恢复。旧 schema 1 任务仍按原引擎恢复。

## 开发和验收

```powershell
npm ci
npm run check
npm run check:package
npm pack
# 根目录
npm run test:integration
npm run test:host-compatibility
```

`scripts/acceptance-host.mjs` 支持独立 Host 加载探针和隔离页面验收，使用显式 runtime / home / profile，不修改日用配置。具体证据见 [验收记录](docs/verification.md)，产品与开源依据见 [参考来源](docs/references.md)。


## Public source checkout

Standalone source snapshot with build helpers and shared contracts included. Local runtime data, caches, and internal acceptance reports are excluded; historical links to those reports may not resolve. Use `npm ci`, then `npm run check`. No new binary release is attached.
