// Fish 音色库页面：所有数据都通过插件后端接口读写（bridge 会带上 Dashboard 的登录身份）。
// 注意：页面跑在沙箱 iframe 里，没有 allow-modals，不能用 alert / confirm，提示和确认都在页面里自己做。
const bridge = window.AstrBotPluginPage;
const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"), banners: $("banners"), list: $("list"), count: $("count"),
  testText: $("test-text"), player: $("player"), testInfo: $("test-info"),
  testCurrent: $("btn-test-current"), makeDefault: $("btn-default"),
  formCard: $("form-card"), formTitle: $("form-title"),
  name: $("f-name"), id: $("f-id"), note: $("f-note"),
  save: $("btn-save"), testForm: $("btn-test-form"), cancel: $("btn-cancel"),
  toast: $("toast"),
};

let state = { voices: [], active: "", default_id: "", backend: "fish", has_key: true, max_voices: 50, test_max_chars: 200 };
let editing = null; // 正在编辑的音色名称；null = 添加新音色
let busy = false; // 有请求在进行时，按钮先不响应
let confirming = null; // 点过一次「删除」、等待再点一次确认的音色名称
let confirmTimer = 0;
let toastTimer = 0;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = isError ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = ""; }, 3200);
}

async function run(task) {
  if (busy) return undefined;
  busy = true;
  document.body.classList.add("busy");
  try {
    return await task();
  } catch (error) {
    toast(error?.message || String(error), true);
    return undefined;
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}

function apply(next) {
  state = next;
  render();
}

// 改动类接口：后端返回 {message, ...最新状态}
async function mutate(endpoint, body = {}) {
  const result = await bridge.apiPost(endpoint, body);
  apply(result);
  toast(result.message);
}

function render() {
  const { voices, active, default_id: defaultId, backend, has_key: hasKey } = state;
  els.count.textContent = `${voices.length} / ${state.max_voices}`;
  els.status.textContent = active
    ? `当前在用：${active}`
    : `当前在用：${defaultId ? "设置页里的默认音色" : "Fish 默认音色"}`;

  const warnings = [];
  if (backend !== "fish") warnings.push("语音合成方式不是 fish，音色库暂时不生效（到插件设置里改成 fish）。");
  if (!hasKey) warnings.push("还没有填写 Fish API Key，无法试听，也无法合成语音（插件设置 → Fish 语音合成）。");
  els.banners.replaceChildren(...warnings.map((text) => el("div", { class: "banner", text })));

  els.list.replaceChildren(...voices.map(renderVoice));
  if (!voices.length) {
    els.list.append(el("p", { class: "empty muted", text: "还没有保存音色，在下面填写名称和音色 ID 添加一个。" }));
  }
}

function renderVoice(voice) {
  const confirmNow = confirming === voice.name;
  const head = el("div", { class: "voice-head" }, el("strong", { text: voice.name }));
  if (voice.active) head.append(el("span", { class: "badge", text: "使用中" }));

  const buttons = el("div", { class: "row" }, el("button", { text: "试听", onclick: () => testVoice({ name: voice.name }) }));
  if (!voice.active) buttons.append(el("button", { class: "primary", text: "使用", onclick: () => useVoice(voice.name) }));
  buttons.append(
    el("button", { text: "编辑", onclick: () => startEdit(voice) }),
    el("button", { class: confirmNow ? "danger" : "", text: confirmNow ? "再点一次删除" : "删除", onclick: () => removeVoice(voice.name) }),
  );

  const card = el("article", { class: voice.active ? "voice active" : "voice" }, head);
  if (voice.note) card.append(el("p", { class: "note", text: voice.note }));
  card.append(el("code", { class: "vid", text: voice.id }), buttons);
  return card;
}

// ---------- 表单 ----------
function resetForm() {
  editing = null;
  els.name.value = els.id.value = els.note.value = "";
  els.name.disabled = false;
  els.formTitle.textContent = "添加音色";
  els.save.textContent = "保存";
  els.cancel.hidden = true;
}

function startEdit(voice) {
  editing = voice.name;
  els.name.value = voice.name;
  els.name.disabled = true; // 改名请删掉重建
  els.id.value = voice.id;
  els.note.value = voice.note;
  els.formTitle.textContent = `编辑「${voice.name}」`;
  els.save.textContent = "保存修改";
  els.cancel.hidden = false;
  els.formCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

const saveVoice = () => run(async () => {
  await mutate("voices/save", { name: els.name.value, id: els.id.value, note: els.note.value });
  resetForm();
});

// ---------- 列表上的操作 ----------
const useVoice = (name) => run(() => mutate("voices/use", { name }));

function removeVoice(name) {
  if (confirming !== name) { // 第一次点：先变成「再点一次删除」，3 秒内没再点就恢复
    confirming = name;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { confirming = null; render(); }, 3000);
    render();
    return;
  }
  clearTimeout(confirmTimer);
  confirming = null;
  run(async () => {
    await mutate("voices/remove", { name });
    if (editing === name) resetForm();
  });
}

// ---------- 试听 ----------
// target: {name} 试音色库里的音色；{id} 试还没保存的 ID；{} 试当前在用的音色
const testVoice = (target) => run(async () => {
  els.testInfo.textContent = "合成中…";
  try {
    const result = await bridge.apiPost("voices/test", { ...target, text: els.testText.value });
    els.player.src = `data:${result.mime};base64,${result.audio}`;
    els.player.hidden = false;
    els.testInfo.textContent = `试听：${result.voice} · 用时 ${result.seconds} 秒`;
    try {
      await els.player.play();
    } catch {
      els.testInfo.textContent += "（浏览器没有自动播放，点上面的播放键收听）";
    }
  } catch (error) {
    els.testInfo.textContent = "";
    throw error;
  }
});

els.save.addEventListener("click", saveVoice);
els.cancel.addEventListener("click", resetForm);
els.testCurrent.addEventListener("click", () => testVoice({}));
els.makeDefault.addEventListener("click", () => run(() => mutate("voices/default")));
els.testForm.addEventListener("click", () => {
  if (!els.id.value.trim()) toast("先填写音色 ID", true);
  else testVoice({ id: els.id.value });
});

await bridge.ready();
await run(async () => {
  apply(await bridge.apiGet("voices"));
  els.testText.maxLength = state.test_max_chars;
});
