// douyin_publish.js — ego lite (ego-browser) 自动发布视频到抖音
// 固化自 2026-09 实测流程：登录检查 → 上传 → 填标题/描述/话题 → 等内容检测 → 发布 → 核实
//
// 用法（参数走 JSON 文件，因为 ego-browser nodejs 不继承 shell 环境变量）：
//   cat > /tmp/douyin_params.json <<'EOF'
//   {
//     "video": "/path/to/video.mp4",
//     "title": "视频标题（≤30字）",
//     "desc": "描述文案",
//     "tags": ["标签1", "标签2"]
//   }
//   EOF
//   ego-browser nodejs < douyin_publish.js --params /tmp/douyin_params.json
//
// 命令行参数（process.argv 在该运行时可用）：
//   --params <file>   参数 JSON 文件（推荐）
//   --healthcheck     只检查登录态即退出（无副作用）
//   --dry-run         上传并检查已实现的表单字段，不点发布
//
// 退出码：0 成功 | 1 发布前失败 | 2 未登录/登录超时 | 3 发布结果未确认
// 首次登录时脚本会截图二维码到 /tmp/douyin_login_qr.png 并等待扫码最长 180s。

const fs = await import('fs')
const path = await import('path')

// ---- 解析命令行参数 ----
const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const hasFlag = (name) => argv.includes(name)

const SPACE = 'douyin-publish'
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const PARAMS_FILE = argOf('--params') || '/tmp/douyin_params.json'

// ---- 读参数 ----
let P = {}
try {
  P = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf-8'))
} catch (e) {
  cliLog('PARAMS_ERROR: cannot read ' + PARAMS_FILE + ' (' + e.message + ')')
  process.exit(1)
}

if (!P || typeof P !== 'object' || Array.isArray(P) ||
    ['video', 'title', 'desc'].some(key => P[key] != null && typeof P[key] !== 'string') ||
    (P.tags != null && (!Array.isArray(P.tags) || P.tags.some(t => typeof t !== 'string')))) {
  cliLog('PARAMS_ERROR — 参数格式无效')
  process.exit(1)
}
const video = (P.video || '').trim()
const title = (P.title || '').trim()
const desc = (P.desc || '').trim()
const tags = (P.tags || []).map(t => t.trim()).filter(Boolean).map(t => (t.startsWith('#') ? t : '#' + t)).join(' ')
if (!hasFlag('--healthcheck')) {
  if (!video) { cliLog('missing "video" in params'); process.exit(1) }
  if (!path.isAbsolute(video)) { cliLog('video path must be absolute'); process.exit(1) }
  if (!fs.existsSync(video)) { cliLog('video not found: ' + video); process.exit(1) }
  if (!fs.statSync(video).isFile()) { cliLog('video is not a regular file'); process.exit(1) }
  if (!title) { cliLog('missing "title" in params'); process.exit(1) }
  if ([...title].length > 30) { cliLog('title too long (>30 chars): ' + title); process.exit(1) }
}

// ---- 任务空间获取；不可用或已由用户接管时，不自动夺回控制权 ----
async function acquireSpace(name) {
  try { return await useOrCreateTaskSpace(name) } catch (e) {
    cliLog('TASK_SPACE_UNAVAILABLE — 任务空间不可用或已由用户接管，请在 ego lite 中处理')
    process.exit(1)
  }
}

const task = await acquireSpace(SPACE)
cliLog('task space: #' + task.id)

// ---- 登录检查 ----
async function isLoggedIn() {
  const r = await cdp('Network.getCookies', { urls: ['https://creator.douyin.com'] })
  return r.cookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss')
}

await gotoAndWait(UPLOAD_URL)
await waitForLoad()

if (!(await isLoggedIn())) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('/tmp/douyin_login_qr.png', Buffer.from(shot.data, 'base64'))
  cliLog('NOT_LOGGED_IN — 请在 ego lite 窗口用抖音 App 扫码（二维码截图: /tmp/douyin_login_qr.png）')
  let ok = false
  for (let i = 0; i < 60; i++) {
    await wait(3)
    if (await isLoggedIn()) { ok = true; break }
  }
  if (!ok) { cliLog('LOGIN_TIMEOUT — 180s 内未检测到登录'); process.exit(2) }
  cliLog('login detected, continuing')
  await gotoAndWait(UPLOAD_URL)
  await waitForLoad()
} else {
  cliLog('login ok')
}

if (hasFlag('--healthcheck')) { cliLog('HEALTHCHECK_PASS'); process.exit(0) }

// ---- 已验证参数 ----
const existingDraft = await js('document.body.innerText.includes("你还有上次未发布的视频")')
if (existingDraft) {
  cliLog('EXISTING_DRAFT — 页面提示有未发布的视频，先处理原稿后再上传；不会自动放弃或覆盖')
  process.exit(1)
}
const descLine = [desc, tags].filter(Boolean).join(' ')
cliLog('video: ' + video)
cliLog('title: ' + title)
cliLog('desc : ' + descLine)

// ---- CDP 注入文件（页面 JS 无法给 input[type=file] 赋值，必须走 CDP）----
const doc = await cdp('DOM.getDocument', {})
let node = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file][accept*=video]' })
if (!node.nodeId) node = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
if (!node.nodeId) { cliLog('file input not found — 页面未加载完成'); process.exit(1) }
await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [video] })
cliLog('file injected')

// 等编辑器出现（上传开始、表单挂载）
let editorReady = false
for (let i = 0; i < 30; i++) {
  if (await js("!!document.querySelector('.zone-container.editor-kit-container')")) { editorReady = true; break }
  await wait(2)
}
if (!editorReady) { cliLog('EDITOR_NOT_READY — 上传后表单未出现'); process.exit(1) }

// ---- 填标题（React 受控 input：原生 setter + input 事件）----
const fillTitle = await js(`(() => {
  const el = [...document.querySelectorAll('input.semi-input')].find(i => (i.placeholder || '').includes('作品标题'))
    || document.querySelectorAll('input.semi-input')[0]
  if (!el) return 'no-title-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(title)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
cliLog('fill title: ' + fillTitle)
if (fillTitle !== 'ok') { cliLog('TITLE_NOT_SET — 无法填写标题，中止'); process.exit(1) }

// ---- 填描述+话题（contenteditable 富文本：execCommand insertText）----
const fillDesc = await js(`(() => {
  const el = document.querySelector('.zone-container.editor-kit-container')
  if (!el) return 'no-editor'
  const normalized = text => String(text || '').replace(/[\\u200b\\ufeff]/g, '').replace(/\\s+/gu, ' ').trim()
  const current = normalized(el.innerText)
  const requested = normalized(${JSON.stringify(descLine)})
  if (current === requested) return 'already-set'
  if (current) return 'editor-not-empty'
  el.focus()
  return document.execCommand('insertText', false, ${JSON.stringify(descLine)}) ? 'ok' : 'insert-failed'
})()`)
cliLog('fill desc: ' + fillDesc)
if (fillDesc !== 'ok' && fillDesc !== 'already-set') { cliLog('DESC_NOT_SET — 简介非空或无法填写，中止'); process.exit(1) }
await wait(2)

// 回读校验
const check = await js(`(() => ({
  title: ([...document.querySelectorAll('input.semi-input')].find(i => (i.placeholder || '').includes('作品标题')) || {}).value || '',
  desc: (document.querySelector('.zone-container.editor-kit-container') || {}).innerText || ''
}))()`)
const normalize = (text) => String(text || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/gu, ' ').trim()
if (normalize(check.title) !== normalize(title)) { cliLog('TITLE_MISMATCH — 页面标题与请求不一致，中止'); process.exit(1) }
if (normalize(check.desc) !== normalize(descLine)) { cliLog('DESC_MISMATCH — 页面简介与请求不一致，中止'); process.exit(1) }
cliLog('verify title: ' + check.title)
cliLog('verify desc : ' + String(check.desc).slice(0, 80))

// 编辑器出现不等于上传完成；要求有远端视频预览或重新上传控件，且无上传进度或失败提示。
let uploadReady = false
for (let i = 0; i < 60; i++) {
  const upload = await js(`(() => {
    const visible = el => !!(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden'
    const preview = [...document.querySelectorAll('video[src^="https://"], video[src^="http://"]')].some(visible)
    const reupload = [...document.querySelectorAll('button, span, div')].some(el => visible(el) && el.childElementCount === 0 && el.innerText.trim() === '重新上传')
    const progress = [...document.querySelectorAll('[class*="progress-bar"], [role="progressbar"]')].some(visible)
    const failed = document.body.innerText.includes('上传失败')
    return { ready: (preview || reupload) && !progress && !failed, failed }
  })()`)
  if (upload.failed) { cliLog('UPLOAD_FAILED — 视频上传失败，中止'); process.exit(1) }
  if (upload.ready) { uploadReady = true; break }
  await wait(3)
}
if (!uploadReady) { cliLog('UPLOAD_UNCONFIRMED — 未确认视频上传完成，中止'); process.exit(1) }

// ---- 等内容安全检测（"检测中"消失，最长 120s）----
let checkDone = false
for (let i = 0; i < 40; i++) {
  if (!(await js('document.body.innerText.includes("检测中")'))) { checkDone = true; break }
  await wait(3)
}
if (!checkDone) { cliLog('CONTENT_CHECK_TIMEOUT — 内容检测未完成，中止'); process.exit(1) }
cliLog('content check no longer pending')

const st = await js(`(() => ({
  publishBtn: !!([...document.querySelectorAll('button')].find(b => b.innerText.trim() === '发布' && !b.disabled)),
  coverIssue: document.body.innerText.includes('封面缺失') || document.body.innerText.includes('封面诊断失败'),
  err: [...document.querySelectorAll('[class*=error],[class*=Error]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 3)
}))()`)
cliLog('state: ' + JSON.stringify(st))
if (!st.publishBtn) { cliLog('PUBLISH_BUTTON_UNAVAILABLE — 请人工检查 ego lite 页面'); process.exit(1) }
if (st.err.length) { cliLog('FORM_ERRORS — 请人工检查 ego lite 页面'); process.exit(1) }
if (st.coverIssue) cliLog('COVER_REVIEW_REQUIRED — 页面提示封面缺失或诊断失败，请人工检查')

if (hasFlag('--dry-run') || hasFlag('--dry_run') || P.dry_run === true) { cliLog('DRYRUN_OK — 上传和文案校验完成，未点击发布；封面及发布设置请在页面核对'); process.exit(0) }

// ---- 发布 ----
let clicked = false
try {
  clicked = await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '发布' && !x.disabled); if (b) b.click(); return !!b })()`)
} catch (_) {
  cliLog('PUBLISH_UNCONFIRMED — 无法判断是否点击发布，请先到作品管理核对，不要重试')
  process.exit(3)
}
if (!clicked) { cliLog('PUBLISH_NOT_CLICKED — 发布按钮不可用'); process.exit(1) }
cliLog('publish clicked')

let published = false
let confirmed = false
try {
  for (let i = 0; i < 20; i++) {
    await wait(3)
    if (String(await js('location.href')).includes('content/manage')) { published = true; break }
  }
  if (published) {
    await wait(2)
    confirmed = await js('document.body.innerText.includes("发布成功")')
  }
} catch (_) {
  // A click was already sent; an interrupted check is an unknown outcome.
}
if (confirmed) { cliLog('PUBLISH_SUCCESS — 平台显示发布成功，审核状态以作品管理为准'); process.exit(0) }
cliLog('PUBLISH_UNCONFIRMED — 已点击发布但未确认结果，请先到作品管理核对，不要重试')
process.exit(3)
