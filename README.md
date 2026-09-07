# 回译本 · Back-Translate Studio

一个「真正实时生成」的**回译训练平台**：上传只包含标题、中文译文和英文初稿的 DOCX（或直接粘贴任意中文 + 英文初稿），AI 实时产出标准回译训练作业：

**标题 → 中文译文 → 初稿 → AI 润色版本 → 课文原文 → 详细错误解析与三版本对比**

（拼写 / 语法 / 时态/语态 / 词义 / 搭配 / 语境 / 流畅度 / 地道程度，并按「语域 / 感情色彩 / 语用 / 语义轻重 / 固定搭配 / 内涵外延」六大维度做词汇深度辨析，同时给出近义词对比与地道习语强化）

> AI 润色版本**基于原文但超出原文**——不是简单改错，而是在保留原意与事实的前提下，用更生动、地道、富有文学色彩的方式重新写作；逐句解析会说明 AI 版本比原文好在哪里。

## 特性

- 实时生成，不是预先套好的壳子：任意中文 + 任意英文初稿都能生成完整作业
- 课文模式（自动匹配新概念课次并带入原文）/ 自由模式（无原文也完整分析）
- DOCX 导入：Mammoth 读取 Word 正文，自动识别标题、中文与英文初稿，并匹配课次
- AI 原创素材：按主题/难度/文体用 AI 生成无版权英文短文 + 完整中文翻译（如时事、中国文化），可直接作为回译训练题源（回应用户「新概念课文有版权、AI 生成文章可商业化」的建议）
- 逐句级解析：每条错误含 from → to 与中文解释，分 error / improve / study 三级；核心动词/形容词/易混词按「语域、感情色彩、语用、语义轻重、固定搭配、内涵外延」六大维度讲透，并附带近义词对比表（word / meaning / register / tone / strength / usage / example）与例句
- 地道习语强化：AI 润色版优先使用符合情境的习语（如 suddenly → out of the blue），并在 findings 与「地道习语强化」板块逐条解释气势、场景与普通说法的差异
- 初稿黄色高亮：批改后自动在原稿与逐句行中标出错误 / 不地道表达，屏幕与打印均保留
- 打印排版优化：句子卡片可跨页拆分，不再留大片空白
- 多册语料：支持任意册 JSON 语料（新概念 1 / 2 / 3 / 4 册，见「语料」）
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

## 环境变量（.env）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| AI_BASE_URL | OpenAI 兼容接口地址 | https://api.deepseek.com/v1 |
| AI_MODEL | 模型名 | deepseek-chat |
| AI_API_KEY | 服务端密钥（不要提交到仓库） | sk-... |
| AI_MAX_TOKENS | 单次生成最大输出 token（默认 20000，输出被截断时自动重试更高上限） | 20000 |
| PORT | 后端端口 | 8787 |

前端「AI 设置」弹窗也可临时填 Base URL / Model / Key（仅存本机 localStorage，发给本地后端）；正式部署请一律用后端 .env。

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
| POST | /api/match | 按标题/中文匹配课次 |
| POST | /api/generate-material | 生成 AI 原创训练素材（topic、level、style；返回 title/original/chinese/keywords） |
| POST | /api/analyze | 生成回译作业（chinese、draft + 可选 book、lessonId、title、original、baseUrl、model、apiKey） |

/api/analyze 返回结构：{ title, chinese, draft, ai, original, overall{score,issues,summary,highlights,advice}, sentences[{cn,draft,ai,original,findings[{category,from,to,level,explanation,dimensions,synonyms,examples,idiom}]}], vocabularyNotes, idiomHighlights, advancedSentences, bonusExpressions }。

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

> 注意：免费版容器闲置后会休眠，别人第一次打开可能要等 30~60 秒唤醒。

### 方式二：自己的服务器（国内访问更稳）

    git clone https://github.com/free60127/66666.git && cd 66666
    npm install && npm run build
    PORT=8787 AI_API_KEY=sk-xxx node server/index.mjs   # 或写入 .env 后 npm run server

然后用 PM2 保活、防火墙开放 8787 端口；正式域名建议 Nginx 反代 + HTTPS 证书。

### 方式三：GitHub Pages（只能静态预览，不能生成 AI）

GitHub Pages 只能托管前端静态文件，没有任何后端，因此「AI 生成/课文匹配」功能不可用，仅可看界面与「离线示例」。适合做演示页，不推荐作为正式使用方式。

### 公开部署的安全提醒

- **绝对不要把 API Key 写进前端或提交到仓库**（仓库 .gitignore 已排除 .env）。
- 若在 Render 环境变量里填了 `AI_API_KEY`，Key 只存在你的服务器上，别人无需 Key 即可使用；请留意调用量。
- 若留空让使用者自填 Key，该 Key 会随请求先发到你的后端再转发给模型服务商——请只把链接分享给信任的人。

## 说明与声明

- API Key 默认只放服务端 .env；前端设置面板的 Key 仅适合个人本地使用。
- 生产构建：npm run build 后 npm start，后端同时托管 dist/。
- 扫描版 PDF 语料如有个别转写误差，可在对应 JSON 中人工修订。
- 本项目以 MIT 协议开源；语料与教材版权归原作者所有，请自行获取合法数据。AI 生成的分析与润色仅供参考，学习请以教材原文为准。
