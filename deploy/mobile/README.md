# volund 移动站（独立部署）

移动站是纯静态 SPA（apps/mobile 的 Next 静态导出），**与网关解耦**——可以脱离
网关镜像单独部署到任意静态托管（本目录 Docker 镜像 / CDN / 对象存储）。

## 拓扑

```
手机浏览器 → 移动站（本镜像，静态）        ← 只下发页面
           → 网关（deploy/gateway，跨源）  ← 数据面：/pairing/redeem + /v1/* + /v1/ws
```

配套要求（网关侧 `.env`）：

```bash
# 配对二维码/链接指向移动站（不再是网关自身），链接自动携带 &gw=<网关地址>
GATEWAY_MOBILE_PUBLIC_URL=https://m.example.com
GATEWAY_PUBLIC_URL=https://gateway.ai-agentic.cc
# 跨源放行移动站 Origin（REST 预检；WS 不受 CORS 约束）
GATEWAY_CORS_ORIGINS=https://m.example.com
```

## 构建与运行

```bash
# 构建上下文是仓库根
docker build -f deploy/mobile/Dockerfile -t volund-mobile .
docker run -d -p 8080:80 volund-mobile
```

前面挂任意 TLS 终结（Caddy/CDN）即可。不配 TLS 也能跑——配对链接与设备 token
都走网关侧，移动站本身不持有机密。

## 配对流程（独立部署形态）

1. 桌面 Web 控制台「远程控制」tab → 启动服务 → 生成配对码；
   二维码/链接指向 `https://m.example.com/#pair=CODE&gw=<网关地址>`。
2. 手机打开链接：`gw` 参数写入 localStorage（之后免填），配对码自动核销。
3. 手动配对：配对页填「网关地址」（可只填一次，本机记忆）+ 8 位配对码。
4. 设备 token、会话数据全部直连网关；移动站关掉重开凭 localStorage 续期。

同源托管（网关 `VOLUND_MOBILE_ASSET_DIR` 老形态）不受影响：没有 `gw` 参数与
已存地址时，移动站默认回退同源调用。
