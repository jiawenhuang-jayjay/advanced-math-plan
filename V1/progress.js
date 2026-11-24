const emptyProgress = () => ({ weeks: {}, logs: {}, bufferUsed: 0, starred: {}, chMode: "all", chOverrides: {} });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Merge each dated log, checkmark and chapter separately, including deletions.
function mergeProgress(base, local, remote, resolve) {
  function pick(key, before, here, there) {
    if (same(here, before)) return there;
    if (same(there, before) || same(here, there)) return here;
    return resolve(key, here, there);
  }
  const result = emptyProgress();
  for (const group of ["logs", "weeks", "starred", "chOverrides"]) {
    const keys = new Set([...Object.keys(local[group]), ...Object.keys(remote[group])]);
    result[group] = Object.fromEntries([...keys].flatMap(key => {
      const value = pick(key, base[group][key], local[group][key], remote[group][key]);
      return value === undefined ? [] : [[key, value]];
    }));
  }
  result.chMode = pick("章节显示方式", base.chMode, local.chMode, remote.chMode);
  const shieldCost = logs => Object.values(logs).filter(log => log.shield).length * 3;
  // Older backups can include spending for shield days that were later overwritten.
  const extraSpent = s => s.bufferUsed - shieldCost(s.logs);
  result.bufferUsed = Math.max(0, shieldCost(result.logs) +
    pick("历史保签支出", extraSpent(base), extraSpent(local), extraSpent(remote)));
  return result;
}

function chooseProgressVersion(key, here, there, source) {
  const describe = value => value == null ? "已删除" : JSON.stringify(value);
  const choice = prompt(`${key} 的记录有冲突。输入 1 保留本机，2 保留${source}，或取消。\n本机：${describe(here)}\n${source}：${describe(there)}`);
  if (choice === "1") return here;
  if (choice === "2") return there;
  throw new DOMException("记录冲突，点击选择", "AbortError");
}

const syncButton = () => document.getElementById("sync-button");
let syncing = false;
function persistProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, pairing }));
  } catch {
    alert("本机存储写入失败，请先导出 JSON 备份。");
  }
}

function manageSync() {
  if (syncing) return;
  if (!window.isSecureContext || !/^https?:$/.test(location.protocol)) {
    return alert("请用部署后的 HTTPS 网址打开，再连接设备。");
  }
  const key = prompt("两端使用同一个同步码。首台设备确认下方生成的码，另一台粘贴该码。持码者可读写进度，请只在自己的设备间传递。", pairing?.key || crypto.randomUUID());
  if (!key) return;
  const cleaned = key.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cleaned)) {
    return alert("同步码格式无效，请复制完整的同步码。");
  }
  if (cleaned !== pairing?.key) {
    if (pairing && !confirm("切换同步码会把本机进度合并到新同步空间，继续吗？")) return;
    pairing = { key: cleaned, base: emptyProgress() };
    persistProgress();
  }
  syncProgress(true);
}

async function syncProgress(manual = false) {
  if (!pairing || syncing) return;
  syncing = true;
  const session = pairing;
  const headers = { Authorization: "Bearer " + session.key };
  const endpoint = "/api/progress";
  const status = message => { syncButton().textContent = message; };
  status("正在同步…");
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(endpoint, { headers, cache: "no-store" });
      if (!response.ok) throw new Error("云端暂不可用");
      if (!response.headers.get("Content-Type")?.includes("application/json")) {
        throw new Error("当前网址未提供同步接口，请从正式站点打开");
      }
      const cloud = await response.json();
      if (!Number.isInteger(cloud.revision)) throw new Error("云端接口尚未就绪");
      if (pairing !== session) return;
      const local = JSON.parse(JSON.stringify(state));
      const remote = cloud.state || emptyProgress();
      const merged = mergeProgress(session.base, local, remote, (key, here, there) => {
        if (!manual) throw new Error("记录冲突，点击选择");
        return chooseProgressVersion(key, here, there, "云端");
      });
      if (!same(merged, remote)) {
        const put = await fetch(endpoint, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ revision: cloud.revision, state: merged })
        });
        if (put.status === 409) continue;
        if (!put.ok) throw new Error(put.status === 400 ? "记录格式有误" : put.status === 413 ? "进度超出容量" : "上传失败");
        if (!put.headers.get("Content-Type")?.includes("application/json") ||
            (await put.json())?.revision !== cloud.revision + 1) {
          throw new Error("云端未确认写入，进度待同步");
        }
      }
      if (pairing !== session) return;
      const next = mergeProgress(local, state, merged, (_, here) => here);
      const changed = !same(state, next);
      if (changed || !same(session.base, merged)) {
        session.base = merged;
        state = next;
        persistProgress();
        if (changed) { renderAll(); renderQBank(false); }
      }
      if (!same(next, merged)) continue;
      status("已同步 · 查看同步码");
      return;
    }
    status("等待重试同步");
  } catch (error) {
    status(error instanceof TypeError || error instanceof SyntaxError ? "待同步 · 点击重试" : error.message);
  } finally {
    syncing = false;
  }
}
