# 上行质量卡片的统计口径

2026-11-25：修正 datad 网页与 Android App 的上行统计显示。App 原先解出了 B881 上行新传／重传计数，但没有更新卡片；网页已有详情计数，主卡仍固定显示 `UL —`。

主卡现在显示 `UL 重传16.2%`。数值取已支持并通过抓包回归的 B881 3.1 计数：

`累计上行重传率 = 重传 TB / (新传 TB + 重传 TB) × 100%`

主卡保留一位小数，详情保留两位小数及新传／重传 TB、字节和调度计数。总 TB 为零时显示“重传待统计”；没有可用上行报告时显示“未上报”。真实小区变化清理旧统计，缺省元数据补齐不清空。重复报告替换当前快照，不累加累计计数。

这项指标不是基站 CRC 结果，也不等同首传 BLER。当前支持的这类报告没有已核验的上行 ACK／NACK 计数或直接 BLER 字段，因此详情中的“上行 BLER”明确标为未直接上报；不把上行重传率改名为 BLER。下行 BLER 继续采用原有 PDSCH CRC 统计。MCS 仍区分上下行，上行取已解析的有效 grant。

本地回归样本：`tests/fixtures/uplink-tb-counts.json`（来自用户提供的 SDX62 抓包，只保留两条 B881，不含 NAS）。Android 同源样本位于 `app/src/test/resources/uplink-tb-counts.json`。

术语参考：[MobileInsight 的 NR MAC UL TB Stats 源码](https://github.com/mobile-insight/mobileinsight-core/blob/master/dm_collector_c/nr_mac_ul_tb_stats.h)分别列出新传与重传 TB 字段。该外部实现的 2.x 布局只用于核对字段含义，本项目没有将它的偏移套用到 3.1。
