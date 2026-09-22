# 地点 GPS 库

文件：`places.sqlite`

## 覆盖范围

已收录**中国大陆 + 港澳**全部：

| 级别 | 说明 |
|------|------|
| 省 / 直辖市 / 自治区 | 全量 |
| 地级市 | 全量 |
| 区 / 县 / 县级市 | 全量（区县中心点） |

台湾省在公开区划源中无下级边界，库内另补台北、高雄、台中、台南、新北等主要城市。

数据源：阿里云 DataV 行政区划中心点坐标。

## 匹配规则

相册「地点」文本 → GPS：

1. 区县优先于市、省  
2. 更长名称优先  
3. 带上级地名时参考上下文（如「北京市朝阳区」）

## 自行增补

```sql
INSERT INTO places(name, full_name, level, adcode, parent_adcode, lat, lng)
VALUES ('自定义镇', '某省某市自定义镇', 'district', NULL, NULL, 30.12, 120.34);
```

重建全库（需联网）：

```bash
PYTHONPATH=.vendor python3 scripts/seed_places.py
```
