<script setup>
// VolundScene — Three.js 轨道场，hero 右侧视觉层。
// 构图：酸性绿太阳核心（右上，避开终端卡片）+ 反向线框壳 + 三层倾斜轨道环
// （环上挂发光节点，异速自转）+ 放射数据射线 + 沿轨道流动的数据光点 + 远景星尘。
// Three 走动态 import 分包；首帧渲染前由 CSS 光环兜底。
// prefers-reduced-motion：渲染单帧完整构图的静态画面，停循环动画与视差。
import { onBeforeUnmount, onMounted, ref } from 'vue'

const host = ref(null)
const canvas = ref(null)
const ready = ref(false)

let teardown = () => {}
let reducedMotion = false

onMounted(async () => {
  if (!canvas.value) return
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    teardown = await initScene(
      host.value,
      canvas.value,
      () => {
        ready.value = true
      },
      reducedMotion,
    )
  } catch (error) {
    // WebGL 不可用：保留 CSS 光环兜底层
    console.warn('[volund-scene] WebGL init failed, static fallback stays.', error)
  }
})

onBeforeUnmount(() => teardown())

function makeGlowTexture(THREE) {
  const size = 256
  const offscreen = document.createElement('canvas')
  offscreen.width = size
  offscreen.height = size
  const ctx = offscreen.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.22, 'rgba(255, 255, 255, 0.6)')
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.18)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(offscreen)
}

async function initScene(hostEl, canvasEl, markReady, isReducedMotion) {
  const THREE = await import('three')

  const palette = () => {
    const dark = document.documentElement.classList.contains('dark')
    return dark
      ? {
          core: '#c6ff5e',
          shell: '#2bbd9b',
          ring: '#2bbd9b',
          node: '#e2ffa0',
          dustA: '#2bbd9b',
          dustB: '#eef9d8',
          ray: '#a8e04d',
          ringOpacity: 0.5,
          dustOpacity: 0.9,
          glowOpacity: 1,
          rayOpacity: 0.2,
        }
      : {
          core: '#147a69',
          shell: '#4a7009',
          ring: '#147a69',
          node: '#0f6759',
          dustA: '#7ba916',
          dustB: '#aab39b',
          ray: '#6d9a10',
          ringOpacity: 0.6,
          dustOpacity: 0.6,
          glowOpacity: 0.75,
          rayOpacity: 0.28,
        }
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 160)
  camera.position.set(0, 0.4, 20)

  const disposables = []

  // --- 太阳核心（右上偏移，避开左下终端卡片） + 反向线框壳 ---
  const CENTER = new THREE.Vector3(3.2, 1.8, 0)
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.9, 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(palette().core) }),
  )
  core.position.copy(CENTER)
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2.9, 1),
    new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.4 }),
  )
  shell.position.copy(CENTER)
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(THREE),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  glow.position.copy(CENTER)
  glow.scale.setScalar(15)
  scene.add(core, shell, glow)
  disposables.push(
    core.geometry,
    core.material,
    shell.geometry,
    shell.material,
    glow.material,
    glow.material.map,
  )

  // --- 轨道环（绕核心） + 环上节点 ---
  const orbit = new THREE.Group()
  orbit.position.copy(CENTER)
  scene.add(orbit)
  const ringSpecs = [
    { radius: 5.6, tilt: 1.22, spin: 0.12, nodes: 3 },
    { radius: 8.2, tilt: 1.5, spin: -0.075, nodes: 4 },
    { radius: 11.2, tilt: 1.02, spin: 0.05, nodes: 5 },
  ]
  const nodeGlowTexture = makeGlowTexture(THREE)
  const nodeMeshes = []
  const ringMeshes = []
  for (const spec of ringSpecs) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(spec.radius, 0.022, 8, 220),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: palette().ringOpacity }),
    )
    ring.rotation.x = spec.tilt
    ring.userData.spin = spec.spin
    orbit.add(ring)
    ringMeshes.push(ring)
    disposables.push(ring.geometry, ring.material)

    for (let i = 0; i < spec.nodes; i += 1) {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 14, 14),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(palette().node) }),
      )
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: nodeGlowTexture,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          opacity: 0.95,
        }),
      )
      halo.scale.setScalar(1.4)
      const angle = (i / spec.nodes) * Math.PI * 2 + spec.radius
      node.position.set(Math.cos(angle) * spec.radius, Math.sin(angle) * spec.radius, 0)
      node.add(halo)
      ring.add(node)
      nodeMeshes.push(node)
      disposables.push(node.geometry, node.material, halo.material)
    }
  }
  disposables.push(nodeGlowTexture)

  // --- 放射数据射线（扁平圆盘方向，绕核心） ---
  const rayPositions = []
  for (let i = 0; i < 64; i += 1) {
    const theta = Math.random() * Math.PI * 2
    const phi = (Math.random() - 0.5) * 0.75
    const r0 = 3.6
    const r1 = r0 + 4 + Math.random() * 8
    rayPositions.push(
      Math.cos(theta) * Math.cos(phi) * r0,
      Math.sin(phi) * r0,
      Math.sin(theta) * Math.cos(phi) * r0,
      Math.cos(theta) * Math.cos(phi) * r1,
      Math.sin(phi) * r1,
      Math.sin(theta) * Math.cos(phi) * r1,
    )
  }
  const rayGeometry = new THREE.BufferGeometry()
  rayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rayPositions, 3))
  const rays = new THREE.LineSegments(
    rayGeometry,
    new THREE.LineBasicMaterial({
      transparent: true,
      opacity: palette().rayOpacity,
      blending: THREE.AdditiveBlending,
    }),
  )
  rays.position.copy(CENTER)
  scene.add(rays)
  disposables.push(rayGeometry, rays.material)

  // --- 沿最外环流动的数据光点（科技感的关键流动元素） ---
  const flowCount = 40
  const flowGeometry = new THREE.BufferGeometry()
  const flowPositions = new Float32Array(flowCount * 3)
  const flowAngles = new Float32Array(flowCount)
  const flowRadii = new Float32Array(flowCount)
  for (let i = 0; i < flowCount; i += 1) {
    flowAngles[i] = Math.random() * Math.PI * 2
    flowRadii[i] = ringSpecs[i % ringSpecs.length].radius
  }
  flowGeometry.setAttribute('position', new THREE.BufferAttribute(flowPositions, 3))
  const flow = new THREE.Points(
    flowGeometry,
    new THREE.PointsMaterial({
      size: 0.34,
      sizeAttenuation: true,
      color: new THREE.Color(palette().node),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  flow.position.copy(CENTER)
  scene.add(flow)
  disposables.push(flowGeometry, flow.material)

  // --- 远景星尘 ---
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 640
  const dustCount = smallScreen ? 360 : 750
  const dustPositions = new Float32Array(dustCount * 3)
  const dustColors = new Float32Array(dustCount * 3)
  const colorA = new THREE.Color(palette().dustA)
  const colorB = new THREE.Color(palette().dustB)
  for (let i = 0; i < dustCount; i += 1) {
    const radius = 18 + Math.random() * 34
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    dustPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
    dustPositions[i * 3 + 1] = radius * Math.cos(phi)
    dustPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
    const mix = colorA.clone().lerp(colorB, Math.random())
    dustColors[i * 3] = mix.r
    dustColors[i * 3 + 1] = mix.g
    dustColors[i * 3 + 2] = mix.b
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColors, 3))
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      size: 0.12,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: palette().dustOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  dust.position.copy(CENTER)
  scene.add(dust)
  disposables.push(dustGeometry, dust.material)

  // --- 主题切换时换色 ---
  const applyPalette = () => {
    const p = palette()
    core.material.color.set(p.core)
    shell.material.color.set(p.shell)
    glow.material.color.set(p.core)
    glow.material.opacity = p.glowOpacity
    for (const ring of ringMeshes) {
      ring.material.color.set(p.ring)
      ring.material.opacity = p.ringOpacity
    }
    for (const node of nodeMeshes) node.material.color.set(p.node)
    flow.material.color.set(p.node)
    rays.material.color.set(p.ray)
    rays.material.opacity = p.rayOpacity
    dust.material.opacity = p.dustOpacity
  }
  applyPalette()
  const themeObserver = new MutationObserver(applyPalette)
  themeObserver.observe(document.documentElement, { attributeFilter: ['class'] })

  // --- 尺寸 ---
  const resize = () => {
    const width = hostEl.clientWidth || 1
    const height = hostEl.clientHeight || 1
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(hostEl)
  resize()

  // --- 指针视差（监听 window：场景容器 pointer-events:none 让位终端卡片） ---
  const pointer = { x: 0, y: 0 }
  const onPointerMove = (event) => {
    const rect = hostEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2
    pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2
  }
  window.addEventListener('pointermove', onPointerMove)

  // --- 帧循环 ---
  const timer = new THREE.Timer()
  let rafId = 0
  let smoothed = { x: 0, y: 0 }
  let firstFrame = true

  const renderFrame = (elapsed) => {
    core.rotation.y = elapsed * 0.14
    core.rotation.x = elapsed * 0.06
    shell.rotation.y = -elapsed * 0.09
    glow.material.opacity = palette().glowOpacity * (0.84 + Math.sin(elapsed * 1.5) * 0.16)

    for (const ring of ringMeshes) ring.rotation.z += ring.userData.spin * 0.016
    rays.rotation.y = elapsed * 0.025
    dust.rotation.y = elapsed * 0.007

    // 流动数据光点沿各自环前进（轨道面内）
    const pos = flowGeometry.attributes.position
    for (let i = 0; i < flowCount; i += 1) {
      flowAngles[i] += 0.008 + (i % 5) * 0.002
      pos.setXY(i, Math.cos(flowAngles[i]) * flowRadii[i], Math.sin(flowAngles[i]) * flowRadii[i])
    }
    pos.needsUpdate = true

    smoothed.x += (pointer.x - smoothed.x) * 0.05
    smoothed.y += (pointer.y - smoothed.y) * 0.05
    camera.position.x = smoothed.x * 1.6
    camera.position.y = 0.4 - smoothed.y * 1.0
    camera.lookAt(CENTER.x * 0.55, CENTER.y * 0.6, 0)

    renderer.render(scene, camera)
    if (firstFrame) {
      firstFrame = false
      markReady()
    }
  }

  const tick = () => {
    timer.update()
    renderFrame(timer.getElapsed())
    rafId = requestAnimationFrame(tick)
  }

  const onVisibility = () => {
    if (isReducedMotion) return
    if (document.hidden) {
      cancelAnimationFrame(rafId)
      rafId = 0
    } else if (!rafId) {
      timer.update()
      rafId = requestAnimationFrame(tick)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // 减少动画偏好：渲染单帧完整构图后即停（不进 rAF 循环），也不监听视差。
  if (isReducedMotion) {
    renderFrame(0.8)
  } else {
    rafId = requestAnimationFrame(tick)
  }

  return () => {
    cancelAnimationFrame(rafId)
    themeObserver.disconnect()
    resizeObserver.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointermove', onPointerMove)
    for (const item of disposables) item.dispose?.()
    renderer.dispose()
    renderer.forceContextLoss()
  }
}
</script>

<template>
  <div ref="host" class="volund-scene" :class="{ 'scene-ready': ready }" aria-hidden="true">
    <div class="orbital-ring ring-one"></div>
    <div class="orbital-ring ring-two"></div>
    <canvas ref="canvas"></canvas>
  </div>
</template>
