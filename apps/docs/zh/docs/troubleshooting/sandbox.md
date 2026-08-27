# 沙箱问题

运行 `volund doctor --strict` 并阅读返回的 tier、机制和限制。缺少对应平台原生包或内核能力不足会降低安全等级；严格模式会以状态码 3 退出，而不是静默接受降级。

不要使用 `--dangerously-no-sandbox` 让发布测试通过。应记录 target、已脱敏的探测输出和 escape suite 比率，并从 release notes 链接对应的修复 Issue。
