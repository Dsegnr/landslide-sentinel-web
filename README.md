# 边坡哨兵 · 多传感器监测与分级预警 Web

React / TypeScript + FastAPI 的监测与预警可视化项目。比赛已结束，现公开 Web 工程快照供技术展示。

## 在线演示

演示地址：https://substance-searched-fish-responding.trycloudflare.com

普通演示账号：`monitor`

密码：`qAK3vrb_oOrhDuJZjH2U`

此账号仅供浏览演示；管理密钥和设备接入令牌不公开。

## 已实现的工程功能

- 多通道监测过程线、历史查询、预警等级与来源标识。
- 当前状态与未来风险展示，区分硬件通道和外部水文数据。
- 三维坡体与地形约束情景展示、地图、天气参比。
- 设备通信、数据完整性、实时推送及轮询恢复。
- 普通用户浏览与独立管理权限，管理操作审计。

本人承担数据与算法分析、预警可视化、Web 系统开发及相关材料整理；团队硬件工作与第三方基础组件不归为本人独立成果。

## 本地运行

需要 Python 3.12、Node.js 与 npm。以下使用独立本地 SQLite，不连接演示数据库。

```powershell
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env，为本地 JWT、普通用户及管理员分别设置配置。
.venv/Scripts/python -m uvicorn main:app --host 127.0.0.1 --port 8081
```

另开终端：
```powershell
cd frontend
npm ci
npm run dev
```

打开 http://localhost:5173 。账号来自自己的 backend/.env，线上演示口令不等于本地口令。

```powershell
# 前端测试与构建
cd frontend
npm test
npm run build
# 后端鉴权测试，在独立测试 SQLite 中运行
cd ../backend
python tests/test_auth.py
```

## 数据与研究边界

本仓库不附带数据库、现场照片、在线地图瓦片缓存、大型科研数据、模型参数、论文稿件、未发表实验协议、知识库或生产凭据。必要的固定演示场景与地形派生文件已附带，来源及许可边界见 [资源说明](docs/ASSETS.md)。部分影像与预测功能需要另行配置具有使用权的素材和模型；本地源码版不等同于完整线上部署副本。缺少模型时不应将占位状态理解为真实预测。

已发布数据成果见 [ScienceDB / DOI 10.57760/sciencedb.014lj](https://doi.org/10.57760/sciencedb.014lj)，王佳豪为第一位作者；原始观测来自数据记录列明的上游来源，并非均由本人采集。数据集公开不等于论文发表，论文修订和后续研究继续私有保留。

预警研究针对明确协议下的变形事件；地形情景并非经岩土标定的动力学预测。本项目不构成现场灾害预报或安全保证。

## 代码来源与发布记录

Web 骨架参考团队 [XINGTU](https://github.com/Talent-Star-Map/XINGTU)，使用 React、FastAPI、Three.js、Leaflet、ECharts 等第三方组件，各自权利与许可证保持。此仓库为源码公开展示，尚未另行授予覆盖所有代码和素材的统一开源许可证。

本次从本地 Web 工作区按白名单创建全新历史，不公开旧私有仓库的研究文件与历史。文件哈希见 [发布清单](docs/release-manifest.json)。当前检查结果见 [验证记录](docs/VALIDATION.md)。
