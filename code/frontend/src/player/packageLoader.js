/** Validate exported data from a generated bundle or explicitly selected files. */
const FORMAT = 'narrativesteward-project'
const MAX_BYTES = 300 * 1024 * 1024
const fail = (text) => { throw new Error(text) }
const safePath = (path) => typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
  !path.startsWith('/') && !path.includes(':') && path.split('/').every(p => p && p !== '.' && p !== '..')
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function graph(nodes, edges, label) {
  if (!Array.isArray(nodes) || !nodes.length || !Array.isArray(edges)) fail(`故事结构不完整 / Incomplete graph: ${label}`)
  const ids = new Set()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ['__proto__', 'constructor', 'prototype'].includes(node.id) || ids.has(node.id)) fail(`节点标识无效 / Invalid node: ${label}`)
    ids.add(node.id)
  }
  const edgeIds = new Set()
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) fail(`连线无效 / Invalid edge: ${label}`)
    edgeIds.add(edge.id)
  }
}

export async function loadProjectFiles(selected) {
  const files = new Map()
  let total = 0
  for (const file of Array.from(selected)) {
    const path = file.webkitRelativePath || file.name
    if (!safePath(path) || files.has(path)) fail('文件路径重复或无效 / Duplicate or invalid file path.')
    total += file.size
    if (total > MAX_BYTES) fail('项目超过 300 MiB / Project exceeds 300 MiB.')
    files.set(path, file)
  }
  // Permit selecting either project/ or the extracted package's parent directory.
  const manifests = [...files.keys()].filter(p => p.endsWith('/manifest.json') || p === 'manifest.json')
  if (manifests.length !== 1) fail('请选择一个含 manifest.json 的导出项目文件夹 / Select one exported project folder containing manifest.json.')
  const root = manifests[0].slice(0, -'manifest.json'.length)
  async function read(path) {
    if (!safePath(path) || !files.has(root + path)) fail(`缺少文件 / Missing file: ${path}`)
    try { return JSON.parse(await files.get(root + path).text()) }
    catch { fail(`无法读取 JSON / Invalid JSON: ${path}`) }
  }
  const objectUrls = []
  return loadStory(read, async path => {
    if (!files.has(root + path)) fail(`图片缺失 / Missing image: ${path}`)
    const extension = path.split('.').pop().toLowerCase()
    const url = URL.createObjectURL(new Blob([files.get(root + path)], { type: `image/${extension === 'jpg' ? 'jpeg' : extension}` }))
    objectUrls.push(url)
    return url
  }, () => { objectUrls.forEach(url => URL.revokeObjectURL(url)) })
}

/** A classic script provides serialized data; local images stay separate. */
export async function loadBundledProject(bundle, base = document.baseURI) {
  if (!bundle?.manifest || !bundle?.files) fail('缺少故事数据 / Missing story.js data.')
  const read = async path => {
    if (!safePath(path) || !own(bundle.files, path)) fail(`缺少文件 / Missing file: ${path}`)
    return bundle.files[path]
  }
  const baseUrl = new URL(base)
  if (!['file:', 'http:', 'https:'].includes(baseUrl.protocol)) fail('不支持的打开方式 / Unsupported player URL.')
  return loadStory(read, async path => new URL(`project/${path.split('/').map(encodeURIComponent).join('/')}`, baseUrl).href, () => {})
}

async function loadStory(read, resolveImage, dispose) {
  const manifest = await read('manifest.json')
  if (manifest?.format !== FORMAT || manifest.version !== 1) fail('不支持的项目格式或版本 / Unsupported project format or version.')
  if (!manifest.files || typeof manifest.files.scenes !== 'object' || !Array.isArray(manifest.assets)) fail('项目清单不完整 / Incomplete manifest.')
  const world = await read(manifest.files.world)
  const events = await read(manifest.files.events)
  graph(events?.nodes, events?.edges, 'events')
  if (!world || typeof world !== 'object' || Object.values(world).some(group => !Array.isArray(group))) fail('设定格式无效 / Invalid world data.')
  const cards = Object.values(world).flat()
  if (cards.some(c => !c || typeof c.name !== 'string')) fail('设定卡无效 / Invalid world card.')
  const cardIds = new Set(cards.map(c => c.id))
  const locationIds = new Set((world.locations || []).map(c => c.id))
  const vars = new Map()
  for (const v of events.state_variables || []) {
    if (!v || typeof v.id !== 'string' || !v.id || vars.has(v.id) || ['__proto__', 'constructor', 'prototype'].includes(v.id) || !['flag', 'enum', 'scalar'].includes(v.type)) fail('状态变量无效 / Invalid state variable.')
    if (v.type === 'enum' && (!Array.isArray(v.allowed) || !v.allowed.length)) fail('枚举状态无效 / Invalid enum variable.')
    vars.set(v.id, v)
  }
  function rules(edges, beats = []) {
    for (const edge of edges) {
      if (edge.condition && (!vars.has(edge.condition.var) || !['==', '!=', '>', '>=', '<', '<='].includes(edge.condition.op))) fail('条件无效 / Invalid condition.')
    }
    for (const beat of beats) {
      if (typeof beat.content !== 'string' || !['narration', 'dialogue', 'monologue', 'choice'].includes(beat.kind)) fail('情节无效 / Invalid beat.')
      if (beat.speaker && !cardIds.has(beat.speaker)) fail('角色引用丢失 / Missing speaker.')
      if (beat.location && !locationIds.has(beat.location)) fail('地点引用丢失 / Missing location.')
      for (const effect of beat.effects || []) if (!vars.has(effect.var) || !['set', 'add'].includes(effect.op)) fail('状态效果无效 / Invalid state effect.')
    }
  }
  rules(events.edges)
  const scenes = new Map()
  for (const event of events.nodes) {
    if (!own(manifest.files.scenes, event.id)) fail(`缺少情节 / Missing scene: ${event.title || event.id}`)
    const scene = await read(manifest.files.scenes[event.id])
    graph(scene?.beats, scene?.edges, event.id)
    rules(scene.edges, scene.beats)
    scenes.set(event.id, scene)
  }
  const urls = new Map()
  try {
    for (const path of manifest.assets) {
      if (!safePath(path) || !/^assets\/[^/]+\.(png|jpe?g|webp|gif|avif)$/i.test(path)) fail(`图片缺失或路径无效 / Missing or invalid image: ${path}`)
      if (urls.has(path)) fail(`图片路径重复 / Duplicate image: ${path}`)
      const url = await resolveImage(path)
      urls.set(path, url)
      const img = new Image()
      img.src = url
      try { await img.decode() } catch { fail(`图片损坏 / Invalid image: ${path}`) }
    }
    for (const card of cards) if (card.image && !urls.has(card.image)) fail(`图片未打包 / Image not included: ${card.image}`)
    return {
      title: String(manifest.title || 'NarrativeSteward'),
      events,
      dataSource: {
        getData: async (_id, type) => ({ content: type === 'events' ? events : world }),
        getScene: async (_id, id) => ({ exists: scenes.has(id), content: scenes.get(id) }),
        assetUrl: (_id, path) => urls.get(path) || '',
      },
      dispose,
    }
  } catch (err) {
    dispose()
    throw err
  }
}
