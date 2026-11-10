# 演示资源与来源

- `frontend/public/terrain/*`：演示地形与派生网格。元数据标注 AWS Terrain Tiles / Terrarium、公有领域；保留各坡体 JSON 内 source、范围与高程字段。网格是展示派生物，不是滑坡动力学标定结果。
- `*-osm.json`：OpenStreetMap 道路派生数据。© OpenStreetMap contributors，依据 ODbL 使用，来源：https://www.openstreetmap.org/copyright 。本文件不为原始数据另行授予许可。
- `frontend/public/geo/china-full.json`：原项目用于省份定位的 GeoJSON。其上游许可尚未在当前发布工作中独立确认，暂不对该文件授予统一开源许可；使用者需自行核实上游权利。
- `presentation-scenes-*.json`：系统固定演示场景快照，含当时展示曲线和固定等级，不能作当前实测风险或论文独立验证数据。仅用于重现公开演示，不包含模型训练参数或研究协议。
- 不附带现场照片、缩略图、视频、后台上传文件与私有数据库；在线演示有些媒体因此不会包含于源码包。
