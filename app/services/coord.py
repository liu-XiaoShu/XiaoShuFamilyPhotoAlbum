from __future__ import annotations

"""WGS-84 ↔ GCJ-02（国内商业底图常用火星坐标）。"""

import math
from typing import Tuple

_A = 6378245.0
_EE = 0.00669342162296594323


def out_of_china(lat: float, lng: float) -> bool:
    """是否不做 GCJ-02 偏移。

    高德等在港澳台通常按 WGS-84 显示；对这三地做火星坐标偏移会把点甩偏，
    放大后像「没有标记」。
    """
    if not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271):
        return True
    # 台湾
    if 119.3 <= lng <= 122.1 and 21.8 <= lat <= 25.4:
        return True
    # 香港
    if 113.80 <= lng <= 114.45 and 22.15 <= lat <= 22.58:
        return True
    # 澳门
    if 113.52 <= lng <= 113.63 and 22.10 <= lat <= 22.25:
        return True
    return False


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat: float, lng: float) -> Tuple[float, float]:
    """照片 GPS（WGS-84）→ 高德等国内底图坐标（GCJ-02）。境外原样返回。"""
    if out_of_china(lat, lng):
        return lat, lng
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return lat + dlat, lng + dlng
