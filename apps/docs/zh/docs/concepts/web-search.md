# WebSearch 安全契约

`WebSearch` 只定义可替换的 provider 接口；Volund 默认不配置真实搜索服务，因此未配置 provider 时会关闭失败。仓库中的 `MockWebSearchProvider` 仅用于离线契约测试，不访问网络、不需要 API key，也不会产生服务费用。

每次查询都必须先通过 permission gate。权限请求只包含 provider 标识与脱敏后的 query；执行日志仅记录 query 的短哈希、provider 和结果数量，不记录原始 query、结果正文或凭据。

结果保持 provider 返回顺序，不引入隐藏的跨 provider 排名。数量、单条摘要和总字符数都有上限，并以带来源的 `<untrusted>` 包裹返回；结果中的标签字符会编码，不能提前闭合包裹。此标记用于提示模型把搜索结果当数据而非指令，不能替代 permission、WebFetch 的域名许可或 SSRF 防护。

真实搜索 provider、API key、在线调用与计费均未启用，需单独授权和安全评审。未来 provider 若抓取结果页面，必须复用 WebFetch 的 canonical domain permission、逐跳 DNS 重解析、私网/metadata 地址拒绝、redirect policy 和响应限制，不能直接绕过这些原语。
