# AI 教学助手 Electron 版

本目录已经加入独立的纯 Electron / JavaScript 实现。运行与打包均不需要 Python，也不会启动旧 Flask 服务。

## 开发运行

```bash
npm install
npm start
```

首次进入教师端使用默认密码 `admin`，登录后请在“AI 设置”中修改。

## AI 配置

在“AI 设置”中填写：

- OpenAI 兼容 `BaseURL`（例如 `https://example.com/v1`）
- 模型 ID；也可以通过“获取模型列表”读取服务端模型
- API Key
- 可选的学生答案判题模型
- 数学、物理、化学必需的题目复核模型（必须与主模型不同）

API Key 使用本机随机密钥和 AES-256-GCM 加密后保存在 Electron 用户数据目录。

## 教案导入

- 支持 PDF、Word（`.docx`）和 Markdown（`.md` / `.markdown`）
- 单周模式可指定当前教学周
- 整学期模式可指定 1–40 个教学周
- 整学期文件优先识别“第 N 周”标题；没有周标题时按内容量自动拆分
- 扫描版 PDF 不含文本层时，需要先经过 OCR 再导入
- 教师端与学生端均支持 Markdown 和 LaTeX 公式渲染
- 教师可按题型、1–30 题数量及简单 / 中等 / 困难 / 混合难度生成题库
- 数理化题目由主模型提供两种独立解法，另一模型独立验算；复核不通过的候选题不会写入题库

## 局域网服务

程序启动时会直接由 Electron 内置的 Node.js HTTP 服务监听 `0.0.0.0:5000`。端口占用时会自动选择空闲端口。教师端“局域网服务”页会显示可访问地址。

学生端地址：

```text
http://本机局域网IP:5000/student.html
```

可通过环境变量指定端口与数据目录：

```bash
AIAID_PORT=5001 AIAID_DATA_DIR=/path/to/data npm start
```

## 打包

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

安装包输出到 `release/`。macOS 生成 Universal DMG/ZIP，Windows 生成 NSIS/Portable EXE，Linux 生成 AppImage/DEB/RPM；正式跨平台发布由 GitHub Actions 在相应系统的 Runner 上完成。

## 数据

Electron 版数据默认保存在系统的应用用户数据目录，核心文件包括：

- `teaching-data.json`：课程、学生、习题、提交、签到和设置
- `.data-key`：本机加密密钥
- `uploads/`：导入教案和课件资料

旧版 Python/SQLite 数据不会被 Electron 版自动修改。
