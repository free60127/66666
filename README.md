# 回译本 · Back-Translate Studio

一个「真正实时生成」的**回译训练平台**：上传只包含标题、中文译文和英文初稿的 DOCX（或直接粘贴任意中文 + 英文初稿），AI 实时产出标准回译训练作业：

**标题 → 中文译文 → 初稿 → AI 润色版本 → 课文原文 → 详细错误解析与三版本对比**

（拼写 / 语法 / 时态 / 词义 / 搭配 / 语境 / 流畅度 / 地道程度）

> AI 润色版本**基于原文但超出原文**——不是简单改错，而是在保留原意与事实的前提下，用更生动、地道、富有文学色彩的方式重新写作；逐句解析会说明 AI 版本比原文好在哪里。

## 特性

- 实时生成，不是预先套好的壳子：任意中文 + 任意英文初稿都能生成完整作业
- 课文模式（自动匹配新概念课次并带入原文）/ 自由模式（无原文也完整分析）
- DOCX 导入：Mammoth 读取 Word 正文，自动识别标题、中文与英文初稿，并匹配课次
- 逐句级解析：每条错误含 from → to 与中文解释，分 error / improve / study 三级
- 多册语料：支持任意册 JSON 语料（默认新概念第 2 册 / 第 3 册，见「语料」）
- 导出 PDF：浏览器打印自动分页（打印样式已针对滚动容器裁剪问题重写）

## 技术栈与架构

- 前端：React + Vite（src/）
- 后端：轻量 Node 服务（server/index.mjs，零依赖，OpenAI 兼容接口代理）
- 语料：public/corpus/new-concept-2-full.json、public/corpus/new-concept-3.json
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
| POST | /api/analyze | 生成回译作业（chinese、draft + 可选 book、lessonId、title、baseUrl、model、apiKey） |

/api/analyze 返回结构：{ title, chinese, draft, ai, original, overall{score,issues,summary,highlights,advice}, sentences[{cn,draft,ai,original,findings[{category,from,to,level,explanation}]}] }。

## 导出 PDF

打开作业结果页 → 工具栏「导出 PDF」（浏览器打印）→ 选择「另存为 PDF」。打印样式自动分页：滚动容器不再裁剪、卡片不跨页、详细解析从新页开始。

## 说明与声明

- API Key 默认只放服务端 .env；前端设置面板的 Key 仅适合个人本地使用。
- 生产构建：npm run build 后 npm start，后端同时托管 dist/。
- 扫描版 PDF 语料如有个别转写误差，可在对应 JSON 中人工修订。
- 本项目以 MIT 协议开源；语料与教材版权归原作者所有，请自行获取合法数据。AI 生成的分析与润色仅供参考，学习请以教材原文为准。
