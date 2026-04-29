const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 80;
const MAX_BODY_SIZE = 1 * 1024 * 1024;
const DATA_DIR = path.resolve(__dirname, 'data');
const POSTS_DIR = path.resolve(DATA_DIR, 'posts');
const NODES_FILE = path.resolve(DATA_DIR, 'nodes.txt');
const INDEX_HTML = path.resolve(DATA_DIR, 'index.html');
const SUBSCRIPTIONS_FILE = path.resolve(DATA_DIR, 'subscriptions.json');

const ALLOWED_METHODS = ['GET', 'POST', 'HEAD'];

fs.mkdirSync(POSTS_DIR, { recursive: true });

// ==================== 响应工具（安全头始终在 writeHead 之前） ====================

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Powered-By', '');
}

function sendHtml(res, statusCode, html) {
    setSecurityHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function sendText(res, statusCode, text) {
    setSecurityHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function redirect(res, location) {
    setSecurityHeaders(res);
    res.writeHead(302, { 'Location': location });
    res.end();
}

// ==================== 路径安全 ====================

function isPathSafe(filePath, allowedBase) {
    const resolved = path.resolve(filePath);
    const resolvedBase = path.resolve(allowedBase) + path.sep;
    return resolved === path.resolve(allowedBase) || resolved.startsWith(resolvedBase);
}

function safeRead(filePath, res, contentType) {
    if (!isPathSafe(filePath, DATA_DIR)) {
        setSecurityHeaders(res);
        res.writeHead(403);
        return res.end('Forbidden');
    }
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            setSecurityHeaders(res);
            res.writeHead(404);
            return res.end('File not found');
        }
        setSecurityHeaders(res);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function safeWrite(filePath, content, res, redirectPath) {
    if (!isPathSafe(filePath, DATA_DIR)) {
        setSecurityHeaders(res);
        res.writeHead(403);
        return res.end('Forbidden');
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFile(filePath, content, 'utf8', err => {
        if (err) {
            setSecurityHeaders(res);
            res.writeHead(500);
            return res.end('Save failed');
        }
        redirect(res, redirectPath || '/fmc');
    });
}

// ==================== SSRF 防护 ====================

function isValidSubscriptionUrl(subUrl) {
    try {
        const u = new url.URL(subUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
        if (blocked.includes(u.hostname)) return false;
        if (u.hostname === '169.254.169.254') return false;
        if (u.hostname.endsWith('.local')) return false;
        if (u.hostname.startsWith('10.') || u.hostname.startsWith('192.168.')) return false;
        if (u.hostname.startsWith('172.')) {
            const p = u.hostname.split('.');
            const s = parseInt(p[1]);
            if (p.length === 4 && s >= 16 && s <= 31) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function readBody(req, callback) {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) { req.destroy(); callback(new Error('Body too large')); return; }
        chunks.push(chunk);
    });
    req.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', err => callback(err));
}

// ==================== 通用工具 ====================

function getPostList() {
    try { return fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.txt')); }
    catch { return []; }
}

function getSubscriptions() {
    try {
        const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
        const arr = JSON.parse(raw);
        const migrated = arr.map(item => typeof item === 'string' ? { url: item, interval: 0 } : item);
        if (JSON.stringify(arr) !== JSON.stringify(migrated)) saveSubscriptions(migrated);
        return migrated;
    } catch { return []; }
}

function saveSubscriptions(list) {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatInterval(minutes) {
    if (!minutes || minutes <= 0) return '手动';
    if (minutes < 60) return `每 ${minutes} 分钟`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `每 ${h}h${m}m` : `每 ${h} 小时`;
}

// ==================== 外部抓取 ====================

function fetchExternalSubscription(extUrl, callback) {
    if (!isValidSubscriptionUrl(extUrl)) return callback(new Error('URL 不合法或指向内网地址'));
    const mod = extUrl.startsWith('https') ? https : http;
    const req = mod.get(extUrl, { timeout: 30000 }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
            if (resp.statusCode !== 200) return callback(new Error(`HTTP ${resp.statusCode}`));
            let decoded = data;
            if (data.length > 0) {
                try {
                    const buf = Buffer.from(data, 'base64');
                    if (buf.toString('base64') === data) decoded = buf.toString('utf8');
                } catch (e) { /* keep original */ }
            }
            const lines = decoded.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
            callback(null, lines);
        });
    });
    req.on('error', err => callback(err));
    req.on('timeout', () => { req.destroy(); callback(new Error('请求超时')); });
}

// ==================== 定时自动更新 ====================

const lastFetchTimes = {};

function scheduleAutoFetch() {
    setInterval(() => {
        const subs = getSubscriptions();
        subs.forEach(sub => {
            if (!sub.interval || sub.interval <= 0) return;
            const now = Date.now();
            if (now - (lastFetchTimes[sub.url] || 0) < sub.interval * 60000) return;
            fetchExternalSubscription(sub.url, (err, newLines) => {
                if (err) { console.error(`[AutoFetch:ERR] ${sub.url}: ${err.message}`); return; }
                let existing = [];
                if (fs.existsSync(NODES_FILE)) {
                    try {
                        existing = fs.readFileSync(NODES_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    } catch (e) { console.error(`[AutoFetch:ERR] read: ${e.message}`); }
                }
                const set = new Set(existing);
                let added = 0;
                newLines.forEach(l => { if (!set.has(l)) { set.add(l); added++; } });
                try {
                    fs.writeFileSync(NODES_FILE, Array.from(set).join('\n') + '\n', 'utf8');
                    lastFetchTimes[sub.url] = now;
                    console.log(`[AutoFetch:OK] ${sub.url} -> +${added} (total ${set.size})`);
                } catch (e) { console.error(`[AutoFetch:ERR] write: ${e.message}`); }
            });
        });
    }, 60000);
}

// ==================== CSS ====================

const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#0d1117,#161b22);color:#c9d1d9;min-height:100vh;line-height:1.6}
a{color:#58a6ff;text-decoration:none;transition:color .15s}
a:hover{color:#79c0ff}
h1,h2,h3,h4{color:#f0f6fc;font-weight:600;letter-spacing:-.01em}
h1{font-size:1.75rem}h2{font-size:1.3rem}h3{font-size:1.1rem}
.container{max-width:960px;margin:0 auto;padding:1.5rem 1.25rem}
.header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;padding-bottom:1.25rem;border-bottom:1px solid #21262d;margin-bottom:1.5rem}
.header h1{margin:0}
.header .meta{font-size:.85rem;color:#8b949e}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.25rem;margin-bottom:1.25rem;transition:border-color .2s}
.card:hover{border-color:#484f58}
.card-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem}
.card-header h2,.card-header h3{margin:0}
.card-body{color:#8b949e}
pre{background:#0d1117;padding:1rem;border-radius:8px;white-space:pre-wrap;font-family:'Fira Code','Cascadia Code','JetBrains Mono',monospace;font-size:.85rem;line-height:1.5;overflow-x:auto;border:1px solid #30363d}
textarea{width:100%;min-height:300px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;padding:.75rem;font-family:'Fira Code',monospace;font-size:.85rem;line-height:1.6;resize:vertical;transition:border-color .2s}
textarea:focus,input:focus{outline:none;border-color:#58a6ff;box-shadow:0 0 0 3px rgba(88,166,255,.15)}
input[type="text"],input[type="url"],input[type="number"]{width:100%;padding:.6rem .75rem;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;font-size:.9rem;transition:border-color .2s}
.btn{display:inline-flex;align-items:center;gap:.35rem;padding:.45rem .9rem;border-radius:8px;font-size:.85rem;font-weight:500;cursor:pointer;text-decoration:none;border:none;transition:all .15s;white-space:nowrap}
.btn-primary{background:linear-gradient(135deg,#238636,#2ea043);color:#fff}
.btn-primary:hover{background:linear-gradient(135deg,#2ea043,#3fb950);color:#fff}
.btn-secondary{background:#21262d;color:#c9d1d9;border:1px solid #30363d}
.btn-secondary:hover{background:#30363d;color:#f0f6fc}
.btn-danger{background:linear-gradient(135deg,#da3633,#f85149);color:#fff}
.btn-danger:hover{background:linear-gradient(135deg,#e5534b,#ff6b62);color:#fff}
.btn-sm{padding:.3rem .6rem;font-size:.78rem;border-radius:6px}
.btn-lg{padding:.6rem 1.2rem;font-size:.95rem}
.tabs{display:flex;border-bottom:2px solid #21262d;margin-bottom:1.5rem;overflow-x:auto}
.tab{padding:.6rem 1.1rem;font-size:.88rem;font-weight:500;color:#8b949e;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s;white-space:nowrap}
.tab:hover{color:#c9d1d9}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.tab-content{display:none}
.tab-content.active{display:block}
.list-item{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;padding:.7rem .9rem;background:#0d1117;border:1px solid #21262d;border-radius:8px;margin-bottom:.45rem;transition:border-color .15s}
.list-item:hover{border-color:#30363d}
.list-item .info{min-width:0;flex:1}
.list-item .info .title{color:#f0f6fc;font-weight:500;word-break:break-all}
.list-item .info .sub{color:#8b949e;font-size:.8rem;margin-top:.15rem}
.list-item .actions{display:flex;gap:.35rem;flex-shrink:0}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:20px;font-size:.75rem;font-weight:500}
.badge-green{background:rgba(46,160,67,.2);color:#3fb950}
.badge-yellow{background:rgba(210,153,34,.2);color:#d29922}
.badge-red{background:rgba(248,81,73,.2);color:#f85149}
.badge-blue{background:rgba(88,166,255,.15);color:#58a6ff}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem;margin-bottom:1.5rem}
.stat{text-align:center;padding:1rem;background:#0d1117;border-radius:8px;border:1px solid #21262d}
.stat .num{font-size:1.8rem;font-weight:700;color:#58a6ff}
.stat .label{font-size:.8rem;color:#8b949e;margin-top:.2rem}
.inline-form{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.inline-form input{flex:1;min-width:140px}
.inline-form input[type="number"]{flex:0 0 80px;min-width:80px}
.empty-state{text-align:center;padding:2.5rem 1rem;color:#484f58}
.empty-state .icon{font-size:2.5rem;margin-bottom:.5rem}
.alert{padding:.75rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.88rem}
.alert-info{background:rgba(88,166,255,.1);border:1px solid rgba(88,166,255,.2);color:#58a6ff}
.tip{font-size:.82rem;color:#484f58;margin-top:.35rem}
.back-link{display:inline-flex;align-items:center;gap:.35rem;font-size:.88rem;margin-top:1.25rem}
@media(max-width:600px){
.container{padding:1rem}
.list-item{flex-direction:column;align-items:flex-start}
.list-item .actions{width:100%}
}
`;

function pageShell(title, body, extraHead = '') {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<style>${SHARED_CSS}</style>
${extraHead}
</head>
<body>
<div class="container">${body}</div>
</body>
</html>`;
}

// ==================== 页面构建函数 ====================

function buildPostListHtml() {
    const posts = getPostList();
    if (!posts.length) return '<div class="empty-state"><div class="icon">📝</div><p>暂无文章</p></div>';
    return posts.map(file => {
        const name = escapeHtml(file.replace('.txt', ''));
        return `<div class="list-item">
            <div class="info"><span class="title">${name}</span></div>
            <div class="actions">
                <a class="btn btn-secondary btn-sm" href="/fmc?action=edit&type=post&file=${encodeURIComponent(file)}">✏️ 编辑</a>
                <a class="btn btn-danger btn-sm" href="/fmc?action=delete&type=post&file=${encodeURIComponent(file)}" onclick="return confirm('确定删除「${name}」？')">🗑 删除</a>
            </div>
        </div>`;
    }).join('');
}

function buildSubListHtml() {
    const subs = getSubscriptions();
    if (!subs.length) return '<div class="empty-state"><div class="icon">📡</div><p>暂无订阅源，请在下方添加</p></div>';
    return subs.map((sub, idx) => {
        const intervalText = formatInterval(sub.interval);
        const badgeClass = sub.interval > 0 ? 'badge-green' : 'badge-yellow';
        return `<div class="list-item">
            <div class="info"><div class="title">${escapeHtml(sub.url)}</div><div class="sub"><span class="badge ${badgeClass}">${intervalText}</span></div></div>
            <div class="actions">
                <form method="POST" action="/fmc?action=setinterval&index=${idx}" class="inline-form" style="margin:0">
                    <input type="number" name="interval" min="0" value="${sub.interval}" placeholder="分钟" style="width:68px;padding:.35rem .5rem">
                    <button class="btn btn-secondary btn-sm" type="submit">⏱ 设间隔</button>
                </form>
                <a class="btn btn-primary btn-sm" href="/fmc?action=fetchsingle&index=${idx}">🔄 更新</a>
                <a class="btn btn-danger btn-sm" href="/fmc?action=deletesubscription&index=${idx}" onclick="return confirm('删除此订阅源？')">✕</a>
            </div>
        </div>`;
    }).join('');
}

function renderAdminDashboard() {
    const posts = getPostList(), subs = getSubscriptions();
    let nodeCount = 0;
    if (fs.existsSync(NODES_FILE)) {
        try { nodeCount = fs.readFileSync(NODES_FILE, 'utf8').split('\n').filter(l => l.trim()).length; } catch (e) {}
    }
    const hasIndex = fs.existsSync(INDEX_HTML);
    const body = `
<div class="header"><div><h1>⚙️ 管理后台</h1><div class="meta">节点订阅池 · 控制面板</div></div><a class="btn btn-secondary" href="/">← 返回首页</a></div>
<div class="grid-2">
    <div class="stat"><div class="num">${nodeCount}</div><div class="label">📦 代理节点总数</div></div>
    <div class="stat"><div class="num">${subs.length}</div><div class="label">📡 订阅源数量</div></div>
    <div class="stat"><div class="num">${posts.length}</div><div class="label">📝 文章数量</div></div>
    <div class="stat"><div class="num"><span class="badge ${hasIndex?'badge-green':'badge-yellow'}">${hasIndex?'已启用':'未启用'}</span></div><div class="label">🎭 伪装首页</div></div>
</div>
<div class="tabs">
    <button class="tab active" onclick="switchTab('tab-articles')">📝 文章管理</button>
    <button class="tab" onclick="switchTab('tab-disguise')">🎭 首页伪装</button>
    <button class="tab" onclick="switchTab('tab-nodes')">📦 代理节点</button>
    <button class="tab" onclick="switchTab('tab-subscriptions')">📡 订阅源池</button>
</div>
<div id="tab-articles" class="tab-content active">
    <div class="card"><div class="card-header"><h2>📝 文章管理</h2><a class="btn btn-primary btn-sm" href="/fmc?action=newpost">＋ 新建文章</a></div>${buildPostListHtml()}</div>
</div>
<div id="tab-disguise" class="tab-content">
    <div class="card"><div class="card-header"><h2>🎭 首页伪装</h2></div>
        <p style="margin-bottom:.75rem">当前状态：<span class="badge ${hasIndex?'badge-green':'badge-yellow'}">${hasIndex?'已启用伪装页':'未启用（显示文章列表）'}</span></p>
        <p class="tip" style="margin-bottom:1rem">伪装页存在时，访问首页将直接展示其内容，不会暴露节点池相关信息。</p>
        <a class="btn btn-primary" href="/fmc?action=edit&type=index">${hasIndex?'✏️ 编辑伪装页':'＋ 创建伪装页'}</a>
    </div>
</div>
<div id="tab-nodes" class="tab-content">
    <div class="card"><div class="card-header"><h2>📦 代理节点</h2><span class="badge badge-blue">${nodeCount} 条</span></div>
        <p class="tip" style="margin-bottom:1rem">每行一个节点链接，可通过 <code>/任意名称.uuidban</code> 获取 Base64 编码。</p>
        <a class="btn btn-primary" href="/fmc?action=edit&type=nodes">✏️ 手动编辑节点</a>
    </div>
</div>
<div id="tab-subscriptions" class="tab-content">
    <div class="card"><div class="card-header"><h2>📡 订阅源池（多源聚合）</h2><a class="btn btn-primary btn-sm" href="/fmc?action=fetchall">🔄 更新全部</a></div>${buildSubListHtml()}</div>
    <div class="card"><div class="card-header"><h3>＋ 添加订阅链接</h3></div>
        <form method="POST" action="/fmc?action=addsubscription" class="inline-form">
            <input type="url" name="url" placeholder="https://example.com/sub" required>
            <input type="number" name="interval" min="0" value="0" placeholder="间隔(分)">
            <button class="btn btn-primary" type="submit">添加</button>
        </form>
        <div class="alert alert-info" style="margin-top:.75rem">💡 设置间隔 ≥ 1 分钟后服务器将自动定时拉取并合并。<br>💡 更新全部会保留现有本地节点，去重合并所有订阅源节点到节点池。</div>
    </div>
</div>
<script>function switchTab(id){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));document.getElementById(id).classList.add('active');event.target.classList.add('active')}</script>`;
    return pageShell('管理后台', body);
}

function renderEditPage(type, file) {
    let titleHtml, content, formAction, textareaHeight = '300px', hint = '';
    if (type === 'post' && file) {
        const filePath = path.resolve(POSTS_DIR, file);
        if (!isPathSafe(filePath, POSTS_DIR)) return pageShell('错误', '<div class="empty-state"><p>🚫 文件路径不合法</p><a class="btn btn-secondary back-link" href="/fmc">← 返回管理</a></div>');
        if (!fs.existsSync(filePath)) return pageShell('错误', '<div class="empty-state"><p>📄 文件不存在</p><a class="btn btn-secondary back-link" href="/fmc">← 返回管理</a></div>');
        titleHtml = '编辑文章：' + escapeHtml(file.replace('.txt', ''));
        formAction = `/fmc?action=save&type=post&file=${encodeURIComponent(file)}`;
        content = fs.readFileSync(filePath, 'utf8');
    } else if (type === 'nodes') {
        titleHtml = '编辑代理节点';
        formAction = '/fmc?action=save&type=nodes';
        content = fs.existsSync(NODES_FILE) ? fs.readFileSync(NODES_FILE, 'utf8') : '';
        hint = '<p class="tip" style="margin-top:.5rem">每行一个节点链接。</p>';
    } else if (type === 'index') {
        titleHtml = '编辑首页伪装';
        formAction = '/fmc?action=save&type=index';
        textareaHeight = '450px';
        content = fs.existsSync(INDEX_HTML) ? fs.readFileSync(INDEX_HTML, 'utf8') :
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>欢迎</title></head><body style="text-align:center;margin-top:15%;font-family:sans-serif"><h1>🚧 网站正在建设中</h1><p>敬请期待...</p></body></html>';
        hint = '<p class="tip" style="margin-top:.5rem">保存后访问首页将直接展示此 HTML，用于对外隐藏节点池服务。</p>';
    } else {
        return pageShell('参数错误', '<div class="empty-state"><p>⚠️ 缺少必要参数</p><a class="btn btn-secondary back-link" href="/fmc">← 返回管理</a></div>');
    }
    const body = `
<div class="header"><h1>${escapeHtml(titleHtml)}</h1><a class="btn btn-secondary" href="/fmc">← 返回管理</a></div>
<div class="card">
    <form method="POST" action="${formAction}">
        <textarea name="content" style="height:${textareaHeight}">${escapeHtml(content)}</textarea>
        ${hint}
        <div style="margin-top:1rem;display:flex;gap:.5rem">
            <button class="btn btn-primary btn-lg" type="submit">💾 保存</button>
            <a class="btn btn-secondary btn-lg" href="/fmc">取消</a>
        </div>
    </form>
</div>`;
    return pageShell(titleHtml, body);
}

function renderNewPostPage() {
    const body = `
<div class="header"><h1>📝 新建文章</h1><a class="btn btn-secondary" href="/fmc">← 返回管理</a></div>
<div class="card">
    <form method="POST" action="/fmc?action=createpost">
        <label style="display:block;margin-bottom:.35rem;color:#f0f6fc">文件名（不含 .txt）</label>
        <input name="filename" placeholder="my-article" style="margin-bottom:1rem">
        <label style="display:block;margin-bottom:.35rem;color:#f0f6fc">文章内容</label>
        <textarea name="content" placeholder="开始写作..."></textarea>
        <div style="margin-top:1rem;display:flex;gap:.5rem">
            <button class="btn btn-primary btn-lg" type="submit">✅ 创建</button>
            <a class="btn btn-secondary btn-lg" href="/fmc">取消</a>
        </div>
    </form>
</div>`;
    return pageShell('新建文章', body);
}

function renderBlogHome() {
    if (fs.existsSync(INDEX_HTML)) return fs.readFileSync(INDEX_HTML, 'utf8');
    const posts = getPostList();
    let listHtml = !posts.length
        ? '<div class="empty-state"><div class="icon">📝</div><p>暂无文章</p></div>'
        : '<div class="card"><ul style="list-style:none;padding:0">' +
          posts.map(f => `<li class="list-item"><div class="info"><span class="title">${escapeHtml(f.replace('.txt',''))}</span></div><a class="btn btn-secondary btn-sm" href="/post?name=${encodeURIComponent(f)}">阅读 →</a></li>`).join('') +
          '</ul></div>';
    return pageShell('我的博客', `<div class="header"><h1>📖 我的博客</h1></div>${listHtml}`);
}

function renderPostPage(fileName) {
    const filePath = path.resolve(POSTS_DIR, fileName);
    if (!isPathSafe(filePath, POSTS_DIR) || !fs.existsSync(filePath)) {
        return pageShell('文章未找到', '<div class="empty-state"><div class="icon">📄</div><p>文章不存在</p><a class="btn btn-secondary back-link" href="/">← 返回首页</a></div>');
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return pageShell(fileName.replace('.txt', ''), `<div class="header"><h1>${escapeHtml(fileName.replace('.txt',''))}</h1></div><div class="card"><pre>${escapeHtml(content)}</pre></div><a class="btn btn-secondary back-link" href="/">← 返回首页</a>`);
}

function render404() {
    return pageShell('404 - 页面不存在', '<div class="empty-state"><div class="icon">🔍</div><h2>404</h2><p>页面不存在</p><a class="btn btn-secondary back-link" href="/">← 返回首页</a></div>');
}

// ==================== 路由白名单 ====================

function isValidRoute(pathname) {
    if (pathname === '/' || pathname === '') return true;
    if (pathname === '/fmc' || pathname === '/post') return true;
    if (pathname.endsWith('.uuidban') && pathname.length > '.uuidban'.length) return true;
    return false;
}

// ==================== 请求处理 ====================

function handleRequest(req, res) {
    // 方法限制
    if (!ALLOWED_METHODS.includes(req.method)) return sendText(res, 405, 'Method Not Allowed');

    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;

    // 路由白名单
    if (!isValidRoute(pathname)) return sendHtml(res, 404, render404());

    // 1. 订阅分发 (.uuidban)
    if (pathname.endsWith('.uuidban')) {
        fs.readFile(NODES_FILE, 'utf8', (err, data) => {
            if (err) return sendText(res, 404, 'Not found');
            sendText(res, 200, Buffer.from(data, 'utf8').toString('base64'));
        });
        return;
    }

    // 2. 首页
    if (pathname === '/' || pathname === '') {
        const html = renderBlogHome();
        setSecurityHeaders(res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
    }

    // 3. 文章阅读
    if (pathname === '/post') {
        const fileName = (query.name || '').trim();
        if (!fileName || !fileName.endsWith('.txt') || fileName.includes('/') || fileName.includes('..') || fileName.includes('\\'))
            return sendHtml(res, 404, render404());
        return sendHtml(res, 200, renderPostPage(fileName));
    }

    // 4. 管理后台 /fmc
    if (pathname === '/fmc') {
        const action = query.action;

        // 仪表盘
        if (!action) return sendHtml(res, 200, renderAdminDashboard());

        // 编辑页
        if (action === 'edit') return sendHtml(res, 200, renderEditPage(query.type, query.file));

        // 新建文章表单
        if (action === 'newpost') return sendHtml(res, 200, renderNewPostPage());

        // 保存 (POST)
        if (action === 'save' && req.method === 'POST') {
            readBody(req, (err, body) => {
                if (err) { setSecurityHeaders(res); res.writeHead(413); return res.end('Payload Too Large'); }
                const params = new URLSearchParams(body);
                const content = params.get('content') || '';
                if (query.type === 'post' && query.file) {
                    const fp = path.resolve(POSTS_DIR, query.file);
                    if (!isPathSafe(fp, POSTS_DIR)) { setSecurityHeaders(res); res.writeHead(403); return res.end('Forbidden'); }
                    return safeWrite(fp, content, res);
                }
                if (query.type === 'nodes') return safeWrite(NODES_FILE, content, res);
                if (query.type === 'index') return safeWrite(INDEX_HTML, content, res);
                setSecurityHeaders(res); res.writeHead(400); res.end('Bad request');
            });
            return;
        }

        // 创建文章 (POST)
        if (action === 'createpost' && req.method === 'POST') {
            readBody(req, (err, body) => {
                if (err) { setSecurityHeaders(res); res.writeHead(413); return res.end('Payload Too Large'); }
                const params = new URLSearchParams(body);
                let fn = (params.get('filename') || 'untitled').replace(/[^a-zA-Z0-9_\-.\u4e00-\u9fff]/g, '');
                if (!fn) fn = 'untitled';
                if (!fn.endsWith('.txt')) fn += '.txt';
                const fp = path.resolve(POSTS_DIR, fn);
                if (!isPathSafe(fp, POSTS_DIR)) { setSecurityHeaders(res); res.writeHead(403); return res.end('Forbidden'); }
                safeWrite(fp, params.get('content') || '', res);
            });
            return;
        }

        // 删除文章
        if (action === 'delete' && query.type === 'post' && query.file) {
            const fp = path.resolve(POSTS_DIR, query.file);
            if (!isPathSafe(fp, POSTS_DIR)) { setSecurityHeaders(res); res.writeHead(403); return res.end('Forbidden'); }
            fs.unlink(fp, err => {
                if (err) { setSecurityHeaders(res); res.writeHead(500); return res.end('删除失败'); }
                redirect(res, '/fmc');
            });
            return;
        }

        // 添加订阅源
        if (action === 'addsubscription' && req.method === 'POST') {
            readBody(req, (err, body) => {
                if (err) { setSecurityHeaders(res); res.writeHead(413); return res.end('Payload Too Large'); }
                const params = new URLSearchParams(body);
                const subUrl = (params.get('url') || '').trim();
                let interval = parseInt(params.get('interval'));
                if (isNaN(interval) || interval < 0) interval = 0;
                if (!subUrl) return sendHtml(res, 400, pageShell('错误', '<div class="empty-state"><p>⚠️ 请输入有效的 URL</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                if (!isValidSubscriptionUrl(subUrl)) return sendHtml(res, 400, pageShell('URL 不合法', '<div class="empty-state"><p>🚫 仅允许 http/https 公网地址</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                const subs = getSubscriptions();
                if (subs.some(s => s.url === subUrl)) return sendHtml(res, 400, pageShell('重复', '<div class="empty-state"><p>⚠️ 该订阅源已存在</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                subs.push({ url: subUrl, interval });
                saveSubscriptions(subs);
                redirect(res, '/fmc');
            });
            return;
        }

        // 删除订阅源
        if (action === 'deletesubscription') {
            const idx = parseInt(query.index);
            const subs = getSubscriptions();
            if (isNaN(idx) || idx < 0 || idx >= subs.length) return sendHtml(res, 400, pageShell('错误', '<div class="empty-state"><p>⚠️ 索引无效</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
            subs.splice(idx, 1);
            saveSubscriptions(subs);
            redirect(res, '/fmc');
            return;
        }

        // 设置间隔
        if (action === 'setinterval' && req.method === 'POST') {
            readBody(req, (err, body) => {
                if (err) { setSecurityHeaders(res); res.writeHead(413); return res.end('Payload Too Large'); }
                const params = new URLSearchParams(body);
                let interval = parseInt(params.get('interval'));
                if (isNaN(interval) || interval < 0) interval = 0;
                const idx = parseInt(query.index);
                const subs = getSubscriptions();
                if (idx >= 0 && idx < subs.length) { subs[idx].interval = interval; saveSubscriptions(subs); }
                redirect(res, '/fmc');
            });
            return;
        }

        // 更新单个订阅源
        if (action === 'fetchsingle') {
            const idx = parseInt(query.index);
            const subs = getSubscriptions();
            if (isNaN(idx) || idx < 0 || idx >= subs.length) return sendHtml(res, 400, pageShell('错误', '<div class="empty-state"><p>⚠️ 索引无效</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
            const extUrl = subs[idx].url;
            fetchExternalSubscription(extUrl, (err, newLines) => {
                if (err) return sendHtml(res, 500, pageShell('抓取失败', `<div class="empty-state"><p>❌ ${escapeHtml(err.message)}</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>`));
                let existing = [];
                if (fs.existsSync(NODES_FILE)) {
                    try { existing = fs.readFileSync(NODES_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0); } catch (e) {}
                }
                const mergedSet = new Set(existing);
                newLines.forEach(l => mergedSet.add(l));
                const all = Array.from(mergedSet);
                fs.writeFile(NODES_FILE, all.join('\n') + '\n', 'utf8', err => {
                    if (err) return sendHtml(res, 500, pageShell('保存失败', '<div class="empty-state"><p>❌ 写入节点文件失败</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                    lastFetchTimes[extUrl] = Date.now();
                    sendHtml(res, 200, pageShell('更新成功', `<div class="card"><div class="empty-state"><div class="icon" style="font-size:3rem">✅</div><h2>更新完成</h2><p>新增 <strong>${newLines.length}</strong> 个节点，当前共 <strong>${all.length}</strong> 个</p></div></div><a class="btn btn-primary back-link" href="/fmc">← 返回管理</a>`));
                });
            });
            return;
        }

        // 更新全部订阅源
        if (action === 'fetchall') {
            const subs = getSubscriptions();
            if (!subs.length) return sendHtml(res, 400, pageShell('无订阅源', '<div class="empty-state"><div class="icon">📡</div><p>请先添加订阅链接</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
            let existing = [];
            if (fs.existsSync(NODES_FILE)) {
                try { existing = fs.readFileSync(NODES_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0); } catch (e) {}
            }
            const mergedSet = new Set(existing);
            let completed = 0, failed = 0;
            const processNext = (i) => {
                if (i >= subs.length) {
                    const lines = Array.from(mergedSet);
                    fs.writeFile(NODES_FILE, lines.join('\n') + '\n', 'utf8', err => {
                        if (err) return sendHtml(res, 500, pageShell('保存失败', '<div class="empty-state"><p>❌ 写入节点文件失败</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                        sendHtml(res, 200, pageShell('全部更新完成', `<div class="card"><div class="empty-state"><div class="icon" style="font-size:3rem">✅</div><h2>全部更新完成</h2><p>成功 <strong>${completed - failed}/${completed}</strong> 个源，节点池共 <strong>${lines.length}</strong> 个</p></div></div><a class="btn btn-primary back-link" href="/fmc">← 返回管理</a>`));
                    });
                    return;
                }
                fetchExternalSubscription(subs[i].url, (err, newLines) => {
                    completed++;
                    if (err) { failed++; }
                    else { newLines.forEach(l => mergedSet.add(l)); lastFetchTimes[subs[i].url] = Date.now(); }
                    processNext(i + 1);
                });
            };
            processNext(0);
            return;
        }

        // 旧版 fetch (POST)
        if (action === 'fetch' && req.method === 'POST') {
            readBody(req, (err, body) => {
                if (err) { setSecurityHeaders(res); res.writeHead(413); return res.end('Payload Too Large'); }
                const params = new URLSearchParams(body);
                const extUrl = params.get('url');
                const merge = params.get('merge') === '1';
                if (!extUrl) return sendHtml(res, 400, pageShell('错误', '<div class="empty-state"><p>⚠️ 请输入 URL</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                if (!isValidSubscriptionUrl(extUrl)) return sendHtml(res, 400, pageShell('URL 不合法', '<div class="empty-state"><p>🚫 仅允许 http/https 公网地址</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                fetchExternalSubscription(extUrl, (err, newLines) => {
                    if (err) return sendHtml(res, 500, pageShell('抓取失败', `<div class="empty-state"><p>❌ ${escapeHtml(err.message)}</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>`));
                    let finalLines;
                    if (merge) {
                        let ex = [];
                        if (fs.existsSync(NODES_FILE)) { try { ex = fs.readFileSync(NODES_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0); } catch (e) {} }
                        finalLines = [...new Set([...ex, ...newLines])];
                    } else { finalLines = newLines; }
                    fs.writeFile(NODES_FILE, finalLines.join('\n') + '\n', 'utf8', err => {
                        if (err) return sendHtml(res, 500, pageShell('保存失败', '<div class="empty-state"><p>❌ 写入出错</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
                        lastFetchTimes[extUrl] = Date.now();
                        sendHtml(res, 200, pageShell('导入成功', `<div class="card"><div class="empty-state"><div class="icon" style="font-size:3rem">✅</div><h2>导入成功</h2><p>${merge?'已合并':'已覆盖'} <strong>${finalLines.length}</strong> 个节点</p></div></div><a class="btn btn-primary back-link" href="/fmc">← 返回管理</a>`));
                    });
                });
            });
            return;
        }

        // 未知操作
        return sendHtml(res, 400, pageShell('未知操作', '<div class="empty-state"><p>⚠️ 管理操作无效</p><a class="btn btn-secondary back-link" href="/fmc">← 返回</a></div>'));
    }

    // 兜底 404
    sendHtml(res, 404, render404());
}

// ==================== 启动服务 ====================

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`[Server] running at http://localhost:${PORT}`);
    console.log(`[Server] data dir: ${DATA_DIR}`);
    console.log(`[Server] routes: / | /post | /fmc | *.uuidban`);
    scheduleAutoFetch();
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });