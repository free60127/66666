# 回译本 · Back-Translate Studio

一个「真正实时生成」的**回译训练平台**：上传只包含标题、中文译文和英文初稿的 DOCX（或直接粘贴任意中文 + 英文初稿），AI 实时产出标准回译训练作业：

**标题 → 中文译文 → 初稿 → AI 润色版本 → 课文原文 → 详细错误解析与三版本对比**

（拼写 / 语法 / 时态/语态 / 词义 / 搭配 / 语境 / 流畅度 / 地道程度，并按「语域 / 感情色彩 / 语用 / 语义轻重 / 固定搭配 / 内涵外延」六大维度做词汇深度辨析，同时给出近义词对比与地道习语强化）

> AI 润色版本**基于原文但超出原文**——不是简单改错，而是在保留原意与事实的前提下，用更生动、地道、富有文学色彩的方式重新写作；逐句解析会说明 AI 版本比原文好在哪里。

## 特性

- 实时生成，不是预先套好的壳子：任意中文 + 任意英文初稿都能生成完整作业
- 课文模式（自动匹配课次并带入原文）/ 自由模式（无原文也完整分析）
- DOCX 导入：Mammoth 读取 Word 正文，自动识别标题、中文与英文初稿，并匹配课次（匹配结果显示高/中/低置信度与匹配分；低置信度默认走自由模式，可一键改用候选课文）
- 拍照 / 图片识别（OCR）：中文提示与英文初稿两栏各自带「拍照」「导入图片」按钮，电脑端可直接把图片拖进对应栏目；走原生多模态视觉模型逐字转写，印刷体与手写体都能识别，手写体可切「手写体优先」提高分辨率与准确率
- 分项评分与生成进度：结果页展示词汇准确 / 语法时态 / 语境逻辑 / 流畅度 / 地道程度 5 个分项得分条；生成过程显示「已提交 → AI 生成中 → 完成」三步进度与已耗时
- 练习计时器：编辑区计时控件支持「开始计时 / 暂停 / 继续 / 重置」，切换课文自动归零、刷新页面继续计时；点「生成作业」时会把本次用时写进结果页和历史记录，方便对比自己每篇课文花了多久
- **同一课文二次练习对比**：结果页顶部自动找出**上一次练同一课**的记录（按课文标识匹配，老的记录用标题兜底），并列出综合评分变化、必改错误变化、可提升项变化、用时变化，以及「上次的常犯类型这次改掉了吗」（已改掉 / 少了 N 处 / 持平 / 多了 N 处）。没有上一次同课记录时整块不显示；从「历史结果」点开旧作业时只和**比它更早**的那次比，不会拿后来的练习当"上次"
- 润色等级梯度：可选 **小初 / 高考英语 / 四六级 / 考研·专四 / 专八**，AI 润色版（整体 + 逐句）、高级句式、加分表达、以及 findings 里推荐给学生替换的表达，都会匹配该等级的词汇量、句式复杂度、习语密度与篇幅（默认四六级，选择记忆在本机）
- 音标标注：词汇深度辨析里的核心词与近义词都带 IPA 音标（如 spoil /spɔɪl/、ruin /ˈruːɪn/、damage /ˈdæmɪdʒ/、mar /mɑːr/）；模型未返回时后端会尝试词典兜底查询并缓存
- 词根词缀拆解（**四六级及以上等级**）：词汇深度辨析里的难词会多一行小字，拆出词根词缀并给出「核心记忆画面」，例如 **enunciate** = `e-（向外）+ nunci（宣布）+ -ate（动词后缀）` → 「把想法清楚地『送出来、说出来』」，还会附同根词（pronounce / announcement / denounce）；模型会自行判断难易，**小初/高考基础词（go / make / happy 等）不拆**，小初与高考等级完全不输出该内容
- 知识点收藏夹：结果页每条错题/辨析、核心词、习语、**加分表达 / 高级句式**右上角点 ☆ 即可收藏，之后在顶栏「收藏夹」里直接复习，**不用打开整份作业**；支持搜索、按类型筛选、删除、复制全部、以及导出 / 导入 JSON 备份（纯本机实现，不依赖数据库）
- 收藏知识点自测：在收藏夹里选题目数量（5/10/15/20/30/50）一键出题，AI 围绕收藏的考点混搭 **选择 / 填空 / 翻译 / 改错 / 造句** 五种题型；**题目区默认不显示答案、也不显示考点提示（避免提前泄露答案）**，做完点「显示答案」才展开底部的「答案与解析」；支持 **导出 PDF**（答案与解析统一印在最后）、复制题目；AI 不可用时自动用本地题库兜底出题
- AI 原创素材：按主题/难度/文体用 AI 生成无版权英文短文 + 完整中文翻译（如时事、中国文化），可直接作为回译训练题源（回应用户「教材课文有版权、AI 生成文章可商业化」的建议）
- 逐句级解析：每条错误含 from → to 与中文解释，分 error / improve / study 三级；核心动词/形容词/易混词按「语域、感情色彩、语用、语义轻重、固定搭配、内涵外延」六大维度讲透，并附带近义词对比表（word / meaning / register / tone / strength / usage / example）与例句
- 地道习语强化：AI 润色版优先使用符合情境的习语（如 suddenly → out of the blue），并在 findings 与「地道习语强化」板块逐条解释气势、场景与普通说法的差异
- 初稿只标"必须改正的错误"：原稿上用红色底 + 红色下划线标出 level=error 的错误（拼写/标点/语法/时态等），屏幕与打印都保留；纯润色升级（improve/study）不再标线，避免学生误以为整句写错，需要对照时看下方逐句解析
- 打印排版优化：句子卡片可跨页拆分，不再留大片空白
- 多册语料：支持任意册 JSON 语料（见「语料」）
- 高级句式与加分表达：每次作业末尾额外总结可学习的高级句式（倒装/虚拟/非谓语等）与地道加分表达
- 导出 PDF：浏览器打印自动分页（打印样式已针对滚动容器裁剪问题重写）

## 技术栈与架构

- 前端：React + Vite（src/）
- 后端：轻量 Node 服务（server/index.mjs，零依赖，OpenAI 兼容接口代理）
- 语料：public/corpus/new-concept-1-full.json、new-concept-2-full.json、new-concept-3.json、new-concept-4.json
- DOCX：前端使用 Mammoth 读取 Word 正文；旧作业中 AI 修正版、原文、解析等内容会被自动截断

> 纯前端能完成界面、比对、展示与导出；实时 AI 生成必须走后端（API Key 安全 + CORS + 限流），本项目采用轻量本地代理方案。

## 启动

    npm install
    cp .env.example .env      # 填入 AI_API_KEY / AI_BASE_URL / AI_MODEL（任意 OpenAI 兼容接口）
    npm run server            # 后端默认 http://localhost:8787（同时托管打包好的前端）
    # 开发模式另开一个终端：
    npm run dev               # 前端默认 http://localhost:5173，/api 已代理到后端

没有 Key 时可以先点「离线示例」预览界面效果；导出按钮会打开浏览器打印面板，可选择「另存为 PDF」。

## 测试

    npm test          # 账号 52 项 + 同步存储 18 项 + 收藏/SM-2 49 项 + 同课对比 50 项（纯 node，无需外部服务）
    npm run test:auth # 账号服务 Worker 44 项（auth-worker，走本地 D1 垫片）
    node tools/e2e-b6b7.mjs   # 真实浏览器链路 35 项：两次练习对比、收藏复习、跨设备进度合并（自带 mock 模型与后端）

全部是断言脚本（`PASS/FAIL` 逐条打印），失败时退出码非 0，可直接挂 CI。e2e 需要 `tools/shotter/node_modules` 里的 playwright（没装就跳过，不影响 npm test）。

## 环境变量（.env）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| AI_BASE_URL | OpenAI 兼容接口地址 | https://api.deepseek.com/v1 |
| AI_MODEL | 模型名 | deepseek-chat |
| AI_API_KEY | 服务端密钥（不要提交到仓库） | sk-... |
| AI_VISION_MODEL | 拍照/图片识别用的视觉模型（必须支持图片输入；留空时 DeepSeek 路由自动用 `deepseek-flash`） | deepseek-flash |
| AI_VISION_BASE_URL | 视觉模型接口地址（可选，默认与 AI_BASE_URL 相同） | https://api.deepseek.com/v1 |
| AI_VISION_API_KEY | 视觉模型专用 Key（可选，默认与 AI_API_KEY 相同） | sk-... |
| AI_MAX_TOKENS | 单次生成最大输出 token（默认 20000，输出被截断时自动重试更高上限） | 20000 |
| PORT | 后端端口 | 8787 |
| JOB_TTL_DAYS | 任务（批改结果）保留天数 = **分享链接的有效期**（默认 3650 天 ≈ 长期有效；调小可控制存储体积，如 90） | 3650 |

前端「AI 设置」弹窗也可临时填 Base URL / Model / Key（仅存本机 localStorage，发给本地后端）；正式部署请一律用后端 .env。

## 拍照 / 图片识别（OCR）

中文提示与英文初稿两栏都支持三种方式：

1. **拍照**：手机端直接调起相机（电脑上也会尝试打开摄像头，失败则回退到系统选择器）；
2. **导入图片**：从相册 / 文件里选择，支持一次选多张，按顺序识别后合并；
3. **拖入图片**（电脑端）：把图片直接拖到对应的输入框区域。

识别由**原生多模态视觉模型**完成（逐字转写，不翻译、不纠错）：

| 图片内容 | 建议模式 | 说明 |
| --- | --- | --- |
| 印刷体 / 截图 | 自动 或 印刷体优先 | 准确率最高 |
| 英文手写体 | 手写体优先 | 客户端会放到 2400px 并做灰度 + 对比增强 |
| 中文手写体 | 手写体优先 | 尽量写工整、光线充足、让文字填满画面 |

注意：

- **DeepSeek 用户无需额外配置**：最新的 `deepseek-flash` 已原生支持图片输入，DeepSeek 接口下留空「视觉模型」会自动使用它；如果主模型填的是 `deepseek-chat` 这类纯文本模型，后端识别时会自动回退到 `deepseek-flash`。
- 换其他厂商时，把 `AI_VISION_MODEL`（或「AI 设置 → 视觉模型」）填成对应多模态模型，例如 `gpt-4o-mini` / `qwen-vl-max`。
- 图片会上传到你配置的模型服务商用于识别，请勿上传含敏感信息的图片。
- 识别结果会**追加**到对应输入框末尾（输入框为空则直接填入），生成前请先核对。

## 知识点收藏夹（无需数据库）

在作业结果里点每条知识点右上角的 **☆** 收藏，顶栏「收藏夹」随时查看、搜索、按类型筛选，**不用重新打开作业**。收藏内容会连解释、维度、近义词、例句、来源作业一起存下来。

- 实现：纯前端 localStorage（`bt-favorites`），**不需要数据库**；导出/导入为 JSON 文件，方便备份与换设备。
- **间隔重复复习（SM-2）**：每条收藏带 `{ ease, interval, due, reps }` 排期，顶栏「今日待复习 N」把今天该复习的排成队列，一张一张先回想再翻面，三档评分（忘了 / 一般 / 简单）——评分按钮上直接写着下次几天后再见。忘了 → 明天重来并调低难度因子；一般 → 间隔 ×难度因子；简单 → 再 ×1.3 并调高难度因子（上限 365 天）。评分会立刻落盘，配了同步码时**复习进度跟着一起同步**（同一条两端都复习过时，以复习得更新的那份为准，不会互相顶掉）。
- ⚠️ **数据丢失风险**：收藏只存在当前浏览器里——
  - 清除浏览器数据 / 隐私模式关闭 / 重装浏览器 → 丢失；
  - 换浏览器或换设备 → 不同步；
  - **换域名**（`xxx.onrender.com` ↔ 自定义域名）→ 属于不同站点，收藏看不到；
  - Safari 对长时间不访问的站点可能回收脚本存储。
  建议定期用「导出备份」把 JSON 存到网盘，换设备时「导入备份」即可。
- 想要跨设备自动同步，需要后端存储（Postgres/Supabase/Neon 等）＋ 账号体系，属于后续产品化阶段的事。

## 语料（版权说明）

课次列表与课文原文来自 public/corpus/ 下的 JSON 文件。**教材全文受版权保护，仓库不随附语料文件**（.gitignore 已排除）。把自己合法的语料按下面格式放进 public/corpus/（服务端启动时自动加载），没有语料时可直接用「自由模式」：

    {
      "source": "教材文件名.pdf",
      "book": 2,
      "lessons": [
        {
          "lesson": 1,
          "title": "A private conversation",
          "title_cn": "私人谈话",
          "pdf_page": 12,
          "chinese": "上星期，我去看戏……",
          "original": "Last week I went to the theatre. ……"
        }
      ]
    }

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/status | 服务状态、模型、各册语料数量 |
| GET | /api/lessons?book=2 | 课次列表（可省略 book） |
| GET | /api/lessons/2/18 或 /api/lessons/18 | 单课详情（中文 + 原文） |
| POST | /api/match | 按标题/中文匹配课次，返回 `{match, confidence: high/medium/low/none, score, reason}` |
| POST | /api/ocr | 拍照 / 图片识别：提交 `{image(dataURL), side: chinese/english, mode: auto/handwriting/printed, baseUrl, model, apiKey, visionModel?}`，立即返回 `{ok, jobId}` |
| GET | /api/ocr/:jobId | 轮询识别结果：`{ok, job:{jobId, status, data:{text, engine, model, chars, garbled}, error}}`，status 为 pending / running / done / error |
| POST | /api/generate-material | 异步提交 AI 原创素材生成（topic、level、style），立即返回 `{ok, jobId}` |
| GET | /api/generate-material/:jobId | 轮询素材生成状态：`{ok, job:{jobId, status, data?, error?}}`，status 为 pending / running / done / error |
| POST | /api/analyze | 异步提交回译作业（chinese、draft + 可选 book、lessonId、title、original、level、baseUrl、model、apiKey），立即返回 `{ok, jobId}`；level ∈ 小初 / 高考英语 / 四六级 / 考研·专四 / 专八（旧的「考研英语」「专四」会自动归一化为「考研·专四」） |
| GET | /api/phonetic?word=spoil | 查单词 IPA 音标（模型未返回 phonetic 时的兜底，带内存缓存与熔断） |
| POST | /api/quiz | 根据收藏知识点出题：提交 `{points[], count, level, baseUrl, model, apiKey}`，返回 `{ok, jobId}` |
| GET | /api/quiz/:jobId | 轮询自测题：`{ok, job:{jobId, status, data:{title, level, count, questions[{type,question,options,answer,explanation,source}]}, error}}` |
| GET | /api/analyze/:jobId | 轮询作业状态：`{ok, job:{jobId, status, data?, error?}}`，status 为 pending / running / done / error |

所有任务（分析 / 素材 / OCR / 自测题）都会持久化到服务端的键值存储（配了 `UPSTASH_*` 就是云端 Redis，否则是容器本地 `data/kv/`，一条一个键），后端重启、重新部署都不会丢。结果页「复制分享链接」生成 `#job=<jobId>` 链接，**任何人打开都能恢复同一次批改结果**；链接的有效期 = 任务保留期 `JOB_TTL_DAYS`（默认 3650 天 ≈ 长期有效，配了 Upstash 时跨部署持久，链接不会因为发版失效）。前端还会在本机浏览器保存最近 20 条历史记录。

> 分享链接取的是**服务端**那条记录：对方设备上没有你的本机缓存，所以链接一旦超出保留期（或链接被改动）就打不开，页面会明确提示并建议改用「导出 PDF」。当前保留期随时可在 `/api/status` 的 `jobs.ttlDays` 里查到。

`/api/analyze/:jobId` 在 status=done 时 job.data 结构：{ title, chinese, draft, ai, original, aiLevel, overall{score,scoreBreakdown[{label,score,max,comment}],issues,summary,highlights,advice}, sentences[{cn,draft,ai,original,findings[{category,from,to,level,explanation,dimensions,synonyms[{word,phonetic,meaning,register,tone,strength,usage,example}],examples,idiom}]}], vocabularyNotes[{word,phonetic,type,meaning,morphology{parts,image,family},dimensions,synonyms,examples,note}], idiomHighlights, advancedSentences, bonusExpressions }。

### 润色等级梯度

用户可在编辑区选择目标阶段，AI 会据此控制润色版的词汇、句式、习语与篇幅：

| 等级 | 词汇 | 句式 | 习语 |
| --- | --- | --- | --- |
| 小初 | 中考核心词 1500-2000 | 简单句 + 并列句，最多一个基础定语从句 | 0-1 个最基础搭配 |
| 高考英语 | 高考 3500 词及派生词 | 三大从句、非谓语、强调句；少量倒装/虚拟 | 1-2 个常见地道短语 |
| 四六级 | 四六级 5500 词、名词化表达 | 分词状语、with 复合结构、基础倒装 | 1-3 个地道习语 |
| 考研/专四 | 学术书面语域 + TEM-4 约 8000 词级精准用词 | 长难句为主，可并用倒装/虚拟/独立主格/分词 | 2-4 个，克制偏书面 |
| 专八 | TEM-8 高级/文学词汇 | 文学性再创作、修辞与语气控制 | 3-5 个 |

## 导出 PDF

打开作业结果页 → 工具栏「导出 PDF」（浏览器打印）→ 选择「另存为 PDF」。打印样式自动分页：滚动容器不再裁剪、卡片不跨页、详细解析从新页开始。

## 部署到公网（让别人也能打开这个页面）

仓库里的代码在 GitHub 上「只能看、不能运行」。要让别人在浏览器里打开跟你现在一样的界面，需要把项目部署到一台公网服务器。推荐以下方式：

### 方式一：Render 一键部署（免费，最快）

仓库已附带 `render.yaml`（Render Blueprint 配置）：

1. 打开 https://render.com 注册/登录（GitHub 授权）
2. New → **Blueprint** → 选择 `free60127/66666` 这个仓库
3. 部署时填环境变量（可选）：
   - `AI_BASE_URL`（默认 https://api.deepseek.com/v1）、`AI_MODEL`（默认 deepseek-chat）
   - `AI_API_KEY`：**你的** DeepSeek Key；留空就表示让每个使用者在前端「AI 设置」里填自己的 Key
4. 点 Deploy，几分钟后得到类似 `https://back-translate-studio.onrender.com` 的地址

把这个地址发给任何人，打开就是你现在截图里的完整页面（包含两册语料、DOCX 导入、逐句解析）。

> 注意：免费版容器闲置 15 分钟后休眠，**唤醒要约 1 分钟**。前端已内置「正在唤醒服务」提示，
> 不会让用户以为网站坏了。

### 方式二：自己的服务器（国内访问更稳）

    git clone https://github.com/free60127/66666.git && cd 66666
    npm install && npm run build
    PORT=8787 AI_API_KEY=sk-xxx node server/index.mjs   # 或写入 .env 后 npm run server

然后用 PM2 保活、防火墙开放 8787 端口；正式域名建议 Nginx 反代 + HTTPS 证书。

这是**唯一没有冷启动、且数据完全在你自己手里**的方式。前端是纯静态产物，后端零外部依赖，
一台最低配的服务器就够（香港节点免备案，国内直连更稳但要备案）。

### 方式三：前端放 GitHub Pages + 后端留 Render（推荐，免费）

前端是纯静态产物，放 GitHub Pages 可以**秒开**，不再受后端休眠拖累；
后端仍然在 Render 上跑 API。两者不同源，靠跨域白名单打通。

仓库已附带 `.github/workflows/deploy-pages.yml`，步骤：

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**
2. 仓库 **Settings → Secrets and variables → Actions → Variables** 新建一个
   `VITE_API_BASE`，值是后端地址（例如 `https://back-translate-studio.onrender.com`）。
   不建也行，工作流会默认用这个地址
3. push 到 `main`（或手动触发工作流），几分钟后得到
   `https://<用户名>.github.io/<仓库名>/`
4. **⚠️ 最关键的一步**：去 **Render 的环境变量**里加
   ```
   ALLOW_ORIGIN=https://<用户名>.github.io
   ```
   漏了这步的后果很隐蔽：**页面看起来完全正常，课文列表却悄悄退回内置的 3 篇示例**，
   而且控制台不报错（浏览器只是在读取响应时拦掉）。判断方法：页面顶部应显示
   「· 348 课」，没有这个数字就是被拦了。

两种方式（Render 一体部署 / GitHub Pages + Render）用的是**同一份代码**，
差别只在构建时注入的 `VITE_BASE` 与 `VITE_API_BASE`，见 `vite.config.js` 与 `src/api.js` 的注释。

### 公开部署的安全提醒

- **绝对不要把 API Key 写进前端或提交到仓库**（仓库 .gitignore 已排除 .env）。
- 若在 Render 环境变量里填了 `AI_API_KEY`，Key 只存在你的服务器上，别人无需 Key 即可使用；请留意调用量。
- 若留空让使用者自填 Key，该 Key 会随请求先发到你的后端再转发给模型服务商——请只把链接分享给信任的人。
- 前端放到 GitHub Pages 后，**API Key 依然只经过你的后端**，没有任何新增泄露面。

## 说明与声明

- API Key 默认只放服务端 .env；前端设置面板的 Key 仅适合个人本地使用。
- 生产构建：npm run build 后 npm start，后端同时托管 dist/。
- 扫描版 PDF 语料如有个别转写误差，可在对应 JSON 中人工修订。
- 本项目以 MIT 协议开源；语料与教材版权归原作者所有，请自行获取合法数据。AI 生成的分析与润色仅供参考，学习请以教材原文为准。
