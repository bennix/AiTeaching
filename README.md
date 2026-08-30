# AI 教学助手

AI 教学助手是一套纯 Electron / Node.js 实现的桌面教学平台。教师可以导入一个教学周或整学期的 PDF、DOCX、Markdown 教案，按指定周数组织内容，并通过局域网向学生提供学习、签到、练习和反馈服务。

> 本仓库发布的应用不依赖 Python，也不包含原项目的 Python 实现。

## 核心能力

- 自定义 OpenAI 兼容 `BaseURL`，获取并选择模型，可单独指定判题模型
- 接受 PDF、DOCX、MD / Markdown 教案
- 支持单教学周导入，也支持整学期导入并指定 1–40 个教学周
- 教师端与学生端统一渲染 Markdown、行内 LaTeX 和块级 LaTeX
- 教师可按章节分别指定题型（选择题、简答题、实践/应用题）、各类型题量（合计 1–30）和难度；只有编程类教案才会生成代码或调试题
- 完整保留教师端：教案、题库、课件、学生、班级资料、签到、报告、邮件和 AI 设置
- 完整保留学生端：周次学习、资料、签到、答题、AI 批改、历史与学习诊断
- 内置 Node.js 局域网服务，学生只需浏览器，无需安装客户端
- API Key 使用 AES-256-GCM 加密后保存在教师电脑

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm ci
npm start
```

首次进入教师端使用默认密码 `admin`，进入后请立即在设置中修改。局域网地址会显示在“局域网服务”页面。

## AI 接口

应用兼容常见的 OpenAI Chat Completions 接口：

- 模型列表：`GET {BaseURL}/models`
- 对话：`POST {BaseURL}/chat/completions`

如果填写的 BaseURL 已经以 `/chat/completions` 结尾，应用会自动处理路径，不会重复拼接。

## 测试

```bash
npm test
npm audit --omit=dev
```

## 安装包

```bash
npm run dist:mac    # Universal DMG + ZIP
npm run dist:win    # NSIS 安装版 + Portable EXE
npm run dist:linux  # AppImage + DEB + RPM
```

GitHub Actions 会在推送 `v*` 标签时并行构建安装包并创建 GitHub Release。macOS 任务强制要求 Developer ID 签名和 Apple 公证；Windows 任务强制要求可信 Authenticode 证书，不会用自签证书冒充正式签名。

### Release Secrets

| Secret | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | Base64 或可下载 URL 形式的 Developer ID `.p12` |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | Apple Account 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `WIN_CSC_LINK` | Windows Authenticode `.pfx` / `.p12` |
| `WIN_CSC_KEY_PASSWORD` | Windows 证书密码 |

## Landing Page

静态站点在 [`landing`](landing) 目录。推送到 `main` 后，Pages 工作流会发布到：

<https://bennix.github.io/AiTeaching/>

## 数据与网络

教师端服务默认监听本机的所有 IPv4 网络接口，以便同一局域网的学生访问。课程数据、学生名单、作答记录和签到记录均保存在教师电脑的应用数据目录；只有调用教师配置的 AI 接口或 SMTP 服务时，相关请求才会发往对应服务。
