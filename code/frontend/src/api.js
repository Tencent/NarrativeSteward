const BASE = '/api';
async function http(method, path, body, extraHeaders = {}) {
  const opts = {
    method,
    headers: {}
  };
  Object.assign(opts.headers, extraHeaders);
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let detail;
    try {
      const payload = await res.json();
      detail = payload.detail;
      if (Array.isArray(detail)) {
        detail = detail.map((item) => item.msg || JSON.stringify(item)).join('；');
      } else if (detail && typeof detail === 'object') {
        detail = detail.msg || JSON.stringify(detail);
      }
    } catch {
      detail = res.statusText;
    }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
export const api = {
  quickStartDemo: (locale = 'zh-CN') => http('GET', `/quick-start/demo?locale=${encodeURIComponent(locale === 'en-US' ? 'en-US' : 'zh-CN')}`),
  listProjects: () => http('GET', '/projects'),
  createProject: (name) => http('POST', '/projects', {
    name
  }),
  getProject: (id) => http('GET', `/projects/${id}`),
  listMaterials: (id) => http('GET', `/projects/${id}/materials`),
  previewMaterial: (id, name, offset = 0, limit = 100000) => http('GET', `/projects/${id}/materials/${encodeURIComponent(name)}?offset=${offset}&limit=${limit}`),
  uploadMaterial: (id, filename, content) => http('POST', `/projects/${id}/materials`, {
    filename,
    content
  }),
  deleteMaterial: (id, name) => http('DELETE', `/projects/${id}/materials/${encodeURIComponent(name)}`),
  uploadAsset: (id, file) => fileToDataUrl(file).then((data_b64) => http('POST', `/projects/${id}/assets`, {
    filename: file.name,
    data_b64
  })),
  generateCardImage: (id, card) => http('POST', `/projects/${id}/assets/generate`, {
    category: card.category,
    name: card.name,
    description: card.description || '',
    tags: card.tags || [],
    visual_instructions: card.visualInstructions || ''
  }),
  assetUrl: (id, image) => image ? `${BASE}/projects/${id}/${image}` : '',
  getData: (id, type) => http('GET', `/projects/${id}/data/${type}`),
  putData: (id, type, content, base_revision) => http('PUT', `/projects/${id}/data/${type}`, {
    content,
    base_revision
  }),
  getStateVariableUsages: (id) => http('GET', `/projects/${id}/state-variable-usages`),
  listScenes: (id) => http('GET', `/projects/${id}/scenes`),
  getScene: (id, eventId) => http('GET', `/projects/${id}/scenes/${encodeURIComponent(eventId)}`),
  putScene: (id, eventId, content, base_revision) => http('PUT', `/projects/${id}/scenes/${encodeURIComponent(eventId)}`, {
    content,
    base_revision
  }),
  getReachability: (id) => http('GET', `/projects/${id}/reachability`),
  getValidation: (id) => http('GET', `/projects/${id}/validation`),
  runValidation: (id) => http('POST', `/projects/${id}/validation/run`),
  getValidationRun: (id) => http('GET', `/projects/${id}/validation/run`),
  cancelValidation: (id) => http('POST', `/projects/${id}/validation/cancel`),
  getLatestAgentChangeset: (id) => http('GET', `/projects/${id}/agent-changesets/latest`),
  keepAgentChangeset: (id, changesetId) => http('POST', `/projects/${id}/agent-changesets/${changesetId}/keep`),
  revertAgentChangeset: (id, changesetId) => http('POST', `/projects/${id}/agent-changesets/${changesetId}/revert`),
  chat: (id, message, locale = 'zh-CN', playtestContext = null) => http('POST', `/projects/${id}/chat`, {
    message,
    locale: locale === 'en-US' ? 'en-US' : 'zh-CN',
    ...(playtestContext ? {
      playtest_context: playtestContext
    } : {})
  }),
  getTurnPreview: (id, turnId, generation) => http('GET', `/projects/${id}/chat/preview/${encodeURIComponent(turnId)}/${generation}`),
  previewAssetUrl: (id, turnId, generation, image) => {
    const name = String(image || '').replace(/^\/+/, '');
    const fileName = name.startsWith('assets/') ? name.slice('assets/'.length) : name;
    if (!id || !turnId || generation == null || !fileName) return '';
    return `${BASE}/projects/${id}/chat/preview/${encodeURIComponent(turnId)}/${generation}/assets/${encodeURIComponent(fileName)}`;
  },
  chatRun: (id) => http('GET', `/projects/${id}/chat/run`),
  stopChat: (id) => http('POST', `/projects/${id}/chat/stop`),
  getHistory: (id) => http('GET', `/projects/${id}/history`),
  eventsUrl: (id) => `${BASE}/projects/${id}/events`
};
