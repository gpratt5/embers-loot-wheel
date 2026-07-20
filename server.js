const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3939;
const DATA_DIR = process.env.DATA_DIR || __dirname; // point this at a mounted persistent disk on paid Render plans
const DATA_FILE = path.join(DATA_DIR, 'data.json'); // used when GITHUB_TOKEN isn't set
const INDEX_FILE = path.join(__dirname, 'index.html');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';       // e.g. "yourname/ember-loot-ledger-data"
const GITHUB_PATH = process.env.GITHUB_DATA_PATH || 'ledger-data.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const USE_GITHUB = Boolean(GITHUB_TOKEN && GITHUB_REPO);

if(!ADMIN_PASSWORD){
  console.warn('WARNING: ADMIN_PASSWORD is not set — the admin panel will refuse all requests until you set it.');
}
if(!USE_GITHUB){
  console.warn(`WARNING: GITHUB_TOKEN / GITHUB_REPO not set — using local storage at ${DATA_FILE}. This is fine if DATA_DIR points at a persistent disk (paid Render plans); on ephemeral filesystems (e.g. Render's free tier) it will not survive a restart or redeploy.`);
}

function defaultLedger(){
  return { players: [], runes: [], wishlist: {}, runeCycle: {}, runeHistory: [], gearHistory: [], runeStock: {}, runeStockLower: {}, materialStock: {} };
}
function defaultAuth(){
  return { pendingRequests: [], approvedUsers: [] };
}
function defaultStore(){
  return { ledger: defaultLedger(), auth: defaultAuth() };
}
function normalizeStore(store){
  if(!store || typeof store !== 'object') store = {};
  if(!store.ledger) store.ledger = defaultLedger();
  if(!store.auth) store.auth = defaultAuth();
  if(!Array.isArray(store.auth.pendingRequests)) store.auth.pendingRequests = [];
  if(!Array.isArray(store.auth.approvedUsers)) store.auth.approvedUsers = [];
  return store;
}

// ---------- GitHub-backed storage (secret token stays on the server) ----------
const GITHUB_API = 'https://api.github.com';
function githubHeaders(extra){
  return Object.assign({
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ember-loot-ledger'
  }, extra || {});
}

async function githubReadStore(){
  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if(res.status === 404){
    return { store: defaultStore(), sha: null };
  }
  if(!res.ok){
    throw new Error(`GitHub read failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  let store;
  try{ store = JSON.parse(content); }catch(e){ store = defaultStore(); }
  return { store: normalizeStore(store), sha: json.sha };
}

async function githubWriteStore(store, message){
  const { sha } = await githubReadStore(); // refetch sha right before writing to shrink the race window
  const url = `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_PATH)}`;
  const body = {
    message: message || 'Update loot ledger data',
    content: Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if(sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: githubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if(!res.ok){
    throw new Error(`GitHub write failed (${res.status}): ${await res.text()}`);
  }
}

// ---------- Local file fallback (dev/testing only) ----------
function ensureDataDir(){
  try{ fs.mkdirSync(DATA_DIR, { recursive: true }); }catch(e){ /* already exists or not creatable; read/write below will surface real errors */ }
}
function localReadStore(){
  try{
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalizeStore(JSON.parse(raw));
  }catch(e){
    ensureDataDir();
    const fresh = defaultStore();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}
function localWriteStore(store){
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

async function readStore(){
  return USE_GITHUB ? (await githubReadStore()).store : localReadStore();
}
async function writeStore(store, message){
  if(USE_GITHUB) await githubWriteStore(store, message);
  else localWriteStore(store);
}

// ---------- helpers ----------
function sendJson(res, status, obj){
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((resolve, reject)=>{
    let body = '';
    req.on('data', c=>{ body += c; });
    req.on('end', ()=>{
      if(!body){ resolve({}); return; }
      try{ resolve(JSON.parse(body)); }catch(e){ reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function getToken(req, url){
  const authHeader = req.headers['authorization'];
  if(authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return url.searchParams.get('token') || '';
}
function findApprovedByToken(store, token){
  if(!token) return null;
  return store.auth.approvedUsers.find(u => u.token === token) || null;
}
function checkAdmin(password){
  return Boolean(ADMIN_PASSWORD) && password === ADMIN_PASSWORD;
}

const server = http.createServer(async (req, res) => {
  let url;
  try{
    const sanitizedUrl = req.url.replace(/\/{2,}/g, '/');
    url = new URL(sanitizedUrl, `http://${req.headers.host}`);
    if(url.pathname.length > 1){
      url.pathname = url.pathname.replace(/\/$/, '') || '/';
    }
  }
  catch(e){ res.writeHead(400); res.end('Bad request'); return; }

  if(req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')){
    fs.readFile(INDEX_FILE, (err, content) => {
      if(err){ res.writeHead(500); res.end('Could not load index.html: ' + err.message); return; }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(content);
    });
    return;
  }

  try{
    if(url.pathname === '/api/data' && req.method === 'GET'){
      const store = await readStore();
      const user = findApprovedByToken(store, getToken(req, url));
      if(!user){ sendJson(res, 401, {error:'Not authorized'}); return; }
      sendJson(res, 200, store.ledger);
      return;
    }

    if(url.pathname === '/api/data' && req.method === 'POST'){
      const body = await readBody(req);
      const store = await readStore();
      const user = findApprovedByToken(store, getToken(req, url));
      if(!user){ sendJson(res, 401, {error:'Not authorized'}); return; }
      store.ledger = body;
      await writeStore(store, `Ledger update by ${user.name}`);
      sendJson(res, 200, {ok:true});
      return;
    }

    if(url.pathname === '/api/whoami' && req.method === 'GET'){
      const store = await readStore();
      const user = findApprovedByToken(store, getToken(req, url));
      sendJson(res, 200, { approved: Boolean(user), name: user ? user.name : null });
      return;
    }

    if(url.pathname === '/api/request-access' && req.method === 'POST'){
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if(!name){ sendJson(res, 400, {error:'Name is required'}); return; }
      const store = await readStore();
      const dupe = store.auth.pendingRequests.some(r=>r.name.toLowerCase()===name.toLowerCase())
        || store.auth.approvedUsers.some(u=>u.name.toLowerCase()===name.toLowerCase());
      if(dupe){ sendJson(res, 200, {ok:true, note:'A request or approval for this name already exists.'}); return; }
      store.auth.pendingRequests.push({ id: crypto.randomUUID(), name, requestedAt: Date.now() });
      await writeStore(store, `Access request from ${name}`);
      sendJson(res, 200, {ok:true});
      return;
    }

    if(url.pathname === '/api/admin/state' && req.method === 'GET'){
      if(!checkAdmin(url.searchParams.get('password'))){ sendJson(res, 401, {error:'Bad admin password'}); return; }
      const store = await readStore();
      sendJson(res, 200, store.auth);
      return;
    }

    if(url.pathname === '/api/admin/approve' && req.method === 'POST'){
      const body = await readBody(req);
      if(!checkAdmin(body.password)){ sendJson(res, 401, {error:'Bad admin password'}); return; }
      const store = await readStore();
      const idx = store.auth.pendingRequests.findIndex(r=>r.id===body.id);
      if(idx === -1){ sendJson(res, 404, {error:'Request not found'}); return; }
      const [entry] = store.auth.pendingRequests.splice(idx, 1);
      const token = crypto.randomBytes(24).toString('hex');
      store.auth.approvedUsers.push({ id: entry.id, name: entry.name, token, approvedAt: Date.now() });
      await writeStore(store, `Approved ${entry.name}`);
      sendJson(res, 200, { ok:true, token, name: entry.name });
      return;
    }

    if(url.pathname === '/api/admin/deny' && req.method === 'POST'){
      const body = await readBody(req);
      if(!checkAdmin(body.password)){ sendJson(res, 401, {error:'Bad admin password'}); return; }
      const store = await readStore();
      store.auth.pendingRequests = store.auth.pendingRequests.filter(r=>r.id!==body.id);
      await writeStore(store, `Denied access request ${body.id}`);
      sendJson(res, 200, {ok:true});
      return;
    }

    if(url.pathname === '/api/admin/revoke' && req.method === 'POST'){
      const body = await readBody(req);
      if(!checkAdmin(body.password)){ sendJson(res, 401, {error:'Bad admin password'}); return; }
      const store = await readStore();
      store.auth.approvedUsers = store.auth.approvedUsers.filter(u=>u.id!==body.id);
      await writeStore(store, `Revoked access ${body.id}`);
      sendJson(res, 200, {ok:true});
      return;
    }

    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not found');
  }catch(e){
    sendJson(res, 500, {error: e.message});
  }
});

server.listen(PORT, () => {
  console.log(`Ember's Adrift Loot Ledger running on port ${PORT}`);
  console.log(USE_GITHUB
    ? `Storage: GitHub — ${GITHUB_REPO} @ ${GITHUB_BRANCH} / ${GITHUB_PATH}`
    : `Storage: local file at ${DATA_FILE} (set DATA_DIR to a persistent disk's mount path on paid Render, or set GITHUB_TOKEN + GITHUB_REPO for GitHub-backed storage)`);
});
